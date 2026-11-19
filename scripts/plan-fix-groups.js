#!/usr/bin/env node
/**
 * plan-fix-groups.js — group a regression run's failures and route each group
 * for /test-and-fix (ADR-004).
 *
 * Input: the REGRESSION_FAILURES block as JSON — `{ failures: [...] }` (the
 * output of `extract-block.js {run_dir}/report.md REGRESSION_FAILURES`) or a
 * bare array of failure entries. Schema: templates/blocks/block-schemas.md.
 *
 * Grouping key: (primary repo = repos_touched[0], locus) where locus is
 *   - the file path of evidence.file_line, when set;
 *   - else `http:{status} {METHOD /path}` from evidence.http + the case's When;
 *   - else `surface:{surface}`.
 * Routing: every failure in the group is `localized: true` or
 * `mode: "code-grounded"` → `direct`; otherwise → `diagnose`.
 * Bounce: the union of the group's repos_touched has more than 2 repos.
 *
 * Usage:
 *   node plan-fix-groups.js --input=<failures.json>
 *
 * Output (stdout): { "groups": [ { id, repo, locus, path, case_ids,
 *   repos_touched, bounce, failures } ] } — sorted by repo, then locus.
 *
 * Exit codes: 0 ok · 1 input unreadable · 2 usage · 4 bad JSON / bad shape
 */

const fs = require('fs');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function fileOf(fileLine) {
  // "repo/path/File.java:88" → "repo/path/File.java"
  return String(fileLine).replace(/:\d+(:\d+)?$/, '');
}

function httpLocus(http, when) {
  const status = (/\b([1-5]\d\d)\b/.exec(String(http)) || [])[1] || 'unknown';
  const route = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/.exec(String(when || ''));
  return route ? `http:${status} ${route[1]} ${route[2]}` : `http:${status}`;
}

function locusOf(f) {
  const ev = f.evidence || {};
  if (ev.file_line) return fileOf(ev.file_line);
  if (ev.http) return httpLocus(ev.http, f.when);
  return `surface:${f.surface || 'unknown'}`;
}

function isDirect(f) {
  return f.localized === true || f.mode === 'code-grounded';
}

function plan(failures) {
  const byKey = new Map();
  for (const f of failures) {
    const repos = Array.isArray(f.repos_touched) ? f.repos_touched : [];
    const repo = repos[0] || 'unknown';
    const locus = locusOf(f);
    const key = `${repo}\u0000${locus}`;
    if (!byKey.has(key)) byKey.set(key, { repo, locus, failures: [] });
    byKey.get(key).failures.push(f);
  }
  const groups = [...byKey.values()].sort((a, b) =>
    a.repo === b.repo ? (a.locus < b.locus ? -1 : a.locus > b.locus ? 1 : 0) : (a.repo < b.repo ? -1 : 1));
  return groups.map((g, i) => {
    const touched = [...new Set(g.failures.flatMap(f => Array.isArray(f.repos_touched) ? f.repos_touched : []))];
    return {
      id: `G${i + 1}`,
      repo: g.repo,
      locus: g.locus,
      path: g.failures.every(isDirect) ? 'direct' : 'diagnose',
      case_ids: g.failures.map(f => f.case_id),
      repos_touched: touched,
      bounce: touched.length > 2 ? 'touches >2 repos' : null,
      failures: g.failures,
    };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('usage: node plan-fix-groups.js --input=<failures.json>');
    process.exit(2);
  }
  let raw;
  try { raw = fs.readFileSync(args.input, 'utf8'); }
  catch (e) { console.error(`cannot read ${args.input}: ${e.message}`); process.exit(1); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { console.error(`bad JSON in ${args.input}: ${e.message}`); process.exit(4); }
  const failures = Array.isArray(data) ? data : data && data.failures;
  if (!Array.isArray(failures)) {
    console.error('input must be {"failures":[...]} or an array');
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({ groups: plan(failures) }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { plan, locusOf, isDirect };
