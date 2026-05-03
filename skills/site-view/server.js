#!/usr/bin/env node
/**
 * Pipeline View — live visualizer for the feature-pipeline plugin.
 *
 * Watches ONE feature run's scratchpad.md and streams state to the browser.
 *
 * Layout:   {workspace_root}/{slug}/runs/deliver/{run_id}/scratchpad.md
 *           {workspace_root}/{slug}/runs/deliver/{run_id}/checkpoints.jsonl
 *
 *   - scratchpad.md is the primary source — phase table, task table, dispatch log
 *   - checkpoints.jsonl is enrichment — orchestrator-overhead tokens + retry markers
 *   - {workspace_root} resolved via scripts/workspace-root.js
 *     (default: ~/.claude/pipecrew/workspaces/)
 *
 * Usage:  node server.js [--workspace=<slug>] [--run-id=<id>] [--port=5173]
 *
 * Auto-detect rules when flags omitted:
 *   --workspace: single workspace under {workspace_root}/ → use it.
 *                Multiple → exit with list.
 *   --run-id:    most recently-modified scratchpad.md under
 *                {workspace_root}/{slug}/runs/deliver/&lt;run-id&gt;/
 *
 * Zero dependencies — pure Node stdlib.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');
const { resolveRoot: resolveWorkspaceRoot } = require('../../scripts/workspace-root');

const HOME = os.homedir();
const WORKSPACE_ROOT = resolveWorkspaceRoot();

// ─── CLI args ────────────────────────────────────────────────
let workspace = null;
let runId = null;
let port = 5173;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--workspace=')) workspace = arg.slice('--workspace='.length);
  else if (arg.startsWith('--run-id=')) runId = arg.slice('--run-id='.length);
  else if (arg.startsWith('--port=')) port = parseInt(arg.slice('--port='.length), 10);
}

// ─── Workspace resolution ────────────────────────────────────
function resolveWorkspace() {
  if (workspace) return workspace;
  const wsDir = WORKSPACE_ROOT;
  if (!fs.existsSync(wsDir)) {
    console.error(`No workspaces directory at ${wsDir}. Run /discover first.`);
    process.exit(1);
  }
  const workspaces = fs.readdirSync(wsDir).filter(d =>
    fs.existsSync(path.join(wsDir, d, 'config.json'))
  );
  if (workspaces.length === 0) {
    console.error('No workspace configs found. Run /discover first.');
    process.exit(1);
  }
  if (workspaces.length === 1) {
    console.log(`[auto] workspace=${workspaces[0]}`);
    return workspaces[0];
  }
  console.error(`Multiple workspaces found — pass --workspace=<slug>:`);
  workspaces.forEach(w => console.error(`  - ${w}`));
  process.exit(1);
}
workspace = resolveWorkspace();

// ─── Run-id resolution ───────────────────────────────────────
function runsDir() {
  return path.join(WORKSPACE_ROOT, workspace, 'runs', 'deliver');
}

let lastAnnouncedRunId = null;
function resolveRunId() {
  if (runId) return runId;
  const dir = runsDir();
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .filter(d => fs.existsSync(path.join(dir, d, 'scratchpad.md')))
    .map(d => ({ id: d, mtime: fs.statSync(path.join(dir, d, 'scratchpad.md')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;
  const chosen = candidates[0].id;
  // Log the roster only when the chosen run changes (first call, or a newer run
  // appeared since we last looked). Keeps hot-path calls silent.
  if (chosen !== lastAnnouncedRunId) {
    if (candidates.length > 1) {
      console.log(`[auto] ${candidates.length} runs — watching most recent:`);
      candidates.slice(0, 5).forEach((c, i) =>
        console.log(`  ${i === 0 ? '→' : ' '} ${c.id}`)
      );
      console.log('  (pass --run-id=<id> to pick a different one)');
    }
    lastAnnouncedRunId = chosen;
  }
  return chosen;
}

function runDir() {
  const id = resolveRunId();
  if (!id) return null;
  return path.join(runsDir(), id);
}

function scratchpadPath() {
  const d = runDir();
  return d ? path.join(d, 'scratchpad.md') : null;
}

function checkpointsPath() {
  const d = runDir();
  return d ? path.join(d, 'checkpoints.jsonl') : null;
}

function awaitingInputPath() {
  const d = runDir();
  return d ? path.join(d, 'awaiting_input.json') : null;
}

function awaitingClaudeApprovalPath() {
  const d = runDir();
  return d ? path.join(d, 'awaiting_claude_approval.json') : null;
}

function hookErrorPath() {
  const d = runDir();
  return d ? path.join(d, 'hook_error.json') : null;
}

const GLOBAL_HOOK_ERROR_LOG = path.join(HOME, '.claude', 'logs', 'pipeline-view-hook-errors.log');

// ─── Latest-run-mtime helper for cache invalidation ─────────────────────────
//
// Returns the most recent mtime across scratchpad.md / checkpoints.jsonl /
// report.md / learner-output.md inside any direct child dir of `runsDir`.
// Used as a synthetic cache key: any new run or any update to a known
// per-run file invalidates the workspace-overview cache.
function latestRunMtime(runsDir) {
  if (!fs.existsSync(runsDir)) return 0;
  let latest = 0;
  let entries;
  try { entries = fs.readdirSync(runsDir); } catch (_) { return 0; }
  for (const sub of entries) {
    const subDir = path.join(runsDir, sub);
    try {
      const dirStat = fs.statSync(subDir);
      if (!dirStat.isDirectory()) continue;
      latest = Math.max(latest, dirStat.mtimeMs);
      for (const fname of ['scratchpad.md', 'checkpoints.jsonl', 'report.md', 'learner-output.md']) {
        const fp = path.join(subDir, fname);
        if (fs.existsSync(fp)) {
          latest = Math.max(latest, fs.statSync(fp).mtimeMs);
        }
      }
    } catch (_) {}
  }
  return latest;
}

// ─── Deliver run helpers (cheap metadata + lazy detail) ─────────────────────
//
// readDeliverRunMeta(runsDir, runId, mtime) — fast: only parses scratchpad
// header. Returned for every /deliver run when the project drawer opens.
//
// readDeliverRunDetail(runsDir, runId) — slow: reads report.md fully, parses
// PR URLs, and aggregates per-phase tokens/durations from checkpoints.jsonl.
// Called per-run when the user expands that row.
//
// Both are unsanitized-input-safe: callers must validate runId against the
// known run directory listing before passing it in.
function readDeliverRunMeta(runsDir, runId, mtimeMs) {
  const runDir = path.join(runsDir, runId);
  const meta = {
    run_id: runId,
    updated_at: new Date(mtimeMs).toISOString(),
    feature_name: null,
    status: null,
  };
  const scratchPath = path.join(runDir, 'scratchpad.md');
  if (fs.existsSync(scratchPath)) {
    try {
      const sp = fs.readFileSync(scratchPath, 'utf8');
      const fm = sp.match(/^- \*\*Feature\*\*:\s*(.+)$/m) || sp.match(/^# Feature Pipeline Run.*?\n.*?Feature[:\s]+(.+?)$/im);
      if (fm) meta.feature_name = fm[1].trim();
      const sm = sp.match(/^- \*\*Status\*\*:\s*(\w+)/m);
      if (sm) meta.status = sm[1].trim();
    } catch (_) {}
  }
  return meta;
}

function readDeliverRunDetail(runsDir, runId) {
  const runDir = path.join(runsDir, runId);
  if (!fs.existsSync(runDir)) return null;
  const stat = fs.statSync(path.join(runDir, 'scratchpad.md'));
  const detail = {
    ...readDeliverRunMeta(runsDir, runId, stat.mtimeMs),
    report_md: null,
    pr_urls: [],
    phase_breakdown: [],
    total_tokens: 0,
    total_agents: 0,
  };

  // Read report.md (Phase 7 output, with Phase 8 PR table appended if --with-pr)
  const reportPath = path.join(runDir, 'report.md');
  if (fs.existsSync(reportPath)) {
    try {
      detail.report_md = fs.readFileSync(reportPath, 'utf8');
    } catch (_) {}
  }

  // PR URLs — prefer the structured JSON file written by Phase 8 Step 8.5b
  // (stable contract). Fall back to regex-parsing the report.md "## Pull
  // Requests" table only if pr_urls.json is missing — the markdown format
  // may evolve over time but the JSON shape is guaranteed.
  const prUrlsJsonPath = path.join(runDir, 'pr_urls.json');
  if (fs.existsSync(prUrlsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(prUrlsJsonPath, 'utf8'));
      if (Array.isArray(data.prs)) {
        detail.pr_urls = data.prs.map(p => ({
          pr_number: String(p.pr_number ?? ''),
          url: p.url || '',
          repo: p.repo || null,
        }));
      }
      if (Array.isArray(data.failed) && data.failed.length) {
        detail.pr_failures = data.failed;
      }
    } catch (_) {}
  } else if (detail.report_md) {
    const prSection = detail.report_md.match(/##\s*Pull Requests\s*\n+([\s\S]*?)(?=\n##\s|\n---\s*\n|$)/i);
    if (prSection) {
      const urlRe = /\[#?(\d+)\]\((https?:\/\/[^\s)]+)\)/g;
      let m;
      while ((m = urlRe.exec(prSection[1])) !== null) {
        const repoMatch = prSection[1].slice(0, m.index).match(/\|\s*([^|]+?)\s*\|[^|]*$/);
        detail.pr_urls.push({
          pr_number: m[1],
          url: m[2],
          repo: repoMatch ? repoMatch[1].trim() : null,
        });
      }
    }
  }

  // Parse checkpoints.jsonl for per-phase breakdown
  const cpPath = path.join(runDir, 'checkpoints.jsonl');
  if (fs.existsSync(cpPath)) {
    try {
      const byPhase = new Map();
      const phaseOrder = [];
      const raw = fs.readFileSync(cpPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.event !== 'agent_end') continue;
        if (ev.status && ev.status !== 'ok') continue;
        const phase = ev.phase || 'unknown';
        if (!byPhase.has(phase)) {
          byPhase.set(phase, { tokens: 0, duration_ms: 0, agent_count: 0, stage: ev.stage || null });
          phaseOrder.push(phase);
        }
        const row = byPhase.get(phase);
        row.tokens += ev.total_tokens || 0;
        row.duration_ms += ev.duration_ms || 0;
        row.agent_count += 1;
      }
      detail.phase_breakdown = phaseOrder.map(p => ({
        phase: p,
        stage: byPhase.get(p).stage,
        tokens: byPhase.get(p).tokens,
        duration_ms: byPhase.get(p).duration_ms,
        agent_count: byPhase.get(p).agent_count,
      }));
      detail.total_tokens = detail.phase_breakdown.reduce((a, r) => a + r.tokens, 0);
      detail.total_agents = detail.phase_breakdown.reduce((a, r) => a + r.agent_count, 0);
    } catch (_) {}
  }

  return detail;
}

// ─── Learn run helpers (cheap metadata + lazy detail) ───────────────────────
//
// Mirrors the deliver-run helpers but for /learn skill runs. Each /learn
// invocation produces a run dir under runs/learn/{run_id}/ with:
//   - checkpoints.jsonl  (always)
//   - learner-output.md  (the feedback-learner agent's full output)
// run_id format: {YYYY-MM-DD-HHMMSS}-{source-slug} where source-slug is
// pr-N / run-X / branch-Y / text — encodes which signal source was used.
function parseLearnRunSource(runId) {
  const m = runId.match(/^\d{4}-\d{2}-\d{2}-\d{6}-(.+)$/);
  if (!m) return { source_mode: 'unknown', source_label: runId };
  const slug = m[1];
  if (slug.startsWith('pr-')) return { source_mode: 'pr', source_label: 'PR ' + slug.slice(3) };
  if (slug.startsWith('run-')) return { source_mode: 'run', source_label: 'Run ' + slug.slice(4) };
  if (slug.startsWith('branch-')) return { source_mode: 'branch', source_label: 'Branch ' + slug.slice(7) };
  if (slug === 'text' || slug.startsWith('text-')) return { source_mode: 'text', source_label: 'Free-form text' };
  return { source_mode: 'unknown', source_label: slug };
}

function readLearnRunMeta(runsDir, runId, mtimeMs) {
  const src = parseLearnRunSource(runId);
  return {
    run_id: runId,
    updated_at: new Date(mtimeMs).toISOString(),
    source_mode: src.source_mode,
    source_label: src.source_label,
  };
}

function readLearnRunDetail(runsDir, runId) {
  const runDir = path.join(runsDir, runId);
  if (!fs.existsSync(runDir)) return null;
  // Find the freshest mtime among known per-run files for the meta lookup.
  let mtime = 0;
  for (const fname of ['learner-output.md', 'checkpoints.jsonl']) {
    const fp = path.join(runDir, fname);
    if (fs.existsSync(fp)) mtime = Math.max(mtime, fs.statSync(fp).mtimeMs);
  }
  const detail = {
    ...readLearnRunMeta(runsDir, runId, mtime),
    learner_output_md: null,
    counts: { applied: 0, rejected: 0, flagged: 0, run_local: 0 },
    total_tokens: 0,
    total_agents: 0,
  };

  // Read learner-output.md fully (renders as markdown in the drawer).
  const outPath = path.join(runDir, 'learner-output.md');
  if (fs.existsSync(outPath)) {
    try {
      detail.learner_output_md = fs.readFileSync(outPath, 'utf8');
      // Cheap counts — count occurrences of "Tier:" lines in each category.
      // The agent emits "Tier: workspace-durable" / "Tier: repo-durable" /
      // "Tier: plugin-level" / "Tier: run-local" per finding.
      const tierLines = detail.learner_output_md.match(/\*\*Tier\*\*:\s*`?([a-z-]+)`?/gi) || [];
      for (const t of tierLines) {
        const m = t.match(/`?([a-z-]+)`?\s*$/i);
        if (!m) continue;
        const tier = m[1].toLowerCase();
        if (tier === 'workspace-durable' || tier === 'repo-durable') detail.counts.applied += 1;
        else if (tier === 'plugin-level') detail.counts.flagged += 1;
        else if (tier === 'run-local') detail.counts.run_local += 1;
      }
    } catch (_) {}
  }

  // Token totals from checkpoints.jsonl
  const cpPath = path.join(runDir, 'checkpoints.jsonl');
  if (fs.existsSync(cpPath)) {
    try {
      const raw = fs.readFileSync(cpPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev.event !== 'agent_end') continue;
        if (ev.status && ev.status !== 'ok') continue;
        detail.total_tokens += ev.total_tokens || 0;
        detail.total_agents += 1;
      }
    } catch (_) {}
  }

  return detail;
}

// ─── Workspace overview (/discover outputs — static across /deliver runs) ────
//
// Reads the workspace-level artifacts produced by /discover so the UI can
// show a read-only "Project" panel. These files are stable between deliver
// runs, so we cache and only re-read on mtime change.
let workspaceOverviewCache = null;  // { data, mtimes }
function readWorkspaceOverview() {
  const wsDir = path.join(WORKSPACE_ROOT, workspace);
  const configPath = path.join(wsDir, 'config.json');
  const platformPath = path.join(wsDir, 'context', 'platform.md');
  const auditPath = path.join(wsDir, 'context', 'audit-findings.md');
  const architectureMmdPath = path.join(wsDir, 'context', 'architecture.mmd');
  const architectureOverviewMmdPath = path.join(wsDir, 'context', 'architecture-overview.mmd');
  const discoverRunsDir = path.join(wsDir, 'runs', 'discover');
  const deliverRunsDir = path.join(wsDir, 'runs', 'deliver');
  const learnRunsDir = path.join(wsDir, 'runs', 'learn');

  // Check mtimes — if nothing changed, serve from cache.
  const mtimes = {};
  for (const p of [configPath, platformPath, auditPath, architectureMmdPath, architectureOverviewMmdPath]) {
    mtimes[p] = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
  }
  // Also include the most recent activity under deliver/learn run dirs as a
  // synthetic key so new runs (and updates to existing report/scratchpad files)
  // invalidate the cache without needing a workspace-stable file to change.
  mtimes[':deliver-runs-latest:'] = latestRunMtime(deliverRunsDir);
  mtimes[':learn-runs-latest:'] = latestRunMtime(learnRunsDir);
  if (workspaceOverviewCache &&
      Object.keys(mtimes).every(k => mtimes[k] === workspaceOverviewCache.mtimes[k])) {
    return workspaceOverviewCache.data;
  }

  const data = {
    workspace_slug: workspace,
    workspace_name: null,
    domain: null,
    repos: [],
    services: [],
    platform_md_excerpt: null,
    audit_summary: null,
    last_discover_run: null,
    deliver_runs: [],
    learn_runs: [],
    design_systems: [],
    architecture_mermaid: null,
    architecture_overview_mermaid: null,
  };

  // 1. Parse config.json
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      data.workspace_name = cfg.workspace?.name || workspace;
      data.domain = cfg.domain || null;
      data.repos = Object.entries(cfg.repos || {}).map(([key, r]) => ({
        key,
        path: r.path,
        type: r.type,
        role: r.role,
        description: r.description || '',
        spec_file: r.spec_file || null,
      }));
      data.services = Object.entries(cfg.services || {}).map(([key, s]) => ({
        key,
        repo: s.repo,
        spec_policy: s.spec_policy || 'api-first',
        spec_file: s.spec_file || null,
        description: s.description || '',
      }));
    } catch (e) {
      data.config_error = e.message;
    }
  }

  // 2. Read platform.md (full content — drawer renders it as markdown and scrolls)
  if (fs.existsSync(platformPath)) {
    try {
      const txt = fs.readFileSync(platformPath, 'utf8');
      data.platform_md_excerpt = txt;
      data.platform_md_total_lines = txt.split(/\r?\n/).length;
      data.platform_md_truncated = false;
    } catch (_) {}
  }

  // 3. Parse audit-findings.md summary table
  if (fs.existsSync(auditPath)) {
    try {
      const txt = fs.readFileSync(auditPath, 'utf8');
      const summary = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const sev of ['critical', 'high', 'medium', 'low']) {
        const m = txt.match(new RegExp(`\\|\\s*${sev}\\s*\\|\\s*(\\d+)\\s*\\|`, 'i'));
        if (m) summary[sev] = parseInt(m[1], 10);
      }
      data.audit_summary = summary;
    } catch (_) {}
  }

  // 4. Last discover run metadata + per-phase token breakdown
  if (fs.existsSync(discoverRunsDir)) {
    try {
      const runs = fs.readdirSync(discoverRunsDir)
        .filter(d => fs.existsSync(path.join(discoverRunsDir, d, 'scratchpad.md')))
        .map(d => ({ id: d, mtime: fs.statSync(path.join(discoverRunsDir, d, 'scratchpad.md')).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (runs.length > 0) {
        const lastRun = runs[0];
        data.last_discover_run = {
          run_id: lastRun.id,
          updated_at: new Date(lastRun.mtime).toISOString(),
          phase_breakdown: [],
          total_tokens: 0,
          total_agents: 0,
        };

        // Parse checkpoints.jsonl to aggregate tokens per phase.
        const cpPath = path.join(discoverRunsDir, lastRun.id, 'checkpoints.jsonl');
        if (fs.existsSync(cpPath)) {
          const byPhase = new Map();  // phase -> { tokens, duration_ms, agent_count, stage }
          const phaseOrder = [];       // preserve first-seen phase order
          const raw = fs.readFileSync(cpPath, 'utf8');
          for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            let ev;
            try { ev = JSON.parse(line); } catch (_) { continue; }
            if (ev.event !== 'agent_end') continue;
            if (ev.status && ev.status !== 'ok') continue;  // skip failed/deferred
            const phase = ev.phase || 'unknown';
            if (!byPhase.has(phase)) {
              byPhase.set(phase, { tokens: 0, duration_ms: 0, agent_count: 0, stage: ev.stage || null });
              phaseOrder.push(phase);
            }
            const row = byPhase.get(phase);
            row.tokens += ev.total_tokens || 0;
            row.duration_ms += ev.duration_ms || 0;
            row.agent_count += 1;
          }
          data.last_discover_run.phase_breakdown = phaseOrder.map(p => ({
            phase: p,
            stage: byPhase.get(p).stage,
            tokens: byPhase.get(p).tokens,
            duration_ms: byPhase.get(p).duration_ms,
            agent_count: byPhase.get(p).agent_count,
          }));
          data.last_discover_run.total_tokens = data.last_discover_run.phase_breakdown.reduce((a, r) => a + r.tokens, 0);
          data.last_discover_run.total_agents = data.last_discover_run.phase_breakdown.reduce((a, r) => a + r.agent_count, 0);
        }
      }
    } catch (_) {}
  }

  // 4b. All /deliver runs — CHEAP metadata only (run_id, feature_name, status,
  // updated_at). Heavy data (report.md content, PR URLs, checkpoints parse) is
  // lazy-loaded per run via /deliver-run-detail when the user expands a row.
  if (fs.existsSync(deliverRunsDir)) {
    try {
      const runs = fs.readdirSync(deliverRunsDir)
        .filter(d => fs.existsSync(path.join(deliverRunsDir, d, 'scratchpad.md')))
        .map(d => ({ id: d, mtime: fs.statSync(path.join(deliverRunsDir, d, 'scratchpad.md')).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      for (const r of runs) {
        data.deliver_runs.push(readDeliverRunMeta(deliverRunsDir, r.id, r.mtime));
      }
    } catch (_) {}
  }

  // 4c. All /learn runs — CHEAP metadata only (run_id, source_mode, updated_at).
  // Heavy data (learner-output.md content, counts, tokens) is lazy-loaded via
  // /learn-run-detail when the user expands a row.
  if (fs.existsSync(learnRunsDir)) {
    try {
      const runs = fs.readdirSync(learnRunsDir)
        .map(d => {
          const dirPath = path.join(learnRunsDir, d);
          // Filter: must be a directory with at least checkpoints.jsonl or learner-output.md
          try {
            if (!fs.statSync(dirPath).isDirectory()) return null;
            for (const fname of ['checkpoints.jsonl', 'learner-output.md']) {
              const fp = path.join(dirPath, fname);
              if (fs.existsSync(fp)) return { id: d, mtime: fs.statSync(fp).mtimeMs };
            }
          } catch (_) {}
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);

      for (const r of runs) {
        data.learn_runs.push(readLearnRunMeta(learnRunsDir, r.id, r.mtime));
      }
    } catch (_) {}
  }

  // 5. Architecture diagrams (Mermaid source from /discover Phase B2)
  //    - architecture-overview.mmd: C4-style high-level block diagram (5-8 capability blocks)
  //    - architecture.mmd: detailed topology (every service, DB, queue, Lambda)
  if (fs.existsSync(architectureOverviewMmdPath)) {
    try {
      data.architecture_overview_mermaid = fs.readFileSync(architectureOverviewMmdPath, 'utf8').trim();
    } catch (_) {}
  }
  if (fs.existsSync(architectureMmdPath)) {
    try {
      data.architecture_mermaid = fs.readFileSync(architectureMmdPath, 'utf8').trim();
    } catch (_) {}
  }

  // 6. Per-repo design-system.md files (Phase B3 writes these per frontend repo)
  //    Full content — the drawer renders markdown and scrolls.
  for (const r of data.repos) {
    if (r.role !== 'frontend') continue;
    const ds = path.join(r.path, 'agent-context', 'design-system.md');
    if (fs.existsSync(ds)) {
      try {
        data.design_systems.push({ repo: r.key, excerpt: fs.readFileSync(ds, 'utf8') });
      } catch (_) {}
    }
  }

  workspaceOverviewCache = { data, mtimes };
  return data;
}

// If `awaiting_input.json` exists in the run dir, the orchestrator is paused
// waiting for a user answer. The file shape is:
//   { since: "ISO8601", phase: "3", gate: "approval", question: "...", context_summary?: "..." }
// Returns null when not waiting.
function readAwaitingInput() {
  const p = awaitingInputPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { parseError: true, rawPath: p };
  }
}

// If `awaiting_claude_approval.json` exists, Claude Code itself (not the
// pipeline) is paused asking the user to approve a tool call. Written by the
// notify-hook.js hook script, cleared on UserPromptSubmit / PostToolUse.
// Shape: { since, tool, command_preview, message }.
function readClaudeApproval() {
  const p = awaitingClaudeApprovalPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { parseError: true, rawPath: p };
  }
}

// Hook errors are surfaced two ways:
//   1. `{run_dir}/hook_error.json`  — written when the hook can resolve a run dir.
//      File shape: { errors: [ { ts, error, context }, ... ] } — last 3 kept.
//   2. global log at ~/.claude/logs/pipeline-view-hook-errors.log — used when the
//      hook can't resolve a run dir (no active runs). Plain text, one line per error.
// We read both and combine; UI renders a subtle red warning icon.
function readHookErrors() {
  const out = [];
  const p = hookErrorPath();
  if (p && fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && Array.isArray(parsed.errors)) {
        for (const e of parsed.errors) out.push({ ts: e.ts, error: e.error, context: e.context, source: 'run' });
      }
    } catch (_) {}
  }
  if (fs.existsSync(GLOBAL_HOOK_ERROR_LOG)) {
    try {
      const lines = fs.readFileSync(GLOBAL_HOOK_ERROR_LOG, 'utf8').trim().split('\n').filter(Boolean);
      // Only the last 3 global entries — same cap as per-run.
      for (const line of lines.slice(-3)) {
        try {
          const parsed = JSON.parse(line);
          out.push({ ts: parsed.ts, error: parsed.error, context: parsed.context, source: 'global' });
        } catch (_) {
          out.push({ ts: null, error: line.slice(0, 400), context: null, source: 'global' });
        }
      }
    } catch (_) {}
  }
  return out.length ? out : null;
}

// ─── Agent name → character role ─────────────────────────────
// Matches both plugin-qualified names (pipecrew:spring-boot-api-implementer)
// and workspace-published names (dal-product-owner, dal-assessor, dal-ux-consultant).
// Matching strategy: substring / suffix match on the role name.
// Order matters: more-specific patterns must come before generic ones that
// would substring-match them (e.g., 'security-consultant' must beat the
// generic 'consultant' fallback in 'ux-consultant'; 'code-reviewer' must
// beat 'reviewer' so a hypothetical "security-reviewer" doesn't steal crit).
const ROLE_PATTERNS = [
  { role: 'pip',     patterns: ['product-owner', 'product-brainstormer'] },
  { role: 'archie',  patterns: ['solution-architect'] },
  { role: 'foreman', patterns: ['task-planner', 'planner'] },
  { role: 'yara',    patterns: ['openapi-spec-editor', 'spec-editor', 'schema-implementer'] },
  { role: 'shield',  patterns: ['security-consultant', 'security-reviewer', 'security-auditor'] },
  { role: 'mira',    patterns: ['ux-consultant', 'ux-reviewer', 'ux-designer'] },
  { role: 'bruno',   patterns: ['spring-boot-api-implementer', 'spring-boot-implementer', 'backend-implementer', 'nestjs-implementer', 'fastapi-implementer', 'django-implementer', 'flask-implementer', 'python-worker-implementer'] },
  { role: 'pixel',   patterns: ['react-feature-implementer', 'react-implementer', 'nextjs-implementer', 'frontend-implementer', 'feature-implementer'] },
  { role: 'echo',    patterns: ['mock-endpoint-implementer', 'node-mock-implementer', 'mock-implementer'] },
  { role: 'stratos', patterns: ['cdk-stack-implementer', 'cdk-implementer', 'infra-implementer', 'ops-implementer', 'terraform-implementer'] },
  { role: 'crit',    patterns: ['spring-boot-code-reviewer', 'react-code-reviewer', 'nestjs-reviewer', 'nextjs-reviewer', 'code-reviewer', 'reviewer'] },
  { role: 'judge',   patterns: ['assessor'] },
  { role: 'scribe',  patterns: ['reporter'] },
  // Loop must come BEFORE sage — the literal `feedback-learner` is more
  // specific than the substring fallback that `context-manager` ends up
  // taking, and we want feedback-learner to resolve to its own character
  // (closes the pyramid at end of run) instead of merging into sage.
  { role: 'loop',    patterns: ['feedback-learner'] },
  { role: 'sage',    patterns: ['context-manager'] },
];

function agentToRole(agentName) {
  if (!agentName) return null;
  const name = agentName.toLowerCase().trim();
  for (const { role, patterns } of ROLE_PATTERNS) {
    for (const p of patterns) {
      if (name === p) return role;
      if (name.endsWith('-' + p)) return role; // dal-assessor, dal-product-owner
      if (name.endsWith(':' + p)) return role; // pipecrew:spring-boot-api-implementer
      if (name.includes(p)) return role;
    }
  }
  return null;
}

const PHASE_TO_ROLE = {
  '1':    'pip',
  '2':    'archie',
  '3':    'yara',
  '4.5':  'foreman',
  '5.5':  'crit',
  '5.75': 'shield',
  '6':    'judge',
  // Phase 7 intentionally omitted — scribe and sage both run there, so we
  // preseed them from Architecture Flags instead and let Phase 7 status
  // drive their lifecycle indirectly through dispatch-log promotion.
};

const DEFAULT_AGENT_NAME = {
  pip:     'product-owner',
  archie:  'solution-architect',
  foreman: 'task-planner',
  yara:    'openapi-spec-editor',
  bruno:   'backend-implementer',
  pixel:   'frontend-implementer',
  mira:    'ux-consultant',
  shield:  'security-consultant',
  echo:    'mock-implementer',
  stratos: 'infra-implementer',
  crit:    'reviewer',
  judge:   'assessor',
  scribe:  'reporter',
  sage:    'context-manager',
  loop:    'feedback-learner',
};

// ─── Utility helpers ─────────────────────────────────────────
function shortRepo(repoPath) {
  if (!repoPath || repoPath === '—' || repoPath.trim() === '') return null;
  return path.basename(repoPath.trim()).replace(/^abvi-/, '');
}

function mapStatus(raw) {
  if (!raw) return 'queued';
  const s = raw.trim().toUpperCase();
  if (s === 'COMPLETED' || s === 'DONE') return 'done';
  if (s === 'IN_PROGRESS' || s === 'IN PROGRESS' || s === 'RUNNING' || s === 'WORKING') return 'working';
  if (s === 'SKIPPED') return 'skipped';
  if (s === 'FAILED' || s === 'BLOCKED') return 'failed';
  // Dispatch-log outcomes carry verbose prose like
  // "success — 27 questions raised" / "success — 3 revisions (...)".
  // Recognise the leading keyword so these rows aren't silently demoted
  // to 'queued' (which makes the Polish-round-6 promotion loop roll up
  // to 'working' and spawn ghost duplicate cards like pip-2).
  const head = s.split(/[\s\u2014\-:—]/)[0];
  if (head === 'SUCCESS' || head === 'OK' || head === 'COMPLETE') return 'done';
  if (head === 'FAIL' || head === 'ERROR' || head === 'TIMEOUT') return 'failed';
  return 'queued';
}

/** Parse a markdown table under a given section header. */
function parseTable(content, sectionHeader) {
  const idx = content.indexOf(sectionHeader);
  if (idx < 0) return [];
  const lines = content.slice(idx).split('\n');
  const rows = [];
  let afterSeparator = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('|')) {
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) { afterSeparator = true; continue; }
      if (afterSeparator) {
        rows.push(line.split('|').slice(1, -1).map(c => c.trim()));
      }
    } else if (afterSeparator) {
      break;
    }
  }
  return rows;
}

