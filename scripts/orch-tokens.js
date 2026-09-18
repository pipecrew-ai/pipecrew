#!/usr/bin/env node
'use strict';
/**
 * orch-tokens.js — deterministically compute a run's ORCHESTRATOR (main-loop)
 * token overhead by summing the session transcript's own assistant usage.
 *
 * WHY: the old `orch_checkpoint` mechanism asked the orchestrator to
 * byte-offset-diff its own session JSONL inline and subtract agent tokens —
 * too complex, so it was skipped (real runs emit EMPTY orch_checkpoints → the
 * site-view always showed 0 orchestrator overhead, under-reporting total run
 * cost by the orchestrator's 20-40% share).
 *
 * The orchestrator's tokens (loading skills, reading files/specs, scratchpad
 * updates, approval gates, and reading agent RESULTS) are exactly the
 * `message.usage` on the session's own `assistant` lines. Sub-agent tokens live
 * in SEPARATE transcripts (`subagents/agent-*.jsonl`), so they are NOT in the
 * parent session's usage — **no subtraction is needed**. So orchestrator
 * overhead = sum of the session's assistant `message.usage`. Deterministic,
 * one pass, no LLM math.
 *
 * Headline `total` = input + output + cacheCreate (the new tokens generated).
 * cache-read is tracked but excluded from `total` — it counts re-reads of the
 * growing context every turn and would dwarf the new-token count. It is NOT
 * excluded from `costUSD`: cache reads bill at the cache-read rate and are the
 * dominant token class on long orchestrator sessions, so every costUSD figure
 * here sums all four fields (in + out + cacheWrite + cacheRead) at per-model
 * list rates. Never use `total` as a cost basis — use `costUSD`.
 *
 * costUSD is null (unmeasured, not zero) when the model id is unknown to the
 * pricing table or the agent's sub-transcript is absent. Consumers must report
 * "unmeasured", never fabricate an estimate.
 *
 * Usage:
 *   node orch-tokens.js --session=<id|path>   # id resolved under ~/.claude/projects
 *   node orch-tokens.js --run-dir=<dir>       # resolve session from run_start's session_id
 *   node orch-tokens.js --input=<lines.json>  # offline test hook (array of transcript lines)
 *   node orch-tokens.js --pricing=<json>      # override rates: {"opus": {"input":5,"output":25,"cacheWrite":6.25,"cacheRead":0.5}, ...}
 *   (--projects-dir overrides ~/.claude/projects; --session defaults to $CLAUDE_CODE_SESSION_ID)
 *
 * Exit 0 success · 1 could not resolve the session JSONL. Zero dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve a session id (or a direct path) to its transcript JSONL.
function resolveSessionJsonl(session, projectsDir) {
  if (!session) return null;
  if (session.endsWith('.jsonl') || session.includes('/') || session.includes('\\')) {
    return fs.existsSync(session) ? session : null;
  }
  const base = projectsDir || defaultProjectsDir();
  let dirs;
  try { dirs = fs.readdirSync(base); } catch (_) { return null; }
  for (const d of dirs) {
    const f = path.join(base, d, session + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Pure core: sum orchestrator assistant usage from parsed transcript lines.
// Also buckets per model id (`byModel`) so cost can be computed at the right rate.
function orchFromLines(lines) {
  const t = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, assistantTurns: 0, byModel: {} };
  for (const o of Array.isArray(lines) ? lines : []) {
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const u = o.message.usage;
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    t.input += inp;
    t.output += out;
    t.cacheCreate += cw;
    t.cacheRead += cr;
    t.assistantTurns += 1;
    const m = o.message.model || 'unknown';
    const b = t.byModel[m] || (t.byModel[m] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    b.input += inp; b.output += out; b.cacheCreate += cw; b.cacheRead += cr;
  }
  t.total = t.input + t.output + t.cacheCreate;
  return t;
}

// $ per 1M tokens, keyed by a substring of the model id — first match wins.
// List rates; override with --pricing=<json path> when models/prices change.
const DEFAULT_PRICING = [
  ['opus', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  ['sonnet', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  ['haiku', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
];

function rateFor(model, pricing) {
  const m = String(model || '').toLowerCase();
  for (const [key, rate] of pricing || DEFAULT_PRICING) {
    if (m.includes(key)) return rate;
  }
  return null; // unknown model → cost is unmeasured, never guessed
}

// Dollar cost of a byModel bucket map. cache-read IS included (at its own
// rate) — it dominates long sessions. Returns { usd, unmeasured } where
// unmeasured=true means at least one bucket had no pricing match.
function costFromByModel(byModel, pricing) {
  let usd = 0;
  let unmeasured = false;
  for (const model of Object.keys(byModel || {})) {
    const u = byModel[model];
    const r = rateFor(model, pricing);
    if (!r) { unmeasured = true; continue; }
    usd += (u.input * r.input + u.output * r.output + u.cacheCreate * r.cacheWrite + u.cacheRead * r.cacheRead) / 1e6;
  }
  return { usd: Math.round(usd * 10000) / 10000, unmeasured };
}

// Per-agent tokens/duration from the session transcript. Each Agent/Task
// dispatch pairs to its tool_result's `toolUseResult` (totalTokens /
// totalDurationMs) — metadata the orchestrator model CANNOT see, so it's
// derived here. Returns [{ subagentType, description, tokens, durationMs, agentId }].
function agentsFromLines(lines) {
  const byId = new Map();
  for (const o of Array.isArray(lines) ? lines : []) {
    if (!o) continue;
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c && c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.id) {
          byId.set(c.id, {
            subagentType: (c.input && c.input.subagent_type) || 'agent',
            description: (c.input && c.input.description) || '',
            tokens: null, durationMs: null, agentId: null,
          });
        }
      }
    } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      const tur = o.toolUseResult;
      for (const c of o.message.content) {
        if (!c || c.type !== 'tool_result' || !byId.has(c.tool_use_id)) continue;
        const a = byId.get(c.tool_use_id);
        // Synchronous agents: totals are on the tool_result line's toolUseResult.
        if (tur) {
          if (typeof tur.totalTokens === 'number') a.tokens = tur.totalTokens;
          if (typeof tur.totalDurationMs === 'number') a.durationMs = tur.totalDurationMs;
          if (tur.agentId) a.agentId = tur.agentId;
        }
        // Async agents: the inline result is a launch ack carrying "agentId: X";
        // capture it so we can read the sub-agent transcript for its tokens.
        if (!a.agentId) {
          const txt = typeof c.content === 'string' ? c.content
            : (Array.isArray(c.content) ? c.content.map((b) => (b && b.text) || '').join(' ') : '');
          const m = txt.match(/agentId:\s*([A-Za-z0-9]+)/);
          if (m) a.agentId = m[1];
        }
      }
    }
  }
  // Keep any agent we can attribute — has tokens, or an agentId to look up.
  return [...byId.values()].filter((a) => a.tokens != null || a.durationMs != null || a.agentId);
}

// One transcript read → orchestrator overhead, the per-agent list, and run
// totals. Every agent with a resolvable sub-transcript under
// {session}/subagents/agent-{agentId}.jsonl gets its full 4-field `usage`
// breakdown (incl. cacheRead + byModel) and a `costUSD`; agents whose
// transcript is absent keep `usage` undefined and `costUSD` null — the
// consumer reports those as unmeasured, never estimated.
function sessionSummaryFromFile(sessionJsonl, pricing) {
  const rates = pricing || DEFAULT_PRICING;
  let text;
  try { text = fs.readFileSync(sessionJsonl, 'utf8'); } catch (_) { return null; }
  const lines = [];
  for (const l of text.split(/\r?\n/)) { const s = l.trim(); if (!s) continue; try { lines.push(JSON.parse(s)); } catch (_) {} }
  const orch = orchFromLines(lines);
  const agents = agentsFromLines(lines);
  const subDir = path.join(String(sessionJsonl).replace(/\.jsonl$/i, ''), 'subagents');
  for (const a of agents) {
    a.costUSD = null;
    if (!a.agentId) continue;
    try {
      const sub = fs.readFileSync(path.join(subDir, 'agent-' + a.agentId + '.jsonl'), 'utf8');
      const sl = [];
      for (const l of sub.split(/\r?\n/)) { const s = l.trim(); if (!s) continue; try { sl.push(JSON.parse(s)); } catch (_) {} }
      const st = orchFromLines(sl);            // the sub-agent's own assistant usage = its token cost
      if (st.assistantTurns) {
        a.usage = st;
        const c = costFromByModel(st.byModel, rates);
        a.costUSD = c.unmeasured ? null : c.usd;
      }
      if (a.tokens == null && st.total) a.tokens = st.total;
    } catch (_) { /* transcript absent (older/cleaned run) — leave unmeasured */ }
  }
  const oc = costFromByModel(orch.byModel, rates);
  orch.costUSD = oc.unmeasured ? null : oc.usd;
  // Run totals. Cost sums only the measured portion (orch + agents with usage);
  // agentsWithUsage/agentsTotal tells the consumer how complete that portion is.
  const measured = agents.filter((a) => a.usage);
  const agentCost = measured.reduce((s, a) => s + (a.costUSD || 0), 0);
  const totals = {
    newTokens: orch.total + agents.reduce((s, a) => s + (a.usage ? a.usage.total : (a.tokens || 0)), 0),
    cacheReadTokens: orch.cacheRead + measured.reduce((s, a) => s + a.usage.cacheRead, 0),
    costUSD: orch.costUSD == null ? null : Math.round((orch.costUSD + agentCost) * 10000) / 10000,
    agentsWithUsage: measured.length,
    agentsTotal: agents.length,
  };
  if (totals.costUSD != null && totals.costUSD > 0) {
    totals.orchestratorCostShare = Math.round((orch.costUSD / totals.costUSD) * 1000) / 1000;
  }
  return { orch, agents, totals };
}

