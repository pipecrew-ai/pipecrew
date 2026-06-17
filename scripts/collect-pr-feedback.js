#!/usr/bin/env node
/**
 * collect-pr-feedback.js — fetch a GitHub PR's review feedback via `gh` and
 * normalize it into a canonical, pre-numbered comment list the
 * feedback-learner builds its C-n inventory from.
 *
 * WHY A SCRIPT (not inline `gh` in the skill): the /learn completeness guard is
 * only as reliable as the comment list it validates against. If the orchestrator
 * hand-parses paginated `gh api` JSON, a comment can be missed BEFORE the
 * inventory step runs — and the guard cannot catch what was never enumerated.
 * This script fetches fully (pagination handled), strips bot/CI noise, and emits
 * a stable list with deterministic ids (C-1, C-2, …) so "did we cover every
 * comment?" becomes a mechanical count, not a judgment call. Same shape as
 * write-review-diff.js: shell-out → normalize → write a file the agent Reads.
 *
 * Usage:
 *   node collect-pr-feedback.js --pr=<url> [--out=<file>]
 *   node collect-pr-feedback.js --repo=<org/repo> --number=<n> [--out=<file>]
 *   node collect-pr-feedback.js --input=<bundle.json> [--out=<file>]   # test/offline hook
 *
 * --pr      : full PR URL, e.g. https://github.com/org/repo/pull/31
 * --repo    : org/repo (with --number) as an alternative to --pr
 * --number  : PR number (with --repo)
 * --out     : write the canonical JSON here and print a one-line summary to
 *             stdout. Omit to print the canonical JSON to stdout instead.
 * --input   : read a raw bundle { prView, inlineComments, conversationComments,
 *             reviewThreads? } from this file INSTEAD of calling `gh`. Lets the
 *             normalization be exercised offline (used by the test).
 *
 * Exit 0 success · 1 usage error · 2 `gh` failure (missing/not-authed/network)
 *        · 3 unparseable `gh` output.
 *
 * Zero dependencies — pure Node stdlib. execFileSync (no shell) so a repo slug
 * or number can never inject shell.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

// ---- bot / CI noise detection (excluded from the numbered inventory) --------

const BOT_LOGIN_DENYLIST = new Set([
  'codecov', 'codecov-commenter', 'sonarcloud', 'sonarqubecloud',
  'github-actions', 'dependabot', 'renovate', 'coderabbitai', 'vercel',
]);

function isNoise(login) {
  if (!login) return true;
  const l = String(login).toLowerCase();
  if (l.endsWith('[bot]')) return true;
  return BOT_LOGIN_DENYLIST.has(l.replace(/\[bot\]$/, ''));
}

// ---- pure normalization (no I/O, no gh) — the testable core ------------------

/**
 * @param {object} bundle { prView, inlineComments, conversationComments, reviewThreads? }
 * @param {object} meta   { repo, number }
 * @returns canonical { pr, counts, comments, excluded }
 */
function normalize(bundle, meta) {
  const prView = bundle.prView || {};
  const inline = Array.isArray(bundle.inlineComments) ? bundle.inlineComments : [];
  const conversation = Array.isArray(bundle.conversationComments) ? bundle.conversationComments : [];
  const reviews = Array.isArray(prView.reviews) ? prView.reviews : [];

  // resolved/outdated state from GraphQL reviewThreads, keyed by comment databaseId.
  const threadState = new Map();
  const threads = Array.isArray(bundle.reviewThreads) ? bundle.reviewThreads : [];
  for (const th of threads) {
    const nodes = (th.comments && th.comments.nodes) || [];
    for (const c of nodes) {
      if (c && c.databaseId != null) {
        threadState.set(Number(c.databaseId), {
          resolved: !!th.isResolved,
          outdated: !!th.isOutdated,
        });
      }
    }
  }

  const signal = [];
  const excluded = [];

  // 1. inline review comments (file:line)
  for (const c of inline) {
    const login = c.user && c.user.login;
    const rec = {
      kind: 'inline',
      author: login || null,
      association: c.author_association || null,
      path: c.path || null,
      line: c.line != null ? c.line : (c.original_line != null ? c.original_line : null),
      side: c.side || null,
      created_at: c.created_at || null,
      url: c.html_url || null,
      in_reply_to: c.in_reply_to_id != null ? c.in_reply_to_id : null,
      _id: c.id != null ? Number(c.id) : null,
      body: (c.body || '').trim(),
    };
    const st = rec._id != null ? threadState.get(rec._id) : null;
    rec.resolved = st ? st.resolved : null;
    // outdated: GraphQL says so, OR REST position is null (the line no longer exists).
    rec.outdated = st ? st.outdated : (c.position == null && c.original_line != null);
    route(rec, login);
  }

  // 2. conversation (issue) comments — general PR discussion, no file:line
  for (const c of conversation) {
    const login = c.user && c.user.login;
    const rec = {
      kind: 'conversation',
      author: login || null,
      association: c.author_association || null,
      path: null,
      line: null,
      side: null,
      created_at: c.created_at || null,
      url: c.html_url || null,
      in_reply_to: null,
      _id: c.id != null ? Number(c.id) : null,
      resolved: null,
      outdated: false,
      body: (c.body || '').trim(),
    };
    route(rec, login);
  }

  // 3. review summary bodies (the text a reviewer leaves on Approve / Request changes)
  for (const r of reviews) {
    const body = (r.body || '').trim();
    if (!body) continue; // an approval with no prose is not a comment
    const login = r.author && r.author.login;
    const rec = {
      kind: 'review-summary',
      author: login || null,
      association: r.authorAssociation || null,
      path: null,
      line: null,
      side: null,
      created_at: r.submittedAt || null,
      url: null,
      in_reply_to: null,
      _id: null,
      resolved: null,
      outdated: false,
      review_state: r.state || null,
      body,
    };
    route(rec, login);
  }

  function route(rec, login) {
    if (!rec.body) return; // empty body carries no signal
    if (isNoise(login)) {
      excluded.push({ author: rec.author, kind: rec.kind, reason: 'bot/ci', snippet: rec.body.slice(0, 80) });
      return;
    }
    signal.push(rec);
  }

  // Deterministic ordering so C-n ids are stable across re-runs:
  // kind priority, then created_at, then provider id.
  const KIND_ORDER = { inline: 0, conversation: 1, 'review-summary': 2 };
  signal.sort((a, b) => {
    const k = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (k !== 0) return k;
    const t = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    if (t !== 0) return t;
    return (a._id || 0) - (b._id || 0);
  });

  const comments = signal.map((rec, i) => {
    const { _id, ...rest } = rec;
    return { id: `C-${i + 1}`, ...rest };
  });

  return {
    pr: {
      repo: meta.repo || null,
      number: meta.number != null ? Number(meta.number) : null,
      title: prView.title || null,
      state: prView.state || null,
      merged: prView.merged != null ? !!prView.merged : null,
      head: prView.headRefName || null,
    },
    counts: {
      signal: comments.length,
      excluded: excluded.length,
      inline: comments.filter((c) => c.kind === 'inline').length,
      conversation: comments.filter((c) => c.kind === 'conversation').length,
      review_summary: comments.filter((c) => c.kind === 'review-summary').length,
    },
    comments,
    excluded,
  };
}