// ─── Checkpoints enrichment ──────────────────────────────────
// Returns { orchestratorTokens, retryingAgents: Set<string>, agentMetrics: {agent_type: {tokens, duration}} }.
// orchestratorTokens = sum of orch_since_last.{input,output,cache_read}_tokens
//   across all orch_checkpoint events.
// retryingAgents = agent_type strings that have an unmatched retry event
//   (a retry not yet followed by an agent_end with status: ok).
// agentMetrics = per-agent total_tokens + duration derived from matched
//   agent_start → agent_end pairs (fallback source for ask #1 tokens/duration).
function readCheckpoints() {
  const file = checkpointsPath();
  const result = {
    orchestratorTokens: 0,
    retryingAgents: new Set(),
    agentMetrics: {},
  };
  if (!file || !fs.existsSync(file)) return result;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const pendingRetries = new Map(); // agent_type → last retry event
    const startTs = new Map(); // agent_type → last agent_start ts (for duration fallback)
    for (const line of lines) {
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }
      if (evt.event === 'orch_checkpoint' && evt.orch_since_last) {
        const o = evt.orch_since_last;
        result.orchestratorTokens +=
          (o.input_tokens || 0) +
          (o.output_tokens || 0) +
          (o.cache_read_tokens || 0);
      } else if (evt.event === 'retry') {
        pendingRetries.set(evt.agent_type, evt);
      } else if (evt.event === 'agent_start') {
        if (evt.ts && evt.agent_type) startTs.set(evt.agent_type, evt.ts);
      } else if (evt.event === 'agent_end') {
        if (evt.status === 'ok') pendingRetries.delete(evt.agent_type);
        const agent = evt.agent_type;
        if (agent) {
          const m = result.agentMetrics[agent] || (result.agentMetrics[agent] = { tokens: 0, duration_ms: 0 });
          if (typeof evt.total_tokens === 'number') m.tokens += evt.total_tokens;
          if (typeof evt.duration_ms === 'number') m.duration_ms += evt.duration_ms;
          else if (evt.ts && startTs.has(agent)) {
            const delta = new Date(evt.ts).getTime() - new Date(startTs.get(agent)).getTime();
            if (delta > 0) m.duration_ms += delta;
          }
          startTs.delete(agent);
        }
      }
    }
    for (const a of pendingRetries.keys()) result.retryingAgents.add(a);
  } catch (_) {}
  return result;
}

