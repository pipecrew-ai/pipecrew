#!/usr/bin/env node
/**
 * simulate-run.js — dry-run harness for the pipeline-view UI.
 *
 * Creates a fake run directory under
 *   {workspace_root}/{slug}/runs/feature/{YYYY-MM-DD-HHMMSS}-simulated-demo/
 * where {workspace_root} is resolved via scripts/workspace-root.js
 * (default: ~/.claude/pipecrew/workspaces/).
 * and steps through a scripted feature-pipeline timeline, writing to
 * scratchpad.md, checkpoints.jsonl, and awaiting_input.json in the same
 * shape a real /deliver run would produce.
 *
 * When --launch-ui is passed, the simulator spawns the pipeline-view server
 * as a subprocess pointed at the new run_id, so you can watch the browser
 * react to each step in real time.
 *
 * This validates end-to-end:
 *   - scratchpad markdown parsing (phase + task + dispatch-log tables)
 *   - checkpoints.jsonl enrichment (orchestrator tokens, retry markers)
 *   - awaiting_input.json gate banner
 *   - fs.watch → SSE broadcast → browser state update
 *
 * Usage:
 *   node simulate-run.js [--workspace=<slug>] [--step-ms=1500]
 *                        [--launch-ui] [--port=5173]
 *                        [--cleanup-on-exit] [--feature-name=<slug>]
 *
 * Flags:
 *   --workspace         workspace slug. Auto-detects single workspace if omitted.
 *   --step-ms           ms between timeline steps (default 1500).
 *   --launch-ui         spawn pipeline-view server as a child process.
 *   --port              initial port for the UI (server auto-increments if busy).
 *   --cleanup-on-exit   delete the simulated run dir on SIGINT/SIGTERM.
 *   --feature-name      human slug for the simulated feature
 *                       (default "simulated-demo").
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { resolveRoot: resolveWorkspaceRoot } = require('./workspace-root');

// ─── CLI args ────────────────────────────────────────────────
let workspace = null;
let stepMs = 1500;
let launchUi = false;
let port = 5173;
let cleanup = false;
let featureName = 'simulated-demo';
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--workspace='))        workspace = arg.slice('--workspace='.length);
  else if (arg.startsWith('--step-ms='))     stepMs    = parseInt(arg.slice('--step-ms='.length), 10);
  else if (arg === '--launch-ui')            launchUi  = true;
  else if (arg.startsWith('--port='))        port      = parseInt(arg.slice('--port='.length), 10);
  else if (arg === '--cleanup-on-exit')      cleanup   = true;
  else if (arg.startsWith('--feature-name=')) featureName = arg.slice('--feature-name='.length);
}

// ─── Workspace resolve ───────────────────────────────────────
const HOME = os.homedir();
const WORKSPACE_ROOT = resolveWorkspaceRoot();
if (!workspace) {
  const wsDir = WORKSPACE_ROOT;
  const workspaces = fs.existsSync(wsDir)
    ? fs.readdirSync(wsDir).filter(d => fs.existsSync(path.join(wsDir, d, 'config.json')))
    : [];
  if (workspaces.length === 1) {
    workspace = workspaces[0];
    console.log(`[auto] workspace=${workspace}`);
  } else if (workspaces.length === 0) {
    console.error('No workspaces found — pass --workspace=<slug> or run /discover first.');
    process.exit(1);
  } else {
    console.error('Multiple workspaces. Pass --workspace=<slug>:');
    workspaces.forEach(w => console.error(`  - ${w}`));
    process.exit(1);
  }
}

// ─── Run dir ─────────────────────────────────────────────────
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
const runId = `${ts}-${featureName}`;
const runDir = path.join(WORKSPACE_ROOT, workspace, 'runs', 'feature', runId);

fs.mkdirSync(path.join(runDir, 'outputs'), { recursive: true });
fs.mkdirSync(path.join(runDir, 'tasks'),   { recursive: true });
console.log(`[sim] run dir: ${runDir}`);

// ─── File helpers ────────────────────────────────────────────
const scratchpad  = path.join(runDir, 'scratchpad.md');
const checkpoints = path.join(runDir, 'checkpoints.jsonl');
const gateFile    = path.join(runDir, 'awaiting_input.json');

function iso() { return new Date().toISOString(); }

function emit(event) {
  fs.appendFileSync(checkpoints, JSON.stringify({ ts: iso(), ...event }) + '\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function openGate({ phase, gate = 'approval', question, context }) {
  const payload = { since: iso(), phase, gate, question };
  if (context) payload.context_summary = context;
  fs.writeFileSync(gateFile, JSON.stringify(payload, null, 2));
  console.log(`[sim] gate OPEN — phase ${phase}: ${question}`);
}
function closeGate() {
  if (fs.existsSync(gateFile)) {
    fs.unlinkSync(gateFile);
    console.log('[sim] gate CLOSED');
  }
}

// ─── Scratchpad state (rebuilt from scratch each render) ─────
const phaseStatus = [
  { phase: '1',    name: 'Requirements',       status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '2',    name: 'Architecture',       status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '3',    name: 'Spec Edit',          status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '4',    name: 'Spec Sync',          status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '5',    name: 'Implementation',     status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '5.5',  name: 'Code Review',        status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '5.75', name: 'Security Review',    status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '6',    name: 'Assessment',         status: 'PENDING', duration: '—', tokens: '—' },
  { phase: '7',    name: 'Summary',            status: 'PENDING', duration: '—', tokens: '—' },
];
const implTasks = [];    // { n, taskId, repo, agent, status, duration, tokens }
const dispatchLog = [];  // { n, phase, agent, taskId, duration, tokens, outcome }
let currentPhase = 'Phase 1: Requirements';
let overallStatus = 'IN_PROGRESS';

function setPhase(phaseId, key, value) {
  const p = phaseStatus.find(x => x.phase === phaseId);
  if (p) p[key] = value;
}

function render() {
  const phaseRows = phaseStatus.map(p =>
    `| ${p.phase}. ${p.name} | ${p.status} | ${p.duration} | ${p.tokens} | outputs/phase-${p.phase}.md |`
  ).join('\n');

  const taskRows = implTasks.length
    ? implTasks.map(t =>
        `| ${t.n} | ${t.taskId} | ${t.repo} | ${t.agent} | ${t.status} | ${t.duration} | ${t.tokens} | ${t.worktree || ''} | ${t.files || ''} |`
      ).join('\n')
    : '';

  const dispatchRows = dispatchLog.length
    ? dispatchLog.map(d =>
        `| ${d.n} | ${d.phase} | ${d.agent} | ${d.taskId || '—'} | ${d.duration} | ${d.tokens} | ${d.outcome} |`
      ).join('\n')
    : '';

  const body = `# Run Scratchpad (simulated)

## Run Info
- **Skill**: feature
- **Run ID**: ${runId}
- **Feature**: ${featureName} (simulated)
- **Workspace**: ${workspace}
- **Started**: ${iso()}
- **Current Phase**: ${currentPhase}
- **Status**: ${overallStatus}

## Phase Status

| Phase | Status | Duration | Tokens | Output File |
|-------|--------|----------|--------|-------------|
${phaseRows}

## Architecture Flags
- **Affected Services**: publisher, backoffice
- **Frontend Required**: Yes
- **Mock Required**: Yes
- **Infra Required**: No

## Implementation Tasks

| # | Task ID | Repo | Agent | Status | Duration | Tokens | Worktree | Files Changed |
|---|---------|------|-------|--------|----------|--------|----------|---------------|
${taskRows}

## Agent Dispatch Log

| # | Phase | Agent | Task ID | Duration | Tokens | Outcome |
|---|-------|-------|---------|----------|--------|---------|
${dispatchRows}
`;
  fs.writeFileSync(scratchpad, body);
}

function addDispatch(phase, agent, taskId, durationStr, tokensStr, outcome) {
  dispatchLog.push({
    n: dispatchLog.length + 1,
    phase, agent, taskId, duration: durationStr, tokens: tokensStr, outcome,
  });
}

// ─── Optionally launch the UI ────────────────────────────────
let uiChild = null;
if (launchUi) {
  const serverJs = path.join(__dirname, '..', 'skills', 'site-view', 'server.js');
  uiChild = spawn('node', [serverJs, `--workspace=${workspace}`, `--run-id=${runId}`, `--port=${port}`], {
    stdio: 'inherit',
  });
  uiChild.on('exit', code => console.log(`[sim] UI exited (code ${code})`));
}

// ─── Cleanup ─────────────────────────────────────────────────
function teardown(signal) {
  console.log(`\n[sim] ${signal} — tearing down`);
  if (uiChild && !uiChild.killed) {
    try { uiChild.kill(); } catch (_) {}
  }
  if (cleanup && fs.existsSync(runDir)) {
    fs.rmSync(runDir, { recursive: true, force: true });
    console.log(`[sim] removed ${runDir}`);
  } else if (!cleanup) {
    console.log(`[sim] run dir kept: ${runDir} (pass --cleanup-on-exit to remove)`);
  }
  process.exit(0);
}
process.on('SIGINT',  () => teardown('SIGINT'));
process.on('SIGTERM', () => teardown('SIGTERM'));

// ─── Timeline ────────────────────────────────────────────────
(async () => {
  emit({ event: 'run_start', skill: 'feature', run_id: runId, workspace_slug: workspace,
         args: { feature: featureName, simulated: true } });
  render();
  await sleep(stepMs);

  // ─ Phase 1: Requirements ─
  currentPhase = 'Phase 1: Requirements';
  setPhase('1', 'status', 'IN_PROGRESS');
  emit({ event: 'phase_start', skill: 'feature', run_id: runId, phase: '1', stage: 'requirements' });
  render();
  await sleep(stepMs);
  emit({ event: 'agent_end', skill: 'feature', run_id: runId, phase: '1', stage: 'requirements',
         agent_type: 'dal-product-owner', description: 'Phase 1 requirements',
         status: 'ok', total_tokens: 41200, tool_uses: 8, duration_ms: 145000 });
  addDispatch('1', 'dal-product-owner', '—', '2m 25s', '41K', 'COMPLETED');
  setPhase('1', 'status', 'COMPLETED'); setPhase('1', 'duration', '2m 25s'); setPhase('1', 'tokens', '41K');
  render();
  await sleep(stepMs);

  // ─ Gate A: user approval after Phase 1 ─
  openGate({
    phase: '1', gate: 'approval',
    question: 'Approve requirements doc (16 FR, 15 EC)?',
    context: 'simulated — you have ~8s before auto-continue',
  });
  render();
  await sleep(stepMs * 4);
  closeGate();

  // ─ Phase 2: Architecture ─
  currentPhase = 'Phase 2: Architecture';
  setPhase('2', 'status', 'IN_PROGRESS');
  emit({ event: 'phase_start', skill: 'feature', run_id: runId, phase: '2', stage: 'architecture' });
  render();
  await sleep(stepMs);
  emit({ event: 'agent_end', skill: 'feature', run_id: runId, phase: '2', stage: 'architecture',
         agent_type: 'solution-architect', description: 'technical design',
         status: 'ok', total_tokens: 86000, tool_uses: 21, duration_ms: 240000 });
  addDispatch('2', 'solution-architect', '—', '4m 00s', '86K', 'COMPLETED');
  setPhase('2', 'status', 'COMPLETED'); setPhase('2', 'duration', '4m 00s'); setPhase('2', 'tokens', '86K');
  render();
  await sleep(stepMs);

  // ─ Phase 3: Spec Edit ─
  currentPhase = 'Phase 3: Spec Edit';
  setPhase('3', 'status', 'IN_PROGRESS');
  emit({ event: 'phase_start', skill: 'feature', run_id: runId, phase: '3', stage: 'spec-edit' });
  render();
  await sleep(stepMs);
  emit({ event: 'agent_end', skill: 'feature', run_id: runId, phase: '3', stage: 'spec-edit',
         agent_type: 'openapi-spec-editor', description: 'apply spec changes',
         status: 'ok', total_tokens: 52000, tool_uses: 17, duration_ms: 510000 });
  addDispatch('3', 'openapi-spec-editor', '—', '8m 30s', '52K', 'COMPLETED');
  setPhase('3', 'status', 'COMPLETED'); setPhase('3', 'duration', '8m 30s'); setPhase('3', 'tokens', '52K');
  render();
  await sleep(stepMs);

  // ─ Phase 4 & 4.5 skipped for brevity — just mark COMPLETED ─
  setPhase('4', 'status', 'COMPLETED');
  render();
  await sleep(stepMs / 2);

  // ─ Phase 5: Parallel implementation (4 tasks concurrently) ─
  currentPhase = 'Phase 5: Implementation';
  setPhase('5', 'status', 'IN_PROGRESS');
  emit({ event: 'phase_start', skill: 'feature', run_id: runId, phase: '5', stage: 'implementation' });

  const tasks = [
    { n: 1, taskId: `${featureName}-a1`, repo: 'abvi-publisher-service',  agent: 'spring-boot-api-implementer' },
    { n: 2, taskId: `${featureName}-a2`, repo: 'abvi-backoffice-service', agent: 'spring-boot-api-implementer' },
    { n: 3, taskId: `${featureName}-a3`, repo: 'abvi-pms-frontend',       agent: 'ux-consultant + react-feature-implementer' },
    { n: 4, taskId: `${featureName}-a4`, repo: 'abvi-backends-mock',      agent: 'mock-endpoint-implementer' },
  ];
  for (const t of tasks) {
    implTasks.push({ ...t, status: 'IN_PROGRESS', duration: '—', tokens: '—' });
  }
  render();
  await sleep(stepMs * 2);

  // ─ Retry on task 2 to exercise the retry indicator ─
  emit({ event: 'retry', skill: 'feature', run_id: runId, phase: '5',
         agent_type: 'spring-boot-api-implementer', description: 'backoffice retry',
         retry_reason: '529 overloaded' });
  render();
  await sleep(stepMs);

  // ─ Tasks complete in staggered order ─
  const completeOrder = [
    { task: tasks[3], duration: '3m 12s', tokens: '91K' },
    { task: tasks[0], duration: '6m 15s', tokens: '135K' },
    { task: tasks[2], duration: '7m 02s', tokens: '159K' },
    { task: tasks[1], duration: '8m 30s', tokens: '161K' },
  ];
  for (const { task, duration, tokens } of completeOrder) {
    const row = implTasks.find(r => r.taskId === task.taskId);
    if (row) { row.status = 'COMPLETED'; row.duration = duration; row.tokens = tokens; }
    emit({ event: 'agent_end', skill: 'feature', run_id: runId, phase: '5',
           agent_type: task.agent.split(' + ')[0], description: task.repo,
           status: 'ok', total_tokens: parseInt(tokens) * 1000, tool_uses: 40, duration_ms: 0 });
    addDispatch('5', task.agent.split(' + ')[0], task.taskId, duration, tokens, 'COMPLETED');
    render();
    await sleep(stepMs);
  }
  setPhase('5', 'status', 'COMPLETED');
  setPhase('5', 'duration', '8m 30s');
  setPhase('5', 'tokens', '546K');
  emit({ event: 'phase_end', skill: 'feature', run_id: runId, phase: '5',
         stage: 'implementation', duration_ms: 510000 });
  render();
  await sleep(stepMs);

  // ─ Phase 5.5: Code review (with a gate for critical fixes) ─
  currentPhase = 'Phase 5.5: Code Review';
  setPhase('5.5', 'status', 'IN_PROGRESS');
  render();
  await sleep(stepMs);
  addDispatch('5.5', 'spring-boot-code-reviewer', '—', '7m 45s', '82K', 'COMPLETED');
  addDispatch('5.5', 'spring-boot-code-reviewer', '—', '5m 55s', '78K', 'COMPLETED');
  addDispatch('5.5', 'react-code-reviewer',       '—', '6m 00s', '119K', 'COMPLETED');
  setPhase('5.5', 'status', 'COMPLETED');
  setPhase('5.5', 'duration', '7m 45s');
  setPhase('5.5', 'tokens', '279K');
  render();
  await sleep(stepMs);

  openGate({
    phase: '5.5', gate: 'fix-round',
    question: 'Dispatch fix-round for 11 critical findings?',
    context: 'publisher: 4 critical · backoffice: 4 critical · frontend: 3 critical',
  });
  render();
  await sleep(stepMs * 4);
  closeGate();

  // ─ Phase 5.75: Security Review (one consultant per affected repo) ─
  currentPhase = 'Phase 5.75: Security Review';
  setPhase('5.75', 'status', 'IN_PROGRESS');
  render();
  await sleep(stepMs);
  addDispatch('5.75', 'security-consultant', '—', '4m 12s', '64K', 'COMPLETED');
  addDispatch('5.75', 'security-consultant', '—', '3m 50s', '58K', 'COMPLETED');
  setPhase('5.75', 'status', 'COMPLETED');
  setPhase('5.75', 'duration', '4m 12s');
  setPhase('5.75', 'tokens', '122K');
  render();
  await sleep(stepMs);

  // ─ Phase 6: Assessment ─
  currentPhase = 'Phase 6: Assessment';
  setPhase('6', 'status', 'IN_PROGRESS');
  render();
  await sleep(stepMs);
  addDispatch('6', 'dal-assessor', '—', '7m 40s', '174K', 'COMPLETED');
  setPhase('6', 'status', 'COMPLETED');
  setPhase('6', 'duration', '7m 40s');
  setPhase('6', 'tokens', '174K');
  render();
  await sleep(stepMs);

  // ─ Phase 7: Summary (reporter + context-manager) ─
  currentPhase = 'Phase 7: Summary';
  setPhase('7', 'status', 'IN_PROGRESS');
  render();
  await sleep(stepMs);
  addDispatch('7', 'reporter',        '—', '2m 20s', '38K', 'COMPLETED');
  addDispatch('7', 'context-manager', '—', '1m 05s', '21K', 'COMPLETED');
  setPhase('7', 'status', 'COMPLETED');
  setPhase('7', 'duration', '3m 25s');
  setPhase('7', 'tokens', '59K');
  render();

  overallStatus = 'COMPLETED';
  render();
  emit({ event: 'run_end', skill: 'feature', run_id: runId, status: 'completed', duration_ms: 1200000 });

  console.log(`\n[sim] timeline complete — scratchpad + checkpoints finalised at ${runDir}`);
  if (launchUi) {
    console.log('[sim] UI still running — Ctrl+C to stop (and ' + (cleanup ? 'delete' : 'keep') + ' the run dir)');
    // keep the process alive so the UI child keeps running
    await new Promise(() => {});
  } else {
    teardown('timeline-done');
  }
})().catch(err => {
  console.error('[sim] error:', err);
  teardown('error');
});
