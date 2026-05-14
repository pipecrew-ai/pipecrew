#!/usr/bin/env node
/**
 * agent-context marker validator — verifies that <!-- agent-updatable -->
 * and <!-- human-owned --> markers are well-formed (matching open/close
 * pairs, no nesting, no orphans) across every .md file in an agent-context
 * directory.
 *
 * Usage:  node validate-agent-context-markers.js <agent-context-dir>
 * Exit 0 = clean, 1 = malformed markers found.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const OPEN_AGENT = /<!--\s*agent-updatable\s*-->/g;
const CLOSE_AGENT = /<!--\s*\/agent-updatable\s*-->/g;
const OPEN_HUMAN = /<!--\s*human-owned\s*-->/g;
const CLOSE_HUMAN = /<!--\s*\/human-owned\s*-->/g;

/**
 * Walk a directory tree, returning every .md file (excluding hidden dirs).
 */
function walkMarkdown(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Validate a single file's markers. Returns { errors: [{line, msg}] }.
 */
function validateFile(filePath) {
  const errors = [];
  const body = fs.readFileSync(filePath, 'utf8');

  const opens = [
    ...matchAll(body, OPEN_AGENT, 'agent-updatable'),
    ...matchAll(body, OPEN_HUMAN, 'human-owned'),
  ].sort((a, b) => a.index - b.index);
  const closes = [
    ...matchAll(body, CLOSE_AGENT, 'agent-updatable'),
    ...matchAll(body, CLOSE_HUMAN, 'human-owned'),
  ].sort((a, b) => a.index - b.index);

  // Walk the file in document order; maintain a stack of open markers.
  const events = [...opens.map(o => ({ ...o, kind: 'open' })), ...closes.map(c => ({ ...c, kind: 'close' }))]
    .sort((a, b) => a.index - b.index);

  const stack = [];
  for (const ev of events) {
    if (ev.kind === 'open') {
      if (stack.length > 0) {
        errors.push({
          line: lineOf(body, ev.index),
          msg: `nested marker: <!-- ${ev.kind === 'open' ? '' : '/'}${ev.type} --> opened inside an unclosed <!-- ${stack[stack.length - 1].type} --> (line ${stack[stack.length - 1].line}). Markers cannot nest.`,
        });
      }
      stack.push({ type: ev.type, line: lineOf(body, ev.index) });
    } else {
      if (stack.length === 0) {
        errors.push({
          line: lineOf(body, ev.index),
          msg: `orphan close: <!-- /${ev.type} --> with no matching open before it.`,
        });
      } else {
        const top = stack.pop();
        if (top.type !== ev.type) {
          errors.push({
            line: lineOf(body, ev.index),
            msg: `mismatched close: <!-- /${ev.type} --> closes <!-- ${top.type} --> opened at line ${top.line}.`,
          });
        }
      }
    }
  }

  for (const unclosed of stack) {
    errors.push({
      line: unclosed.line,
      msg: `unclosed marker: <!-- ${unclosed.type} --> opened at line ${unclosed.line} but never closed.`,
    });
  }

  return errors;
}

function matchAll(body, regex, type) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(body)) !== null) {
    out.push({ index: m.index, type });
  }
  return out;
}

function lineOf(body, index) {
  return body.slice(0, index).split(/\r?\n/).length;
}

// ── CLI entry ─────────────────────────────────────────────
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node validate-agent-context-markers.js <agent-context-dir>');
    process.exit(1);
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(1);
  }

  const files = walkMarkdown(dir);
  let totalErrors = 0;

  for (const file of files) {
    const errs = validateFile(file);
    if (errs.length > 0) {
      console.error(`\n${file}:`);
      for (const { line, msg } of errs) {
        console.error(`  line ${line}: ${msg}`);
      }
      totalErrors += errs.length;
    }
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} marker error(s) across ${files.length} file(s).`);
    process.exit(1);
  }
  console.log(`Clean: ${files.length} file(s) checked, all markers well-formed.`);
  process.exit(0);
}

module.exports = { validateFile, walkMarkdown };