// Normalize a dispatch-log or character agent name so lookups match across
// formats. Drops trailing " (round descriptor)" suffixes and lowercases.
//   "dal-product-owner (Q&A round)" → "dal-product-owner"
function normalizeAgentName(name) {
  if (!name) return '';
  return String(name).split('(')[0].trim().toLowerCase();
}

// ─── Phase → short-label mapping (Polish round 8) ────────────
// Maps an Agent Dispatch Log "Phase" cell (e.g. "5", "5.5-fix", "5.5-fix-r2")
// to a short chip label + category used for CSS colour theming.
//   impl    → "impl"       (blue)
//   fix-*   → "fix" / "fix-r1" / "fix-r2" … (orange)
//   review  → "review"     (purple)
//   security→ "security"   (red)
//   assess  → "assess"     (green)
//   others  → "requirements"/"arch"/"spec"/"sync"/"plan"/"report" (grey neutral)
// Returns { label, category } or null when the phase is unrecognised / empty.
function mapPhaseToLabel(phase) {
  if (!phase) return null;
  const p = String(phase).trim().toLowerCase();
  if (!p || p === '—') return null;
  // Fix rounds — 5.5-fix, 5.5-fix-r1, 5.5-fix-r2, … (bare "5.5-fix" defaults to r1)
  if (/^5\.5-fix(\b|$|-)/.test(p)) {
    const m = p.match(/-r(\d+)$/);
    const round = m ? m[1] : '1';
    return { label: `fix-r${round}`, category: 'fix' };
  }
  // Plan sub-phases — 4.5-draft, 4.5-adjust, 4.5-adjust-r2, 4.5-persist.
  // Bare 4.5 falls through to the catch-all below as plain 'plan'.
  if (/^4\.5-draft$/.test(p))   return { label: 'plan-draft',   category: 'neutral' };
  if (/^4\.5-adjust(\b|$|-)/.test(p)) {
    const m = p.match(/-r(\d+)$/);
    const round = m ? `-r${m[1]}` : '';
    return { label: `plan-adjust${round}`, category: 'neutral' };
  }
  if (/^4\.5-persist$/.test(p)) return { label: 'plan-persist', category: 'neutral' };
  // Review (phase 5.5 without -fix)
  if (p === '5.5') return { label: 'review', category: 'review' };
  // Security (phase 5.75)
  if (p === '5.75') return { label: 'security', category: 'security' };
  // Assessment (phase 6)
  if (p === '6') return { label: 'assess', category: 'assess' };
  // Implementation (5, 5a, 5b, 5c, 5d, …)
  if (/^5[a-z]?$/.test(p)) return { label: 'impl', category: 'impl' };
  // Misc early phases — muted grey neutral.
  if (p === '1')   return { label: 'requirements', category: 'neutral' };
  if (p === '2')   return { label: 'arch',         category: 'neutral' };
  if (p === '3')   return { label: 'spec',         category: 'neutral' };
  if (p === '4')   return { label: 'sync',         category: 'neutral' };
  if (p === '4.5') return { label: 'plan',         category: 'neutral' };
  if (p === '7')   return { label: 'report',       category: 'neutral' };
  if (p === '8')   return { label: 'publish',      category: 'neutral' };
  // Phase 3 sub-phases (3a contract, 3b spec) — both spec-editing work.
  if (p === '3a' || p === '3b') return { label: 'spec', category: 'neutral' };
  // Unknown — pass through trimmed value for visibility.
  return { label: p, category: 'neutral' };
}

