#!/usr/bin/env node
/**
 * gate.js — small helper the orchestrator calls to signal an approval-gate
 * or clarifying question to the pipeline-view UI.
 *
 * Writes (or deletes) `{run_dir}/awaiting_input.json`. The pipeline-view
 * server watches that file and surfaces a banner in the browser when it exists.
 *
 * Usage:
 *   node gate.js open  --run-dir=<dir> --phase=<n> --gate=<label> --question="<text>" [--context="<summary>"]
 *   node gate.js close --run-dir=<dir>
 *
 * The file shape the UI expects:
 *   {
 *     "since":           "2026-04-16T11:30:00Z",
 *     "phase":           "3",
 *     "gate":            "approval" | "clarify" | "fix-round",
 *     "question":        "Approve these spec changes to continue to Phase 4?",
 *     "context_summary": "2 specs edited: +321/-20 on contract-api"
 *   }
 *
 * The orchestrator MUST call `gate.js close` as soon as it receives the
 * user's answer. Otherwise the UI banner stays up indefinitely.
 */

const fs = require('fs');
const path = require('path');

const action = process.argv[2];
if (action !== 'open' && action !== 'close') {
  console.error('usage: gate.js open|close --run-dir=<dir> [...]');
  process.exit(1);
}

let runDir = null;
let phase = null;
let gate = null;
let question = null;
let context = null;
for (const arg of process.argv.slice(3)) {
  if (arg.startsWith('--run-dir='))        runDir   = arg.slice('--run-dir='.length);
  else if (arg.startsWith('--phase='))     phase    = arg.slice('--phase='.length);
  else if (arg.startsWith('--gate='))      gate     = arg.slice('--gate='.length);
  else if (arg.startsWith('--question='))  question = arg.slice('--question='.length);
  else if (arg.startsWith('--context='))   context  = arg.slice('--context='.length);
}

if (!runDir) {
  console.error('--run-dir=<absolute path to run dir> is required');
  process.exit(1);
}
if (!fs.existsSync(runDir)) {
  console.error(`run dir does not exist: ${runDir}`);
  process.exit(1);
}

const filePath = path.join(runDir, 'awaiting_input.json');

if (action === 'close') {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`gate closed: ${filePath}`);
  } else {
    console.log('gate was not open (nothing to close)');
  }
  process.exit(0);
}

// action === 'open'
if (!phase || !question) {
  console.error('--phase=<n> and --question="<text>" are required for open');
  process.exit(1);
}

const payload = {
  since: new Date().toISOString(),
  phase,
  gate: gate || 'approval',
  question,
};
if (context) payload.context_summary = context;

fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
console.log(`gate opened: ${filePath}`);
