#!/usr/bin/env node
/**
 * autoapprove-marker.js — turn the opt-in /deliver auto-approve mode on or off
 * by writing / removing ~/.claude/.pipecrew-deliver-autoapprove.
 *
 * scripts/deliver-autoapprove-hook.js reads this marker to decide whether to
 * auto-approve safe implementer tool calls (see that file for the policy). The
 * marker is a no-op unless it points at a run whose scratchpad/checkpoints were
 * touched recently, so a forgotten marker ages out on its own — but the
 * orchestrator should still turn it OFF explicitly at run_end / interruption.
 *
 * Usage:
 *   node autoapprove-marker.js on  --run-dir=<dir> --run-id=<id>
 *   node autoapprove-marker.js off
 *
 * Only the /deliver skill should call this, and only when --auto-approve was
 * passed. Always exits 0 on success; exits 1 on a usage error.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const action = process.argv[2];
const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-deliver-autoapprove');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

if (action === 'off') {
  try { fs.unlinkSync(MARKER_PATH); console.log('auto-approve OFF (marker removed)'); }
  catch { console.log('auto-approve already off (no marker)'); }
  process.exit(0);
}

if (action === 'on') {
  const runDir = arg('run-dir');
  const runId = arg('run-id');
  if (!runDir) { console.error('--run-dir=<absolute run dir> is required for "on"'); process.exit(1); }
  if (!fs.existsSync(runDir)) { console.error(`run dir does not exist: ${runDir}`); process.exit(1); }
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify({
    run_id: runId || null,
    run_dir: runDir,
    created_at: new Date().toISOString(),
  }, null, 2));
  console.log(`auto-approve ON for run ${runId || '?'} (marker: ${MARKER_PATH})`);
  console.log('Safe implementer tool calls (Edit/Write + known build/test/git/read Bash) will not prompt.');
  console.log('Dangerous or unclassifiable commands STILL prompt. Turn off with: autoapprove-marker.js off');
  process.exit(0);
}

console.error('usage: autoapprove-marker.js on --run-dir=<dir> --run-id=<id>  |  off');
process.exit(1);