// ─── Dispatch-log Agent column → repo token (Polish round 8 follow-up) ──
// The Agent column carries a parenthesised qualifier that is usually the
// short repo name, e.g. "spring-boot-api-implementer (backoffice-service
// PRIMARY)" or "cdk-stack-implementer (ops-platform)". Sometimes it's a
// round-descriptor instead ("dal-product-owner (Q&A round)") — in that
// case callers fall back to role-only matching. We return the first
// whitespace-separated token inside the parens, lowercased, so "backoffice-
// service PRIMARY" → "backoffice-service".
function extractRepoFromAgent(agentName) {
  const m = String(agentName || '').match(/\(([^)]+)\)/);
  if (!m) return null;
  const first = m[1].trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

// Loose repo match — the dispatch-log parenthetical can be shorter than
// the character's full repo label (e.g. "frontend" in the dispatch log
// vs "pms-frontend" from the Implementation-Tasks repo column). Substring
// in either direction is enough for the per-repo disambiguation we need;
// character repos that share a common suffix/prefix would be ambiguous
// anyway and would have fallen through to role-only matching in the old
// code too.
function repoMatches(extracted, charRepo) {
  if (!extracted || !charRepo) return false;
  const a = String(extracted).toLowerCase();
  const b = String(charRepo).toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

// Append a phase chip to the character's ordered phase list, deduping the
// immediate predecessor so multi-round dispatches of the same phase (e.g.
// pip's three phase-1 rows all mapping to "requirements") collapse to one
// chip instead of stacking.
function pushPhaseChip(phasesByCharId, charId, label, category) {
  if (!charId || !label) return;
  const list = phasesByCharId[charId] || (phasesByCharId[charId] = []);
  const last = list[list.length - 1];
  if (last && last.label === label) return;
  list.push({ label, category: category || 'neutral' });
}

// Format ms as a compact "Hh Mm" / "Mm Ss" / "Ss" string.
function formatDurationMs(ms) {
  if (!ms || ms <= 0) return '';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

// ─── Architecture Flags parser ───────────────────────────────
// Parses the "## Architecture Flags" bullet-list section. Values are
// normalised to lowercase strings; booleans use loose matching ("yes",
// "likely yes" → true; "no", "tbd", "—" → false; unknown → false).
//
// Example input:
//   ## Architecture Flags
//   - **Affected Services**: publisher, backoffice
//   - **Frontend Required**: Yes
//   - **Mock Required**: likely Yes
//   - **Infra Required**: No
//
// Returns: {
//   affectedServices: ['publisher', 'backoffice'],
//   frontendRequired: true,
//   mockRequired: true,
//   infraRequired: false,
//   securityRequired: null,   // absent from most scratchpads — null means unknown
// }
function parseArchFlags(content) {
  const out = {
    affectedServices: [],
    frontendRequired: false,
    mockRequired: false,
    infraRequired: false,
    securityRequired: null,
  };
  const idx = content.indexOf('## Architecture Flags');
  if (idx < 0) return out;
  const slice = content.slice(idx);
  const endIdx = slice.indexOf('\n## ', 1);
  const section = endIdx > 0 ? slice.slice(0, endIdx) : slice;
  const lines = section.split('\n');
  const truthy = v => {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === '—' || s === 'no' || s === 'tbd' || s === 'none' || s === 'n/a') return false;
    return /yes|true|required/.test(s);
  };
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s*\*\*([^*]+)\*\*\s*:\s*(.+)\s*$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'affected services') {
      // Orchestrators write this in two shapes:
      //   simple : "publisher, backoffice"
      //   prose  : "publisher (presign/upload), backoffice (content-team
      //            browse), user-management (new role). Not affected:
      //            contract."
      // We normalise by: (1) dropping any trailing "Not affected: …" clause;
      // (2) splitting on commas; (3) stripping each segment's parenthetical
      // and any trailing period; (4) keeping only the leading token (first
      // word before whitespace) — that's the service name. "TBD" /
      // "architect decides" collapse to an empty list.
      if (/tbd|architect decides/i.test(val)) { out.affectedServices = []; continue; }
      const stripped = val.replace(/\bnot\s+affected\s*:.*$/i, '').trim();
      out.affectedServices = stripped
        .split(',')
        .map(seg => seg.replace(/\s*\([^)]*\)/g, '') // drop (parenthetical)
                       .replace(/\.+\s*$/, '')         // drop trailing period
                       .trim()
                       .split(/\s+/)[0] || '')          // first token only
        .map(s => s.trim())
        .filter(Boolean);
    } else if (key === 'frontend required') {
      out.frontendRequired = truthy(val);
    } else if (key === 'mock required') {
      out.mockRequired = truthy(val);
    } else if (key === 'infra required') {
      out.infraRequired = truthy(val);
    } else if (key === 'security required' || key === 'security review required') {
      out.securityRequired = truthy(val);
    }
  }
  return out;
}

