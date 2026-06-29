#!/usr/bin/env node
/**
 * Redact credential values from text files before they reach git history.
 *
 * Used by `scripts/sync-memory.js` (and usable as a pre-commit / CI check) so
 * workspace memory docs — especially `audit-findings.md` and
 * `platform.md § Known Constraints`, which quote real secrets found in code —
 * never publish the literal secret value. The finding keeps its `file:line` +
 * description (enough to locate and rotate the real secret in the code repo);
 * only the value is replaced with `[REDACTED-<kind>]`.
 *
 * Design choices (see docs/design/github-memory.md):
 *   - Favor NO false negatives on real credential shapes over catching every
 *     high-entropy string. We deliberately do NOT redact bare hex blobs
 *     (git SHAs, file hashes), 12-digit AWS account IDs, or ${ENV_VAR}
 *     references — redacting those would corrupt ADRs / diffs / findings and
 *     they aren't credentials. The private-repo default is the backstop.
 *   - Idempotent: a `[REDACTED-...]` marker never re-matches.
 *   - In place: local copy == committed copy (no working-tree drift).
 *
 * Usage:
 *   node redact-secrets.js <file-or-dir> [--check] [--quiet]
 *     --check  report matches and exit 1 if any found; do NOT modify files.
 *     --quiet  suppress the per-file summary (still prints the total).
 *
 * Exit codes:
 *   0 — done (no secrets found, or redaction applied)
 *   1 — --check mode and at least one secret was found
 *   2 — usage / path error
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const CHECK = args.includes('--check');
const QUIET = args.includes('--quiet');

if (!target) {
  console.error('Usage: redact-secrets.js <file-or-dir> [--check] [--quiet]');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`Path not found: ${target}`);
  process.exit(2);
}

// Only scan text formats that can carry prose/config secrets.
const TEXT_EXT = new Set(['.md', '.json', '.jsonc', '.yaml', '.yml', '.txt', '.mmd', '.properties', '.env', '.cfg', '.ini', '.toml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'runs']);

// Is a standalone token credential-shaped? Used by the catch-all rule.
// Redact when it looks like a generated secret; SPARE git SHAs, UUIDs, hex
// IDs, account IDs, and config key-paths so we don't corrupt docs/diffs.
function isCredentialish(tok) {
  if (tok.length < 20) return false;            // too short to be a generated secret
  if (!/[A-Za-z]/.test(tok)) return false;      // pure digits (account IDs, ports) — spare
  if (!/[0-9]/.test(tok)) return false;         // pure words / identifiers — spare
  if (/^[0-9a-f]+$/.test(tok)) return false;    // lowercase hex: git SHAs, md5/sha — spare
  const mixedCase = /[a-z]/.test(tok) && /[A-Z]/.test(tok);
  const base64ish = /[+/=]/.test(tok);
  // Real generated secrets are high-entropy: mixed case, base64 padding, or long.
  // A single-case word-with-a-digit under 32 chars is almost always an identifier.
  return mixedCase || base64ish || tok.length >= 32;
}

// Redaction rules. Each: { kind, re, replace(match, ...groups) }.
// `replace` returns the full replacement string for the matched slice.
// Specific rules run first; the standalone catch-all (rule 6) runs LAST so
// key=value and known-format secrets are handled by their precise rule and the
// already-substituted [REDACTED-*] markers (which carry no digits) are spared.
const RULES = [
  // 1. PEM private keys (any kind) — whole block.
  {
    kind: 'private-key',
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    replace: () => '[REDACTED-PRIVATE-KEY]',
  },
  // 2. GitHub tokens (PAT / OAuth / user / server / refresh).
  {
    kind: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replace: () => '[REDACTED-GITHUB-TOKEN]',
  },
  // 3. AWS access key id.
  {
    kind: 'aws-access-key-id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED-AWS-ACCESS-KEY-ID]',
  },
  // 4. Slack tokens.
  {
    kind: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => '[REDACTED-SLACK-TOKEN]',
  },
  // 5. key = value  where the key name signals a credential and the value is a
  //    long literal (>=12 chars of token-ish characters). Keeps the key + the
  //    assignment punctuation, redacts only the value. Does NOT match
  //    ${ENV_VAR} / {{PLACEHOLDER}} (those chars aren't in the value class), so
  //    env-var references survive untouched.
  {
    kind: 'secret',
    re: /\b(api[-_ ]?key|secret|secret[-_ ]?key|client[-_ ]?secret|password|passwd|pwd|token|access[-_ ]?token|auth[-_ ]?token|private[-_ ]?key|connection[-_ ]?string)\b(\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9_./+=~-]{12,})/gi,
    replace: (_m, key, sep, _val) => `${key}${sep}[REDACTED-secret]`,
  },
  // 6. Standalone credential-shaped token (no key= context). Catches secrets
  //    quoted in prose (e.g. a password in backticks). isCredentialish() spares
  //    git SHAs, UUIDs, account IDs, and config key-paths.
  {
    kind: 'token',
    // Charset deliberately EXCLUDES path separators (. / -) so dotted/slashed/
    // hyphenated code identifiers and paths split into short harmless segments.
    // NOTE: '/' MUST stay out of this class — including it makes long slash-paths
    // (e.g. /v1/publishers/publishers/user/) and slash-joined enum lists
    // (PASSED_LEVEL_1/2/3) match, and isCredentialish()'s base64ish test then
    // flags the lone '/' as a secret. Keep underscore + base64 padding chars
    // (+ = ~) only; real base64 secrets also carry mixed case / length and are
    // caught by isCredentialish without needing '/'.
    re: /(?<![A-Za-z0-9_+=~])([A-Za-z0-9_+=~]{20,})(?![A-Za-z0-9_+=~])/g,
    replace: (full, tok) => (isCredentialish(tok) ? '[REDACTED-token]' : full),
  },
];

let totalHits = 0;
const perFile = [];

function processFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return; }

  let hits = 0;
  let out = content;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m) => {
      const orig = m[0];
      const rep = rule.replace(...m);
      if (rep !== orig) hits++;   // count only real redactions (rule 6's regex matches many benign tokens it returns unchanged)
      return rep;
    });
  }
  if (hits > 0) {
    totalHits += hits;
    perFile.push({ file, hits });
    if (!CHECK) fs.writeFileSync(file, out);
  }
}

function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(p))) return;
    for (const ent of fs.readdirSync(p)) walk(path.join(p, ent));
  } else {
    processFile(p);
  }
}

walk(target);

if (!QUIET) {
  for (const { file, hits } of perFile) {
    console.error(`${CHECK ? 'FOUND' : 'redacted'} ${hits} in ${file}`);
  }
}

if (CHECK) {
  if (totalHits > 0) {
    console.error(`redact-secrets: ${totalHits} secret value(s) found across ${perFile.length} file(s) — refusing (run without --check to redact)`);
    process.exit(1);
  }
  console.log('redact-secrets: clean (no secret values found)');
  process.exit(0);
}

console.log(`redact-secrets: redacted ${totalHits} secret value(s) across ${perFile.length} file(s)`);
process.exit(0);
