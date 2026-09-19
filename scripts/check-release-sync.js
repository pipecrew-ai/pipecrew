#!/usr/bin/env node
/**
 * check-release-sync.js — guard against release drift.
 *
 * The `.claude-plugin/plugin.json` version, the newest CHANGELOG entry, and the
 * git tag list are supposed to move together. When they don't — version bumped
 * and changelogged but never tagged — release consumers silently fall behind
 * (this is how the repo drifted three versions past its last tag).
 *
 * This script enforces the always-true half as a hard error, and reports the
 * release-time half as a warning (or a hard error under --strict):
 *   - HARD:  plugin.json `version` must equal the newest `## [x.y.z]` heading
 *            in CHANGELOG.md.
 *   - WARN:  a matching `vX.Y.Z` git tag should exist. Missing is legitimate
 *            between a version-bump merge and cutting the release, so it's only
 *            a warning by default; pass --strict to fail (use as a release gate).
 *   - WARN:  a matching GitHub Release should exist (the tag alone notifies
 *            nobody — the CHANGELOG tells users to Watch → Custom → Releases,
 *            which only fires on the Release object; v1.11.0 initially shipped
 *            tag-only and no watcher was notified). Warning by default, hard
 *            error under --strict. Skipped (with a note under --strict) when
 *            the `gh` CLI is unavailable or unauthenticated — never fails on
 *            missing tooling.
 *
 * Zero deps. Run:
 *   node check-release-sync.js                     # dev check (missing tag/Release = warning)
 *   node check-release-sync.js --strict            # release gate (missing tag/Release = error)
 *   node check-release-sync.js --input=bundle.json # test hook, pure core, no git/gh/fs of repo
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** Newest `## [x.y.z]` version from CHANGELOG text, or null. */
function parseChangelogVersion(text) {
  const m = String(text).match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

/**
 * Pure core — no I/O. Returns { ok, errors[], warnings[] }.
 * `releases` is the list of GitHub Release tag names, or null when the `gh`
 * CLI was unavailable (unknown state — never treated as "missing").
 * @param {{version:string, changelogVersion:string|null, tags:string[], releases?:string[]|null, strict:boolean}} input
 */
function check({ version, changelogVersion, tags, releases, strict }) {
  const errors = [];
  const warnings = [];

  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    errors.push(`plugin.json version is missing or not semver: ${version}`);
  }
  if (!changelogVersion) {
    errors.push('CHANGELOG.md has no "## [x.y.z]" version heading');
  } else if (version && version !== changelogVersion) {
    errors.push(
      `version drift: plugin.json is ${version} but the newest CHANGELOG entry is ` +
      `${changelogVersion} — bump both together`,
    );
  }

  const tagList = Array.isArray(tags) ? tags : [];
  const tagged = Boolean(version) && tagList.includes(`v${version}`);
  if (version && !tagged) {
    const hint =
      `no git tag v${version} — cut the release:\n` +
      `    git tag -a v${version} -m "PipeCrew v${version}" && git push origin v${version}\n` +
      `    gh release create v${version} --title "v${version}" --notes "<the CHANGELOG ## [${version}] section>"`;
    if (strict) errors.push(hint);
    else warnings.push(`${hint}\n  (expected between a version bump and its release tag)`);
  }

  // GitHub Release check — only meaningful when the tag exists (the no-tag hint
  // above already covers the full release recipe) and gh gave us a real answer.
  const releaseList = Array.isArray(releases) ? releases : null;
  if (version && tagged) {
    if (releaseList === null) {
      if (strict) {
        warnings.push(
          `gh CLI unavailable — could not verify a GitHub Release exists for v${version} ` +
          `(the tag alone does not notify watchers)`,
        );
      }
    } else if (!releaseList.includes(`v${version}`)) {
      const hint =
        `tag v${version} exists but has no GitHub Release — watchers were not notified. Publish it:\n` +
        `    gh release create v${version} --title "v${version}" --notes "<the CHANGELOG ## [${version}] section>"`;
      if (strict) errors.push(hint);
      else warnings.push(hint);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Read the real repo (or a --input=<bundle.json> for tests). */
function readInputs() {
  const inputArg = process.argv.find((a) => a.startsWith('--input='));
  if (inputArg) {
    const bundle = JSON.parse(fs.readFileSync(inputArg.slice('--input='.length), 'utf8'));
    return {
      version: bundle.version,
      changelogVersion: bundle.changelogVersion,
      tags: Array.isArray(bundle.tags) ? bundle.tags : [],
      releases: Array.isArray(bundle.releases) ? bundle.releases : null,
    };
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  let tags = [];
  try {
    tags = execSync('git tag -l', { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // git unavailable (e.g. a tarball install) — treat as "no tags"; surfaces as a warning.
    tags = [];
  }
  let releases = null;
  try {
    releases = execSync('gh release list --limit 100 --json tagName --jq ".[].tagName"', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // gh missing / unauthenticated / offline — unknown, NOT "no releases".
    releases = null;
  }
  return { version: pkg.version, changelogVersion: parseChangelogVersion(changelog), tags, releases };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { version, changelogVersion, tags, releases } = readInputs();
  const { ok, errors, warnings } = check({ version, changelogVersion, tags, releases, strict });

  for (const w of warnings) console.warn(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);
  if (ok) {
    const parts = ['plugin.json', 'CHANGELOG'];
    if (tags.includes(`v${version}`)) parts.push('tag');
    if (Array.isArray(releases) && releases.includes(`v${version}`)) parts.push('GitHub Release');
    const list = parts.length > 2
      ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
      : parts.join(' and ');
    console.log(`✓ release in sync: ${list} agree on ${version}`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { check, parseChangelogVersion };