// ─── Scratchpad parser ───────────────────────────────────────
function parseScratchpad(content) {
  const characters = [];
  const seen = new Set();
  // Polish round 8 follow-up — ordered list of phase chips per character id.
  // Keyed by character.id (NOT role) so e.g. `stratos` and `stratos-2` can
  // carry independent phase histories even though they share the same role.
  // Populated from three sources in order: Phase Status initial phase,
  // Implementation Tasks "impl" chip, Agent Dispatch Log subsequent phases.
  const phasesByCharId = {};
  // Per-character fix-round counter. Bare "5.5-fix" dispatch-log rows have no
  // -rN suffix so we infer the round number from transitions into a fix phase
  // after a non-fix phase. Keyed by charId (not role) because two different
  // `stratos` cards can independently enter a first fix round without bumping
  // each other's counter.
  const fixRoundByCharId = {};

  // Phase Status — orchestrator-level characters (one per fixed phase)
  const phaseRows = parseTable(content, '## Phase Status');
  for (const cells of phaseRows) {
    if (cells.length < 2) continue;
    const match = cells[0].match(/^(\d+(?:\.\d+)?)\.\s*(.+)$/);
    if (!match) continue;
    const phase = match[1];
    const role = PHASE_TO_ROLE[phase];
    if (!role) continue;
    const status = mapStatus(cells[1]);
    if (status === 'skipped') continue;
    seen.add(role);
    characters.push({
      id: role,
      role,
      phase,
      agent: DEFAULT_AGENT_NAME[role],
      repo: null,
      status,
    });
    // Seed the phase sequence with the char's initial phase label. Skipping
    // for queued-ish rows isn't needed here: mapStatus has already filtered
    // out 'skipped', and 'queued' Phase-Status rows don't exist (every row
    // is COMPLETED / IN_PROGRESS / PENDING — PENDING maps to 'queued' via
    // mapStatus, but we still want the initial phase for the UI).
    const mapped = mapPhaseToLabel(phase);
    if (mapped && status !== 'queued') {
      pushPhaseChip(phasesByCharId, role, mapped.label, mapped.category);
    }
  }

  // ─── Queue pre-seeding (Polish round 6) ────────────────────
  // The Phase Status loop above only covers roles listed in PHASE_TO_ROLE
  // (pip, archie, yara, crit, judge). Stage-specific roles — per-service
  // implementers (bruno/pixel/echo/stratos), security-consultant (shield),
  // ux-consultant (mira), reporter (scribe), context-manager (sage) — only
  // appear in characters[] once they have a real Implementation-Tasks row
  // or an Agent-Dispatch-Log entry. That makes the "queue" zone show only
  // crit + judge at Phase 1, which is wrong — the user should see the
  // whole crew that's going to run, ghosted as queued, from the start.
  //
  // Fix: parse Architecture Flags and pre-seed a queued character for
  // every role the architect's plan implies. The later Implementation
  // Tasks / Dispatch Log loops merge by role-id, so the queued entry is
  // upgraded to working/done when real activity arrives (no duplicates).
  const flags = parseArchFlags(content);
  const preseed = [];
  // Backend implementers — one bruno per affected service that looks like
  // a backend (heuristic: NOT ending in -frontend / -ui / -web / -mock /
  // -infra / -cdk). If no services listed yet (Phase 1 before architect),
  // fall back to one bruno so the queue has SOME backend presence.
  const backendServices = flags.affectedServices.filter(s => {
    const n = s.toLowerCase();
    return !/(frontend|-ui\b|-web\b|mock|infra|cdk|ops)/.test(n);
  });
  if (backendServices.length > 0) {
    backendServices.forEach((svc, i) => {
      preseed.push({
        id: i === 0 ? 'bruno' : `bruno-${i + 1}`,
        role: 'bruno', phase: '5', agent: DEFAULT_AGENT_NAME.bruno,
        repo: shortRepo(svc), status: 'queued',
      });
    });
  } else if (flags.affectedServices.length === 0) {
    // No services parsed (TBD or section missing) — still show one bruno
    // so the crew reads as "backend will happen" rather than "only crit/judge".
    preseed.push({
      id: 'bruno', role: 'bruno', phase: '5',
      agent: DEFAULT_AGENT_NAME.bruno, repo: null, status: 'queued',
    });
  }
  // Frontend implementer — one pixel + one mira if frontend required.
  if (flags.frontendRequired) {
    preseed.push({
      id: 'pixel', role: 'pixel', phase: '5',
      agent: DEFAULT_AGENT_NAME.pixel, repo: null, status: 'queued',
    });
    preseed.push({
      id: 'mira', role: 'mira', phase: '5',
      agent: DEFAULT_AGENT_NAME.mira, repo: null, status: 'queued',
    });
  }
  // Mock implementer — one echo if mock required.
  if (flags.mockRequired) {
    preseed.push({
      id: 'echo', role: 'echo', phase: '5',
      agent: DEFAULT_AGENT_NAME.echo, repo: null, status: 'queued',
    });
  }
  // Infra implementer — one stratos if infra required.
  if (flags.infraRequired) {
    preseed.push({
      id: 'stratos', role: 'stratos', phase: '5',
      agent: DEFAULT_AGENT_NAME.stratos, repo: null, status: 'queued',
    });
  }
  // Security consultant — default to always-queued (every /deliver run goes
  // through Phase 5.75 unless explicitly skipped). If the flag is present
  // and falsy, suppress — but an absent flag (null) means "assume yes".
  if (flags.securityRequired !== false) {
    preseed.push({
      id: 'shield', role: 'shield', phase: '5.75',
      agent: DEFAULT_AGENT_NAME.shield, repo: null, status: 'queued',
    });
  }
  // Phase 7 — reporter (scribe) and context-manager (sage) always run.
  preseed.push({
    id: 'scribe', role: 'scribe', phase: '7',
    agent: DEFAULT_AGENT_NAME.scribe, repo: null, status: 'queued',
  });
  preseed.push({
    id: 'sage', role: 'sage', phase: '7',
    agent: DEFAULT_AGENT_NAME.sage, repo: null, status: 'queued',
  });
  // Phase 8 — feedback-learner (loop). Only fires if the user opts in to
  // feedback at Step 8.6, so it commonly stays queued. When it DOES finish
  // (dispatch-log entry with outcome=success), the front-end treats that as
  // the run's true terminal event and closes the pyramid (all 10 blocks
  // visible). Without this preseed, /learn-driven runs would have no card
  // to promote.
  preseed.push({
    id: 'loop', role: 'loop', phase: '8',
    agent: DEFAULT_AGENT_NAME.loop, repo: null, status: 'queued',
  });
  // Merge preseeded chars: skip any whose id / role is already present
  // from Phase Status (don't stomp a working/done pip, archie, etc.).
  for (const p of preseed) {
    if (seen.has(p.id)) continue;
    // Also skip if any existing character already has this role in a non-
    // queued state — a working bruno from a task row would beat a queued
    // preseeded bruno, but the order below (preseed runs BEFORE task rows)
    // means this branch is only defensive for future re-ordering.
    const clash = characters.find(c => c.role === p.role && c.status !== 'queued');
    if (clash) continue;
    seen.add(p.id);
    characters.push(p);
  }

  // Implementation Tasks — one character per agent per row.
  // Task rows are authoritative: they carry the actual status + repo + agent-
  // name variant. They merge into any pre-seeded queued character of the
  // same role (first task row replaces the first preseed, second task row
  // replaces bruno-2, etc.) so a role doesn't end up with both a queued
  // twin AND a working card.
  const taskRows = parseTable(content, '## Implementation Tasks');
  const roleCounts = {};
  for (const cells of taskRows) {
    if (cells.length < 5) continue;
    const repo      = cells[2] || '';
    const agentCol  = cells[3] || '';
    const statusRaw = cells[4] || '';
    const status = mapStatus(statusRaw);
    if (status === 'skipped') continue;
    const agentNames = agentCol.split(/[+&,/]/).map(s => s.trim()).filter(Boolean);
    for (const name of agentNames) {
      const role = agentToRole(name);
      if (!role) continue;
      roleCounts[role] = (roleCounts[role] || 0) + 1;
      const id = roleCounts[role] === 1 ? role : `${role}-${roleCounts[role]}`;

      // If a character with this id already exists (from Phase Status or
      // from queue pre-seeding), replace it with the more specific task
      // row — keep the position in characters[] to preserve render order.
      const existingIdx = characters.findIndex(c => c.id === id);
      if (existingIdx !== -1) {
        characters[existingIdx] = {
          id,
          role,
          phase: '5',
          agent: name,
          repo: shortRepo(repo),
          status,
        };
        // Task row guarantees the agent did (or is doing) implementation
        // work, so seed the phase sequence with "impl" even if no dispatch-
        // log row exists yet. Dispatch-log entries processed later append
        // subsequent phases (fix-r1, …) on top of this.
        if (status !== 'queued') {
          pushPhaseChip(phasesByCharId, id, 'impl', 'impl');
        }
        continue;
      }
      seen.add(id);
      characters.push({
        id,
        role,
        phase: '5',
        agent: name,
        repo: shortRepo(repo),
        status,
      });
      if (status !== 'queued') {
        pushPhaseChip(phasesByCharId, id, 'impl', 'impl');
      }
    }
  }

  // Agent Dispatch Log — per-agent tokens + duration
  // Columns: | # | Phase | Agent | Task ID | Duration | Tokens | Outcome |
  //          cells[0] cells[1] cells[2] cells[3]  cells[4]   cells[5]  cells[6]
  // We index by normalized agent name AND by role — dispatch names can carry
  // parenthesized round descriptors (e.g. "dal-product-owner (Q&A round)")
  // that wouldn't match the bare character.agent string.
  const dispatchRows = parseTable(content, '## Agent Dispatch Log');
  const agentMetrics = {};   // normalizedName → metrics
  const roleMetrics  = {};   // role → aggregated metrics (fallback when name differs)
  // Track the per-role dispatch count + worst-case (most-recent) outcome so
  // we can promote queued preseeded characters for stage-specific roles
  // that never appear in Implementation Tasks (shield / scribe / sage /
  // workspace-specific consultants).
  const dispatchByRole = {}; // role → { count, outcomes: [statuses…] }
  // Polish round 8 follow-up — resolve each dispatch row to a specific
  // character by (role, repo) so `stratos` (ops-platform) and `stratos-2`
  // (notifications-service) don't share a phase history. The parenthetical
  // in the Agent column (e.g. "cdk-stack-implementer (ops-platform)")
  // carries the repo token; `extractRepoFromAgent` + `repoMatches` handle
  // the fuzzy match against each character's shortRepo. Row ordering in the
  // dispatch table is chronological, so appending to each char's phase list
  // in table order yields the correct oldest→newest chip sequence.
  for (const cells of dispatchRows) {
    if (cells.length < 6) continue;
    const phaseCell   = cells[1] || '';
    const agentName   = cells[2] || '';
    const durationStr = cells[4] || '';
    const tokensStr   = cells[5] || '';
    const outcomeStr  = cells[6] || '';
    if (!agentName || agentName === '—') continue;
    const norm = normalizeAgentName(agentName);
    const role = agentToRole(norm);
    // Resolve dispatch row → character id. Preference order:
    //   1. (role, repo) — exact character (extracted repo matches character.repo).
    //   2. (role) only — first character of that role (fallback for rows
    //      whose parenthetical is a round descriptor, not a repo, e.g.
    //      "(Q&A round)" / "(re-review)").
    let targetCharId = null;
    if (role) {
      const extractedRepo = extractRepoFromAgent(agentName);
      const rolChars = characters.filter(c => c.role === role);
      if (extractedRepo) {
        const match = rolChars.find(c => repoMatches(extractedRepo, c.repo));
        if (match) targetCharId = match.id;
      }
      if (!targetCharId && rolChars.length > 0) targetCharId = rolChars[0].id;
    }
    // Append mapped phase chip to the resolved character. Bare "5.5-fix"
    // (no -rN suffix) consults the per-character round counter so a second
    // fix cycle shows "fix-r2".
    if (targetCharId && phaseCell && phaseCell !== '—') {
      const mapped = mapPhaseToLabel(phaseCell);
      if (mapped) {
        let label = mapped.label;
        if (mapped.category === 'fix') {
          const bare = !/-r\d+$/.test(phaseCell.trim().toLowerCase());
          const rec = fixRoundByCharId[targetCharId] || (fixRoundByCharId[targetCharId] = { round: 0, lastWasFix: false });
          if (!rec.lastWasFix) rec.round++;
          rec.lastWasFix = true;
          if (bare) label = `fix-r${rec.round}`;
        } else if (fixRoundByCharId[targetCharId]) {
          fixRoundByCharId[targetCharId].lastWasFix = false;
        }
        pushPhaseChip(phasesByCharId, targetCharId, label, mapped.category);
      }
    }
    const m = agentMetrics[norm] || (agentMetrics[norm] = {
      totalTokens: 0, totalDuration: '', dispatches: 0,
    });
    m.dispatches++;
    const tokMatch = tokensStr.match(/([\d.]+)\s*([KMkm])?/);
    if (tokMatch) {
      let v = parseFloat(tokMatch[1]);
      const unit = (tokMatch[2] || '').toUpperCase();
      if (unit === 'K') v *= 1000;
      else if (unit === 'M') v *= 1000000;
      m.totalTokens += v;
    }
    if (durationStr && durationStr !== '—') m.totalDuration = durationStr;
    if (role) {
      const rm = roleMetrics[role] || (roleMetrics[role] = { totalTokens: 0, totalDuration: '', dispatches: 0 });
      rm.dispatches++;
      if (tokMatch) {
        let v = parseFloat(tokMatch[1]);
        const unit = (tokMatch[2] || '').toUpperCase();
        if (unit === 'K') v *= 1000;
        else if (unit === 'M') v *= 1000000;
        rm.totalTokens += v;
      }
      if (durationStr && durationStr !== '—') rm.totalDuration = durationStr;
      const d = dispatchByRole[role] || (dispatchByRole[role] = { count: 0, outcomes: [] });
      d.count++;
      d.outcomes.push(mapStatus(outcomeStr));
    }
  }

  // ─── Promote queued preseeds based on dispatch log (Polish round 6) ──
  // Stage-specific agents (shield, scribe, sage, plus any extra bruno/echo/
  // stratos beyond task rows) don't have an Implementation Tasks entry, so
  // the earlier merge pass never flips their status. Promote them here:
  //   - If any dispatch outcome for the role is 'working', show the card
  //     as working (active run).
  //   - Else if all dispatches completed (done), show the card as done.
  //   - Else if any failed, show the card as failed.
  // Also grow multi-dispatch roles (e.g., two security-consultant dispatches
  // for two repos → shield + shield-2) by adding extra queued/working copies
  // when the dispatch count exceeds the number of existing characters of
  // that role.
  // Singleton roles — one dispatch per phase by design. Retries or multi-
  // round prompts within a single phase (e.g. product-owner Q&A + final doc,
  // or an architect re-plan) must NOT spawn pip-2 / archie-2 ghost cards.
  // Shield (security) and crit (code review) are phase-managed too but
  // legitimately run per-repo (one reviewer per affected service + one for
  // the frontend per phase-5.5-code-review.md), so they can grow — they
  // are NOT listed here.
  const SINGLETON_ROLES = new Set(['pip', 'archie', 'yara', 'judge']);
  for (const [role, info] of Object.entries(dispatchByRole)) {
    const existing = characters.filter(c => c.role === role);
    const wantCount = SINGLETON_ROLES.has(role) ? Math.min(info.count, Math.max(existing.length, 1)) : info.count;
    // Create additional character slots if dispatches outnumber existing chars.
    while (characters.filter(c => c.role === role).length < wantCount) {
      const n = characters.filter(c => c.role === role).length;
      const id = n === 0 ? role : `${role}-${n + 1}`;
      if (seen.has(id)) break; // safety — avoid infinite loop on name clash
      seen.add(id);
      characters.push({
        id, role,
        phase: existing[0]?.phase || '5',
        agent: existing[0]?.agent || DEFAULT_AGENT_NAME[role] || role,
        repo: null,
        status: 'queued',
      });
    }
    // Roll up outcomes: any-failed → failed, any-working → working, else done.
    const outcomes = info.outcomes;
    let rolled = 'done';
    if (outcomes.some(o => o === 'failed')) rolled = 'failed';
    else if (outcomes.some(o => o === 'working')) rolled = 'working';
    else if (outcomes.every(o => o === 'done')) rolled = 'done';
    else rolled = 'working'; // mixed / unknown — treat as in-flight
    // Flip each queued character of this role up to one status level.
    // Two cases:
    //   1. queued → rolled — first promotion from preseed / fresh spawn.
    //   2. done → working — re-dispatch (fix round). When the dispatch log
    //      has a current in_progress entry alongside completed ones, the
    //      character is actively running again (e.g. Phase 5.5-fix re-runs
    //      the implementer that already shipped Phase 5). The fix-round
    //      phase chip already disambiguates which dispatch is current; we
    //      mirror that in the character status so it shows up in the
    //      Currently Building zone again.
    for (const c of characters) {
      if (c.role !== role) continue;
      if (c.status === 'queued') {
        c.status = rolled;
      } else if (c.status === 'done' && (rolled === 'working' || rolled === 'failed')) {
        c.status = rolled;
      }
    }
  }

  // Checkpoints enrichment — orchestrator tokens + retry flags + agent metrics fallback
  const { orchestratorTokens, retryingAgents, agentMetrics: cpMetrics } = readCheckpoints();

  // Per-character metric resolution. Prefer scratchpad (orchestrator's canonical
  // summary with round-descriptor granularity). Fall back to role-level scratchpad
  // aggregation for name-mismatches, then finally to checkpoints agent_end events.
  for (const c of characters) {
    const norm = normalizeAgentName(c.agent);
    const byName = agentMetrics[norm];
    const byRole = roleMetrics[c.role];
    const cp = cpMetrics[norm] || cpMetrics[c.agent];
    let tokens = 0, duration = '', dispatches = 0;
    if (byName && byName.totalTokens > 0) {
      tokens = byName.totalTokens; duration = byName.totalDuration; dispatches = byName.dispatches;
    } else if (byRole && byRole.totalTokens > 0) {
      tokens = byRole.totalTokens; duration = byRole.totalDuration; dispatches = byRole.dispatches;
    } else if (cp && cp.tokens > 0) {
      tokens = cp.tokens; duration = formatDurationMs(cp.duration_ms); dispatches = 1;
    }
    c.tokens     = tokens;
    c.duration   = duration;
    c.dispatches = dispatches;
    c.retrying   = retryingAgents.has(c.agent) || retryingAgents.has(norm);

    // Polish round 8 follow-up — per-character phase sequence. Emit the
    // ordered chip list as `phases` + parallel `phaseCategories` so the UI
    // can render one pill per entry. `activePhaseIndex` points at the
    // currently-in-progress chip (last entry) when the character is
    // working; -1 otherwise. Queued characters have no phase history and
    // therefore emit empty arrays, which the UI treats the same as the
    // old "no chip" state.
    //
    // Fallback: a character that never appeared in the dispatch log AND
    // wasn't seeded from Phase Status / Implementation Tasks still gets a
    // chip derived from its static `phase` field — keeps the preseed
    // promotion path (e.g. dispatch-only shield or scribe) from showing
    // an empty chip strip.
    let list = phasesByCharId[c.id] || [];
    if (list.length === 0 && c.status !== 'queued' && c.phase) {
      const mapped = mapPhaseToLabel(c.phase);
      if (mapped) list = [{ label: mapped.label, category: mapped.category }];
    }
    if (list.length > 0) {
      c.phases = list.map(p => p.label);
      c.phaseCategories = list.map(p => p.category);
      c.activePhaseIndex = c.status === 'working' ? list.length - 1 : -1;
      // Backward-compat: keep the single-chip fields populated with the
      // latest entry so older UI builds / /state consumers still work.
      const latest = list[list.length - 1];
      c.phaseLabel = latest.label;
      c.phaseCategory = latest.category;
    } else {
      c.phases = [];
      c.phaseCategories = [];
      c.activePhaseIndex = -1;
    }
  }

  const currentRunId = resolveRunId();
  return {
    workspace,
    runId: currentRunId,
    featureName: featureNameFromRunId(currentRunId),
    scratchpadPath: scratchpadPath(),
    updatedAt: new Date().toISOString(),
    characters,
    orchestratorTokens,
    totalAgentTokens: characters.reduce((s, c) => s + (c.tokens || 0), 0),
    awaitingInput: readAwaitingInput(),
    claudeApproval: readClaudeApproval(),
    hookErrors: readHookErrors(),
  };
}