// Read the session id a run recorded in its run_start checkpoint (if any).
function readSessionIdFromRunDir(runDir) {
  try {
    const cp = fs.readFileSync(path.join(runDir, 'checkpoints.jsonl'), 'utf8').split(/\r?\n/);
    for (const l of cp) {
      const s = l.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch (_) { continue; }
      if (e.event === 'run_start' && (e.session_id || e.sessionId)) return e.session_id || e.sessionId;
    }
  } catch (_) {}
  return null;
}

// Compute orchestrator overhead for a session JSONL path.
function computeFromFile(sessionJsonl) {
  let text;
  try { text = fs.readFileSync(sessionJsonl, 'utf8'); } catch (_) { return null; }
  const lines = [];
  for (const l of text.split(/\r?\n/)) {
    const s = l.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch (_) { /* skip partial */ }
  }
  return orchFromLines(lines);
}

module.exports = {
  resolveSessionJsonl,
  orchFromLines,
  agentsFromLines,
  sessionSummaryFromFile,
  readSessionIdFromRunDir,
  computeFromFile,
  defaultProjectsDir,
  DEFAULT_PRICING,
  rateFor,
  costFromByModel,
};

if (require.main === module) {
  const input = arg('input');
  if (input != null) {
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
    process.stdout.write(JSON.stringify(orchFromLines(Array.isArray(parsed) ? parsed : parsed.lines), null, 2));
    process.exit(0);
  }
  let session = arg('session') || process.env.CLAUDE_CODE_SESSION_ID;
  const runDir = arg('run-dir');
  if (!session && runDir) session = readSessionIdFromRunDir(runDir);
  const jsonl = resolveSessionJsonl(session, arg('projects-dir'));
  if (!jsonl) {
    console.error('orch-tokens: could not resolve the session JSONL — pass --session=<id|path>, ensure $CLAUDE_CODE_SESSION_ID is set, or that run_start recorded session_id.');
    process.exit(1);
  }
  let pricing = null;
  const pricingPath = arg('pricing');
  if (pricingPath) {
    const raw = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
    pricing = Array.isArray(raw) ? raw : Object.entries(raw);
  }
  const summary = sessionSummaryFromFile(jsonl, pricing);
  process.stdout.write(JSON.stringify({
    orchestrator: summary.orch,
    agents: summary.agents,
    totals: summary.totals,
    note: 'costUSD sums input+output+cacheWrite+cacheRead at per-model rates; total excludes cacheRead (new-token count, NOT a cost basis). null costUSD = unmeasured (unknown model or absent sub-transcript) — report as unmeasured, never estimate.',
  }, null, 2));
  process.exit(0);
}
