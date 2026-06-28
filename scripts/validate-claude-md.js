#!/usr/bin/env node
/**
 * CLAUDE.md validator — enforces the 10 guardrails from GENERALIZE-PLAN Section 13.
 *
 * Usage:  node validate-claude-md.js <claude-md-path>
 * Exit 0 = clean, 1 = hard-fail, 2 = warning only.
 *
 * Zero dependencies — pure Node stdlib. Designed to be called from
 * discover phase-c-generation.md after context-manager writes the file,
 * and from /discover --resume to detect hand-edits that broke the rules.
 */

const fs = require('fs');
const path = require('path');

// Each mandatory bullet accepts EITHER the legacy wording (from
// templates/repo-CLAUDE.md.template) OR the new wording (from the
// role-specific templates/repo-CLAUDE-{backend,frontend}.md.template).
// Union-style — if either pattern matches, the bullet is considered present.
const MANDATORY_BULLETS = [
  // Bullet 1: read AGENT_INDEX before planning a change.
  [
    // Legacy phrasing
    /Before planning any change, read `[^`]+AGENT_INDEX\.md` — it maps tasks to the relevant feature, service, and convention files\./,
    // New phrasing (role-specific templates)
    /Read `[^`]*AGENT_INDEX\.md` — it maps tasks to docs\./,
  ],
  // Bullet 2: update agent-context after relevant changes.
  [
    // Legacy phrasing
    /When you add, change, or restructure a feature, integration, or module, update the matching file under `[^`]+` in the same change\./,
    // New phrasing (role-specific templates)
    /Update `[^`]*agent-context\/?` ONLY when you added something new to the world/,
  ],
];