// Extract the human-friendly feature slug from a run_id like
// "2026-04-15-200215-contract-view-and-list" → "contract-view-and-list".
// Keeps everything after the first YYYY-MM-DD-HHMMSS- prefix.
function featureNameFromRunId(id) {
  if (!id) return null;
  const m = id.match(/^\d{4}-\d{2}-\d{2}-\d{6}-(.+)$/);
  return m ? m[1] : id;
}

function getState() {
  const file = scratchpadPath();
  const rid = resolveRunId();
  const fname = featureNameFromRunId(rid);
  if (!file) {
    return {
      workspace,
      runId: null,
      featureName: null,
      scratchpadPath: null,
      updatedAt: new Date().toISOString(),
      noRun: true,
      characters: [
        { id: 'pip',    role: 'pip',    agent: 'product-owner',       status: 'queued', repo: null, phase: null },
        { id: 'archie', role: 'archie', agent: 'solution-architect',  status: 'queued', repo: null, phase: null },
        { id: 'yara',   role: 'yara',   agent: 'openapi-spec-editor', status: 'queued', repo: null, phase: null },
        { id: 'judge',  role: 'judge',  agent: 'assessor',            status: 'queued', repo: null, phase: null },
      ],
    };
  }
  if (!fs.existsSync(file)) {
    return {
      workspace,
      runId: rid,
      featureName: fname,
      scratchpadPath: file,
      updatedAt: new Date().toISOString(),
      noScratchpadYet: true,
      characters: [],
      awaitingInput: readAwaitingInput(),
      claudeApproval: readClaudeApproval(),
      hookErrors: readHookErrors(),
    };
  }
  try {
    return parseScratchpad(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { workspace, runId: rid, featureName: fname, error: e.message, characters: [] };
  }
}

// ─── HTTP + SSE server ───────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const clients = new Set();

function broadcast() {
  const state = JSON.stringify(getState());
  for (const res of clients) {
    try { res.write(`data: ${state}\n\n`); } catch (_) {}
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      html = html.replace('/*INITIAL_STATE*/', 'window.INITIAL_STATE = ' + JSON.stringify(getState()) + ';');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Failed to read index.html: ' + e.message);
    }
  } else if (req.url === '/state' || req.url === '/state.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getState(), null, 2));
  } else if (req.url === '/workspace-overview' || req.url === '/workspace-overview.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readWorkspaceOverview(), null, 2));
  } else if (req.url.startsWith('/learn-run-detail')) {
    // Lazy-loaded full detail for one /learn run. Query: ?run_id=<id>
    try {
      const url = new URL(req.url, 'http://localhost');
      const runId = url.searchParams.get('run_id');
      if (!runId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing run_id query parameter' }));
        return;
      }
      const learnRunsDir = path.join(WORKSPACE_ROOT, workspace, 'runs', 'learn');
      const validIds = fs.existsSync(learnRunsDir)
        ? fs.readdirSync(learnRunsDir).filter(d => {
            const dirPath = path.join(learnRunsDir, d);
            try { return fs.statSync(dirPath).isDirectory(); } catch (_) { return false; }
          })
        : [];
      if (!validIds.includes(runId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'run_id not found', run_id: runId }));
        return;
      }
      const detail = readLearnRunDetail(learnRunsDir, runId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith('/deliver-run-detail')) {
    // Lazy-loaded full detail for one /deliver run. Query: ?run_id=<id>
    // Validates the run_id against the actual directory listing — no
    // path traversal possible.
    try {
      const url = new URL(req.url, 'http://localhost');
      const runId = url.searchParams.get('run_id');
      if (!runId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing run_id query parameter' }));
        return;
      }
      const deliverRunsDir = path.join(WORKSPACE_ROOT, workspace, 'runs', 'deliver');
      // Whitelist check: run_id must be a real directory under runs/deliver/
      const validIds = fs.existsSync(deliverRunsDir)
        ? fs.readdirSync(deliverRunsDir).filter(d => fs.existsSync(path.join(deliverRunsDir, d, 'scratchpad.md')))
        : [];
      if (!validIds.includes(runId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'run_id not found', run_id: runId }));
        return;
      }
      const detail = readDeliverRunDetail(deliverRunsDir, runId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/vendor/mermaid.min.js' || req.url === '/vendor/marked.min.js') {
    const fname = req.url.slice('/vendor/'.length);
    try {
      const js = fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', fname));
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(js);
    } catch (e) {
      res.writeHead(404);
      res.end(fname + ' not found — re-run the plugin install to vendor it.');
    }
  } else if (req.url === '/hook-errors') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: readHookErrors() || [] }, null, 2));
  } else if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(getState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── File watcher ────────────────────────────────────────────
// Watches the run directory so both scratchpad.md and checkpoints.jsonl trigger broadcasts.
function startWatching() {
  const dir = runDir();
  if (!dir || !fs.existsSync(dir)) {
    console.log(`[watch] waiting for run dir under ${runsDir()}/ …`);
    const poll = setInterval(() => {
      if (runDir() && fs.existsSync(runDir())) {
        clearInterval(poll);
        startWatching();
      }
    }, 1000);
    return;
  }
  try {
    fs.watch(dir, { recursive: false }, (_event, filename) => {
      if (filename === 'scratchpad.md' ||
          filename === 'checkpoints.jsonl' ||
          filename === 'awaiting_input.json' ||
          filename === 'awaiting_claude_approval.json' ||
          filename === 'hook_error.json') {
        broadcast();
      }
    });
    // Belt-and-suspenders: also poll these files in case fs.watch misses events.
    for (const name of ['scratchpad.md', 'checkpoints.jsonl', 'awaiting_input.json', 'awaiting_claude_approval.json', 'hook_error.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try { fs.watchFile(p, { interval: 500 }, () => broadcast()); } catch (_) {}
      }
    }
    // Poll the global hook-error log too — watchFile only works if the file
    // already exists, so we set it up here but guard the path.
    try {
      if (fs.existsSync(GLOBAL_HOOK_ERROR_LOG)) {
        fs.watchFile(GLOBAL_HOOK_ERROR_LOG, { interval: 1000 }, () => broadcast());
      }
    } catch (_) {}
    console.log(`[watch] tracking ${dir}`);
  } catch (e) {
    console.error('[watch] failed:', e.message);
  }
}

// ─── Launch ──────────────────────────────────────────────────
function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function tryListen(p, retries) {
  server.listen(p, '127.0.0.1', () => {
    port = p;
    const url = `http://127.0.0.1:${p}`;
    const id = resolveRunId();
    console.log(`\n  🎨 Pipeline View — ${workspace}${id ? ' / ' + id : ' / (waiting for run)'}`);
    console.log(`     Live at ${url}`);
    console.log(`     Watching ${runDir() || '(run dir not created yet)'}`);
    console.log(`     Press Ctrl+C to stop.\n`);
    startWatching();
    openBrowser(url);
  });
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      server.removeAllListeners('error');
      console.log(`[port ${p} in use — trying ${p + 1}]`);
      tryListen(p + 1, retries - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`No free port in range ${port}-${port + 10}. Exiting.`);
      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

// ─── Auto-kill existing site-view for the same (workspace, run_id) ────────
//
// Before listening, scan the well-known port range for any other site-view
// process serving the SAME workspace + run_id and kill it. This makes
// re-running /deliver, /site-view, or pre-flight idempotent — a stale
// server from a prior session won't sit around showing outdated state.
//
// Servers for OTHER (workspace, run_id) combos are left alone — they
// represent legitimate parallel runs.
//
// Mirrors the probe + kill logic of skills/siteview-cleanup/cleanup.js.
function probePortForSiteview(p) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: p, path: '/state', timeout: 600 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const s = JSON.parse(data);
            if (s && Object.prototype.hasOwnProperty.call(s, 'runId') && Array.isArray(s.characters)) {
              resolve({ port: p, runId: s.runId || '', workspace: s.workspace || '' });
            } else {
              resolve(null);
            }
          } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getPidOnPort(p) {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const re = new RegExp(`127\\.0\\.0\\.1:${p}\\s.*LISTENING\\s+(\\d+)`, 'i');
      const m = out.match(re);
      return m ? m[1] : null;
    } else {
      try {
        const out = execSync(`lsof -iTCP:${p} -sTCP:LISTEN -t`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return out || null;
      } catch (_) {
        const out = execSync(`ss -ltnp 2>/dev/null | awk '$4 ~ /:${p}$/ {print $7}'`, { encoding: 'utf8' }).trim();
        const m = out.match(/pid=(\d+)/);
        return m ? m[1] : null;
      }
    }
  } catch (_) { return null; }
}