// ---- gh fetching (production path) ------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
}

function ghJson(args) {
  let raw;
  try {
    raw = gh(args);
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    const err = new Error(`gh ${args.join(' ')} failed: ${msg.trim()}`);
    err.exitCode = 2; // gh unavailable / not authed / network
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`could not parse gh output as JSON for: gh ${args.join(' ')}`);
    err.exitCode = 3;
    throw err;
  }
}

function fetchBundle(repo, number) {
  const prView = ghJson([
    'pr', 'view', String(number), '--repo', repo,
    '--json', 'title,body,state,merged,headRefName,reviews',
  ]);
  const inlineComments = ghJson([
    'api', `repos/${repo}/pulls/${number}/comments`, '--paginate',
  ]);
  const conversationComments = ghJson([
    'api', `repos/${repo}/issues/${number}/comments`, '--paginate',
  ]);

  // Best-effort resolved/outdated state via GraphQL. Never fatal — on any
  // failure we degrade to REST-derived `outdated` and `resolved: null`.
  let reviewThreads = [];
  try {
    const [owner, name] = repo.split('/');
    const q = [
      'query($owner:String!,$name:String!,$number:Int!){',
      '  repository(owner:$owner,name:$name){',
      '    pullRequest(number:$number){',
      '      reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{databaseId}}}}',
      '    }',
      '  }',
      '}',
    ].join('');
    const gqlRaw = gh([
      'api', 'graphql', '-f', `query=${q}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`,
    ]);
    const gql = JSON.parse(gqlRaw);
    reviewThreads =
      (gql.data &&
        gql.data.repository &&
        gql.data.repository.pullRequest &&
        gql.data.repository.pullRequest.reviewThreads &&
        gql.data.repository.pullRequest.reviewThreads.nodes) || [];
  } catch {
    reviewThreads = []; // degrade gracefully
  }

  return { prView, inlineComments, conversationComments, reviewThreads };
}

// ---- main -------------------------------------------------------------------

function parsePrUrl(url) {
  const m = String(url).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

function main() {
  const out = arg('out');
  const input = arg('input');
  const prUrl = arg('pr');
  let repo = arg('repo');
  let number = arg('number');

  let bundle;
  let meta;

  if (input) {
    if (!fs.existsSync(input)) {
      console.error(`input bundle not found: ${input}`);
      process.exit(1);
    }
    try {
      bundle = JSON.parse(fs.readFileSync(input, 'utf8'));
    } catch (e) {
      console.error(`could not parse input bundle as JSON: ${e.message}`);
      process.exit(3);
    }
    meta = { repo: repo || bundle.repo || null, number: number || bundle.number || null };
  } else {
    if (prUrl) {
      const parsed = parsePrUrl(prUrl);
      if (!parsed) {
        console.error(`could not parse --pr URL (expected .../{org}/{repo}/pull/{n}): ${prUrl}`);
        process.exit(1);
      }
      repo = parsed.repo;
      number = parsed.number;
    }
    if (!repo || !number) {
      console.error('usage: collect-pr-feedback.js --pr=<url> | --repo=<org/repo> --number=<n> [--out=<file>] [--input=<bundle.json>]');
      process.exit(1);
    }
    try {
      bundle = fetchBundle(repo, number);
    } catch (e) {
      console.error(e.message);
      process.exit(e.exitCode || 2);
    }
    meta = { repo, number };
  }

  const result = normalize(bundle, meta);
  const json = JSON.stringify(result);

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    const c = result.counts;
    console.log(
      `wrote ${c.signal} comments (C-1..C-${c.signal}) to ${out} ` +
      `[inline=${c.inline} conversation=${c.conversation} review=${c.review_summary} excluded=${c.excluded} noise]`
    );
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
} else {
  module.exports = { normalize, isNoise, parsePrUrl };
}