const COUPLING_PATTERNS = [
  { pattern: /~\/\.claude\/(?:pipecrew\/)?workspaces\//, label: 'workspace path reference' },
  { pattern: /\bplatform\.md\b/, label: '"platform.md" reference' },
  { pattern: /\baudit-findings\b/, label: '"audit-findings" reference' },
  { pattern: /\bworkspace baseline\b/i, label: '"workspace baseline" phrase' },
  { pattern: /\bdivergence[s]?\b/i, label: '"divergence(s)" phrase' },
];

const ABSOLUTE_PATH_PATTERNS = [
  { pattern: /[A-Z]:\//, label: 'Windows absolute path (C:/...)' },
  { pattern: /\s\/Users\//, label: 'macOS absolute path (/Users/...)' },
  { pattern: /\s\/home\//, label: 'Linux absolute path (/home/...)' },
];

const SECRET_PATTERNS = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: 'Anthropic/OpenAI-style API key (sk-)' },
  { pattern: /\bghp_[A-Za-z0-9]{36}\b/, label: 'GitHub personal access token (ghp_)' },
  { pattern: /\bgho_[A-Za-z0-9]{36}\b/, label: 'GitHub OAuth token (gho_)' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/, label: 'GitHub fine-grained PAT' },
  // AWS 12-digit account IDs only flagged when adjacent to account-like context to reduce false positives
  { pattern: /\b(?:account[- ]?id|aws[- ]?account)[^\d]{0,20}\d{12}\b/i, label: 'AWS account ID near "account-id" / "aws-account"' },
  // Private-looking emails — warn-level. Skip obvious example domains.
  { pattern: /\b[A-Za-z0-9._%+-]+@(?!example\.com|noreply\.|anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, label: 'email address' },
];

/**
 * Run all 10 guardrails against the given CLAUDE.md body + its repo root.
 * Returns { errors, warnings }.
 */
function validate(body, repoRoot) {
  const errors = [];
  const warnings = [];
  const lines = body.split(/\r?\n/);

  // Claude-only mode: the repo has NO agent-context/ dir and NO AGENT_INDEX.md
  // (sentinel emitted by context-manager's claude-only template, repo-CLAUDE-claude-only.md.template).
  // In that mode the AGENT_INDEX / agent-context mandatory bullets do not apply, and
  // any reference to those paths is a dead link by construction.
  const claudeOnly = /<!--\s*claude-only-mode\s*-->/.test(lines.slice(0, 5).join('\n'));

  // 1. Coupling scan (hard-fail)
  for (const { pattern, label } of COUPLING_PATTERNS) {
    const m = body.match(pattern);
    if (m) {
      const lineNo = lineOf(body, m.index);
      errors.push(`coupling: ${label} at line ${lineNo} — CLAUDE.md must stay workspace-agnostic`);
    }
  }

  // 2. Mandatory bullets present (hard-fail). Each bullet is a list of
  //    alternative regex patterns — match ANY one to satisfy the bullet.
  //    Skipped in claude-only mode: those bullets point at AGENT_INDEX.md /
  //    agent-context/, which a claude-only repo deliberately does not have.
  if (!claudeOnly) {
    for (let i = 0; i < MANDATORY_BULLETS.length; i++) {
      const alternatives = MANDATORY_BULLETS[i];
      const matched = alternatives.some(re => re.test(body));
      if (!matched) {
        errors.push(`mandatory-bullet: required preamble bullet ${i + 1} missing — must match one of ${alternatives.length} accepted phrasings (legacy or role-specific template)`);
      }
    }
  }

  // 3. Dead-link check (hard-fail).
  if (!claudeOnly) {
    //  Match `agent-context*/<path>` references inside backticks or markdown links.
    const linkRegex = /`(agent-context[^`]*?\.md)`|\]\((agent-context[^)]*?\.md)\)/g;
    const seen = new Set();
    let linkMatch;
    while ((linkMatch = linkRegex.exec(body)) !== null) {
      const rel = linkMatch[1] || linkMatch[2];
      if (seen.has(rel)) continue;
      seen.add(rel);
      // Skip glob / brace-expansion forms — they're doc shorthand, not exact paths.
      if (rel.includes('*') || rel.includes('{')) continue;
      const abs = path.join(repoRoot || '.', rel);
      if (!fs.existsSync(abs)) {
        const lineNo = lineOf(body, linkMatch.index);
        errors.push(`dead-link: ${rel} at line ${lineNo} — file not found at ${abs}`);
      }
    }
  } else {
    // Claude-only: there is no agent-context/ dir or AGENT_INDEX.md, so ANY reference
    // to them is broken by construction. This catches the forms the generic dead-link
    // check above misses — e.g. `CLAUDE.md#AGENT_INDEX.md` and a bare `agent-context/`.
    const danglingRe = /(AGENT_INDEX(?:\.md)?|agent-context\/?[A-Za-z0-9._/-]*)/g;
    const seenDangling = new Set();
    let dm;
    while ((dm = danglingRe.exec(body)) !== null) {
      const ref = dm[1];
      if (seenDangling.has(ref)) continue;
      seenDangling.add(ref);
      const lineNo = lineOf(body, dm.index);
      errors.push(`claude-only dangling-ref: "${ref}" at line ${lineNo} — this file is claude-only (no agent-context/ dir or AGENT_INDEX.md exists), so the reference is broken. Remove it, or switch the repo to full mode.`);
    }
  }

  // 4. Absolute-path rule (hard-fail)
  for (const { pattern, label } of ABSOLUTE_PATH_PATTERNS) {
    const m = body.match(pattern);
    if (m) {
      const lineNo = lineOf(body, m.index);
      errors.push(`absolute-path: ${label} at line ${lineNo} — all paths must be repo-relative`);
    }
  }

  // 5. Size budget (warn 150, hard-fail 200)
  const lineCount = lines.length;
  if (lineCount > 200) {
    errors.push(`size: ${lineCount} lines exceeds hard ceiling of 200`);
  } else if (lineCount > 150) {
    warnings.push(`size: ${lineCount} lines above soft ceiling of 150 — likely leaking agent-context content`);
  }

  // 6. Must-know / Inviolable Rules bullet cap (hard-fail >10).
  //    Legacy template uses "## Must-know guidelines"; role-specific templates
  //    use "## Inviolable Rules". Count whichever is present.
  const mustKnowCount = countSectionBullets(body, /^## Must-know guidelines/m);
  const inviolableCount = countSectionBullets(body, /^## Inviolable Rules/m);
  if (mustKnowCount > 10) {
    errors.push(`must-know: ${mustKnowCount} bullets under "## Must-know guidelines" — cap is 10; surplus belongs in agent-context/conventions.md`);
  }
  if (inviolableCount > 10) {
    errors.push(`inviolable-rules: ${inviolableCount} bullets under "## Inviolable Rules" — cap is 10; surplus belongs in agent-context/conventions.md (style rules) or domains/{name}.md (domain-specific dont's)`);
  }

  // 7. Secret scan (hard-fail on all; email is still flagged — reviewer can accept)
  for (const { pattern, label } of SECRET_PATTERNS) {
    const m = body.match(pattern);
    if (m) {
      const lineNo = lineOf(body, m.index);
      errors.push(`secret: ${label} at line ${lineNo} — remove before committing (value redacted)`);
    }
  }

  // 10. Idempotent output — flag the literal "Last Updated: YYYY-MM-DD" trailer.
  //     Process checks 8 (overwrite confirmation) and 9 (refresh semantics) are
  //     caller responsibilities — not validatable from file content alone.
  if (/\*Last Updated:\s*\d{4}-\d{2}-\d{2}\*/.test(body)) {
    warnings.push(`idempotency: "*Last Updated: YYYY-MM-DD*" trailer is not idempotent — drop it, or derive from git log`);
  }

  return { errors, warnings };
}

function lineOf(body, index) {
  return body.slice(0, index).split(/\r?\n/).length;
}

function countSectionBullets(body, headingRegex) {
  const headMatch = body.match(headingRegex);
  if (!headMatch) return 0;
  const start = headMatch.index + headMatch[0].length;
  const rest = body.slice(start);
  const nextHeadIdx = rest.search(/\n##\s/);
  const section = nextHeadIdx === -1 ? rest : rest.slice(0, nextHeadIdx);
  // Count lines that start with `1.`, `2.`, … OR `- ` (numbered or dashed bullets).
  const bulletLines = section.split(/\r?\n/).filter(l => /^\s*(?:\d+\.|-)\s+/.test(l));
  return bulletLines.length;
}

// ── CLI entry ─────────────────────────────────────────────
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate-claude-md.js <claude-md-path>');
    process.exit(1);
  }

  let body;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`Failed to read ${filePath}: ${e.message}`);
    process.exit(1);
  }

  const repoRoot = path.dirname(path.resolve(filePath));
  const { errors, warnings } = validate(body, repoRoot);

  for (const w of warnings) console.warn(`WARN:  ${w}`);
  for (const e of errors)   console.error(`ERROR: ${e}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} hard-fail(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn(`\nClean of hard-fails; ${warnings.length} warning(s) above.`);
    process.exit(2);
  }
  console.log(`Clean: ${filePath}`);
  process.exit(0);
}

module.exports = { validate };