function killPid(pid) {
  try {
    if (os.platform() === 'win32') {
      execSync(`powershell -Command "Stop-Process -Id ${pid} -Force -ErrorAction Stop"`, { stdio: 'pipe' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
    }
    return true;
  } catch (_) { return false; }
}

async function killExistingSameRun() {
  const targetWorkspace = workspace;
  const targetRunId = resolveRunId();  // may be null if no run dir yet
  if (!targetWorkspace) return 0;

  const ports = [];
  for (let p = 5173; p <= 5195; p++) ports.push(p);

  let probes;
  try {
    probes = await Promise.all(ports.map(probePortForSiteview));
  } catch (_) {
    return 0;  // probe failure shouldn't block startup
  }

  // Match policy: same workspace AND (same run_id OR our run_id is unknown).
  // We refuse to kill cross-workspace servers, and we refuse to kill across
  // different run_ids when both sides have one.
  const matches = probes.filter(r => {
    if (!r) return false;
    if (r.workspace !== targetWorkspace) return false;
    if (targetRunId && r.runId && r.runId !== targetRunId) return false;
    return true;
  });

  if (matches.length === 0) return 0;

  let killed = 0;
  for (const m of matches) {
    const pid = getPidOnPort(m.port);
    if (!pid) {
      console.log(`[startup] Found stale site-view at :${m.port} (run=${m.runId || 'unknown'}) but couldn't resolve PID — skipping.`);
      continue;
    }
    if (killPid(pid)) {
      console.log(`[startup] Killed existing site-view at :${m.port} (pid=${pid}, run=${m.runId || 'unknown'}).`);
      killed++;
    } else {
      console.log(`[startup] Tried to kill site-view at :${m.port} (pid=${pid}) but the kill failed — proceeding anyway.`);
    }
  }
  if (killed > 0) {
    // Give the OS a moment to release the listening socket before we bind.
    await new Promise(r => setTimeout(r, 250));
  }
  return killed;
}

(async () => {
  try {
    await killExistingSameRun();
  } catch (e) {
    // Non-fatal — log and continue. Worst case, tryListen's existing
    // EADDRINUSE handler hops to the next port.
    console.log(`[startup] Pre-bind cleanup hit an error (continuing): ${e.message}`);
  }
  tryListen(port, 10);
})();

process.on('SIGINT', () => {
  console.log('\n  Pipeline View stopped.');
  server.close();
  process.exit(0);
});
