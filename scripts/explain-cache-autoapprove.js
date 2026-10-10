#!/usr/bin/env node
'use strict';
/**
 * explain-cache-autoapprove.js — PreToolUse classifier that lets /explain's
 * cache calls run without a permission prompt (Claude Code; routed by
 * pretooluse-dispatch.js). Always on, no marker: the only command it approves
 * is PipeCrew's own explain-cache.js, which reads files and writes only inside
 * its --cache-dir.
 *
 * Approved shape — nothing else:
 *   node <path>/scripts/explain-cache.js lookup|store --flag=… [--flag="…"] …
 *   optionally followed (store only, --answer-file=-) by a quoted heredoc
 *   <<'PIPECREW_EXPLAIN_EOF' … PIPECREW_EXPLAIN_EOF as the last line.
 *
 * Rejected (falls back to the normal prompt): any shell metacharacter in the
 * command line ($ ` \ ; & | < > ( ) or a newline), unbalanced quotes, a script
 * that isn't byte-identical to this plugin's explain-cache.js, a --cache-dir
 * outside an explain cache, a non-hex --key, or a heredoc whose terminator
 * appears anywhere but the last line.
 *
 * Zero dependencies — pure Node stdlib.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEREDOC_TAG = 'PIPECREW_EXPLAIN_EOF';
const HEREDOC_OPEN = `<<'${HEREDOC_TAG}'`;
const OWN_SCRIPT = path.join(__dirname, 'explain-cache.js');
const CACHE_DIR_RE = /(\/runs\/explain\/cache|\/explain-cache\/[^/]+)\/?$/;
const KEY_RE = /^[0-9a-f]{16}$/;
const META_RE = /[$`\\;&|<>()\n\r]/;

function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; }
}

function isOwnScript(p) {
  if (!p.endsWith('/scripts/explain-cache.js')) return false;
  try {
    if (fs.realpathSync(p) === fs.realpathSync(OWN_SCRIPT)) return true;
  } catch (_) { return false; }
  const own = sha(OWN_SCRIPT);
  return own !== null && sha(p) === own;
}

// Split a metacharacter-free line into words, honouring '…' and "…".
function words(line) {
  const out = [];
  let cur = '', quote = null, inWord = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; inWord = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) { out.push(cur); cur = ''; inWord = false; }
    } else {
      cur += ch; inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(cur);
  return out;
}

function classify(command) {
  const no = (reason) => ({ allow: false, reason });
  if (typeof command !== 'string') return no('no command');

  let line = command;
  let heredoc = false;
  const at = command.indexOf(HEREDOC_OPEN);
  if (at !== -1) {
    line = command.slice(0, at);
    const rest = command.slice(at + HEREDOC_OPEN.length);
    if (!rest.startsWith('\n')) return no('heredoc opener must end its line');
    const body = rest.slice(1).replace(/\n+$/, '').split('\n');
    if (body.pop() !== HEREDOC_TAG) return no('heredoc must end with its terminator');
    if (body.includes(HEREDOC_TAG)) return no('heredoc terminator repeated');
    heredoc = true;
  }

  line = line.replace(/\\\n/g, ' ').trim();
  if (META_RE.test(line)) return no('shell metacharacter in command line');
  const argv = words(line);
  if (!argv) return no('unbalanced quotes');

  const [bin, script, sub, ...flags] = argv;
  if (bin !== 'node') return no('not node');
  if (!script || !isOwnScript(script)) return no('not PipeCrew explain-cache.js');
  if (sub !== 'lookup' && sub !== 'store') return no('not lookup/store');

  const opts = {};
  for (const f of flags) {
    const m = f.match(/^--([a-z-]+)(?:=(.*))?$/s);
    if (!m) return no(`unexpected argument: ${f}`);
    opts[m[1]] = m[2] === undefined ? true : m[2];
  }
  const dir = opts['cache-dir'];
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.split('/').includes('..') || !CACHE_DIR_RE.test(dir)) {
    return no('cache dir is not an explain cache');
  }
  if (opts.key !== undefined && !KEY_RE.test(String(opts.key))) return no('malformed --key');
  if (heredoc && (sub !== 'store' || opts['answer-file'] !== '-')) return no('heredoc only for store --answer-file=-');

  return { allow: true, reason: `explain-cache ${sub}` };
}

module.exports = { classify, HEREDOC_TAG };
