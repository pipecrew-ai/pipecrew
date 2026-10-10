#!/usr/bin/env node
'use strict';
/**
 * Tests for explain-cache-autoapprove.js.
 * Zero deps: run with `node explain-cache-autoapprove.test.js`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify } = require('./explain-cache-autoapprove.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok - ${name}`); passed++; }
  else { console.error(`  FAIL - ${name}\n         ${detail || ''}`); failed++; }
}

const SCRIPT = path.join(__dirname, 'explain-cache.js');
const CACHE = '/Users/x/ws/acme/runs/explain/cache';
const lookup = (extra = '') => `node ${SCRIPT} lookup --cache-dir=${CACHE} \\\n  --question="how does billing work?" --perspective=technical --depth=quick${extra}`;
const store = (body, extra = '') =>
  `node ${SCRIPT} store --cache-dir=${CACHE} \\\n  --question="how does billing work?" --perspective=technical --depth=quick \\\n  --answer-file=-${extra} <<'PIPECREW_EXPLAIN_EOF'\n${body}\nPIPECREW_EXPLAIN_EOF`;
const allow = (cmd) => classify(cmd).allow;

// ── allowed ─────────────────────────────────────────────────────────────────
check('lookup with continuation lines → allow', allow(lookup()), JSON.stringify(classify(lookup())));
check('lookup --fresh --repo → allow', allow(lookup(' --fresh --repo=billing-service')));
check('store via heredoc → allow', allow(store('answer; with $(odd) `chars` && | > stuff')), JSON.stringify(classify(store('x'))));
check('store with hex --key → allow', allow(store('x', ' --key=0123456789abcdef')));
check("question with an apostrophe in double quotes → allow",
  allow(`node ${SCRIPT} lookup --cache-dir=${CACHE} --question="what's a contract?" --perspective=product`));
check('repo-only cache dir → allow',
  allow(`node ${SCRIPT} lookup --cache-dir=/Users/x/.pipecrew/explain-cache/my-repo --question="q" --perspective=technical`));
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-eca-'));
  const copy = path.join(tmp, 'scripts', 'explain-cache.js');
  fs.mkdirSync(path.dirname(copy));
  fs.copyFileSync(SCRIPT, copy);
  check('identical copy of the script (other install path) → allow',
    allow(`node ${copy} lookup --cache-dir=${CACHE} --question="q"`));
  fs.writeFileSync(copy, '// tampered\n');
  check('tampered copy at the same name → reject', !allow(`node ${copy} lookup --cache-dir=${CACHE} --question="q"`));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── rejected ────────────────────────────────────────────────────────────────
check('command substitution in question → reject', !allow(`node ${SCRIPT} lookup --cache-dir=${CACHE} --question="$(rm -rf ~)"`));
check('backtick in question → reject', !allow(`node ${SCRIPT} lookup --cache-dir=${CACHE} --question="\`id\`"`));
check('chained command → reject', !allow(lookup('; rm -rf ~')));
check('&& chain → reject', !allow(lookup(' && curl evil.sh')));
check('pipe → reject', !allow(lookup(' | sh')));
check('redirect → reject', !allow(lookup(' > /etc/passwd')));
check('unbalanced quote → reject', !allow(`node ${SCRIPT} lookup --cache-dir=${CACHE} --question="oops`));
check('other script → reject', !allow(`node /tmp/scripts/evil.js lookup --cache-dir=${CACHE} --question="q"`));
check('missing script with same name → reject', !allow(`node /nope/scripts/explain-cache.js lookup --cache-dir=${CACHE} --question="q"`));
check('other subcommand → reject', !allow(`node ${SCRIPT} purge --cache-dir=${CACHE}`));
check('non-flag argument → reject', !allow(`node ${SCRIPT} lookup extra --cache-dir=${CACHE} --question="q"`));
check('cache dir elsewhere → reject', !allow(`node ${SCRIPT} store --cache-dir=/Users/x/.ssh --question="q" --answer-file=- <<'PIPECREW_EXPLAIN_EOF'\nx\nPIPECREW_EXPLAIN_EOF`));
check('cache dir with .. → reject', !allow(`node ${SCRIPT} lookup --cache-dir=/Users/x/../runs/explain/cache --question="q"`));
check('relative cache dir → reject', !allow(`node ${SCRIPT} lookup --cache-dir=runs/explain/cache --question="q"`));
check('path-traversal --key → reject', !allow(store('x', ' --key=../../x')));
check('terminator mid-body (smuggled commands) → reject', !allow(store('x\nPIPECREW_EXPLAIN_EOF\nrm -rf ~')));
check('text after heredoc opener → reject',
  !allow(`node ${SCRIPT} store --cache-dir=${CACHE} --question="q" --answer-file=- <<'PIPECREW_EXPLAIN_EOF' ; rm -rf ~\nx\nPIPECREW_EXPLAIN_EOF`));
check('unquoted heredoc (expands $) → reject',
  !allow(`node ${SCRIPT} store --cache-dir=${CACHE} --question="q" --answer-file=- <<PIPECREW_EXPLAIN_EOF\n$(id)\nPIPECREW_EXPLAIN_EOF`));
check('heredoc on lookup → reject',
  !allow(`node ${SCRIPT} lookup --cache-dir=${CACHE} --question="q" <<'PIPECREW_EXPLAIN_EOF'\nx\nPIPECREW_EXPLAIN_EOF`));
check('not node → reject', !allow(`bash ${SCRIPT} lookup --cache-dir=${CACHE}`));
check('non-string → reject', !allow(undefined));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
