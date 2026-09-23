#!/usr/bin/env node
'use strict';
/** Unit tests for orch-tokens.js. Zero deps, plain assert. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { orchFromLines, agentsFromLines, resolveSessionJsonl, readSessionIdFromRunDir, sessionSummaryFromFile, rateFor, costFromByModel, DEFAULT_PRICING, loadPricing } = require('./orch-tokens.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

ok('orchFromLines sums assistant usage; ignores non-assistant + agent transcripts', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hi' } },              // ignored
    { type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 } } },
    { type: 'assistant', message: { usage: { input_tokens: 400, output_tokens: 120, cache_creation_input_tokens: 10 } } },
    { type: 'assistant', message: {} },                                       // no usage → skipped
    { type: 'file-history-snapshot' },                                        // ignored
  ];
  const t = orchFromLines(lines);
  assert.strictEqual(t.input, 1400);
  assert.strictEqual(t.output, 320);
  assert.strictEqual(t.cacheCreate, 60);
  assert.strictEqual(t.cacheRead, 9000);
  assert.strictEqual(t.assistantTurns, 2);
  assert.strictEqual(t.total, 1400 + 320 + 60);   // cache-read excluded from headline
});

ok('orchFromLines tolerates junk', () => {
  assert.doesNotThrow(() => orchFromLines(null));
  assert.doesNotThrow(() => orchFromLines([null, 1, 'x', {}]));
  assert.strictEqual(orchFromLines([]).total, 0);
});

ok('resolveSessionJsonl finds {id}.jsonl under projects dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const proj = path.join(tmp, 'C--demo');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'sess-123.jsonl'), '{}\n');
  assert.strictEqual(resolveSessionJsonl('sess-123', tmp), path.join(proj, 'sess-123.jsonl'));
  assert.strictEqual(resolveSessionJsonl('missing', tmp), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

ok('readSessionIdFromRunDir reads run_start.session_id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchrun-'));
  fs.writeFileSync(path.join(tmp, 'checkpoints.jsonl'),
    JSON.stringify({ event: 'run_start', session_id: 'abc-999' }) + '\n' +
    JSON.stringify({ event: 'phase_start', phase: '1' }) + '\n');
  assert.strictEqual(readSessionIdFromRunDir(tmp), 'abc-999');
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(readSessionIdFromRunDir('/no/such/dir'), null);
});

ok('agentsFromLines pairs Agent dispatch → toolUseResult tokens/duration', () => {
  const lines = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'spring-boot-implementer', description: 'Backend — publisher-service' } },
    ] } },
    { type: 'user', toolUseResult: { totalTokens: 51234, totalDurationMs: 90000, agentId: 'ag-1' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
    // a dispatch with no result yet → excluded (no tokens)
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_2', name: 'Task', input: { subagent_type: 'Explore', description: 'still running' } },
    ] } },
  ];
  const agents = agentsFromLines(lines);
  assert.strictEqual(agents.length, 1);
  assert.strictEqual(agents[0].description, 'Backend — publisher-service');
  assert.strictEqual(agents[0].tokens, 51234);
  assert.strictEqual(agents[0].durationMs, 90000);
  assert.strictEqual(agents[0].agentId, 'ag-1');
});

ok('orchFromLines buckets usage per model id', () => {
  const lines = [
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 } } },
    { type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 20 } } },
    { type: 'assistant', message: { usage: { input_tokens: 7 } } },   // no model → 'unknown' bucket
  ];
  const t = orchFromLines(lines);
  assert.strictEqual(t.byModel['claude-opus-4-6'].cacheRead, 1000);
  assert.strictEqual(t.byModel['claude-haiku-4-5'].output, 20);
  assert.strictEqual(t.byModel['unknown'].input, 7);
});

ok('rateFor matches by substring; unknown model → null (unmeasured, not guessed)', () => {
  assert.strictEqual(rateFor('claude-opus-4-6', DEFAULT_PRICING).output, 25);
  assert.strictEqual(rateFor('claude-haiku-4-5-20251001', DEFAULT_PRICING).input, 1);
  assert.strictEqual(rateFor('unknown', DEFAULT_PRICING), null);
  assert.strictEqual(rateFor('', DEFAULT_PRICING), null);
});

ok('costFromByModel includes cache-read at its own rate; flags unknown models unmeasured', () => {
  // 1M of each field on opus: 5 + 25 + 6.25 + 0.5 = 36.75
  const c = costFromByModel({ 'claude-opus-4-6': { input: 1e6, output: 1e6, cacheCreate: 1e6, cacheRead: 1e6 } }, DEFAULT_PRICING);
  assert.strictEqual(c.usd, 36.75);
  assert.strictEqual(c.unmeasured, false);
  const u = costFromByModel({ mystery: { input: 1e6, output: 0, cacheCreate: 0, cacheRead: 0 } }, DEFAULT_PRICING);
  assert.strictEqual(u.unmeasured, true);
  assert.strictEqual(u.usd, 0);
});

ok('sessionSummaryFromFile attaches per-agent usage + costUSD from sub-transcripts, and run totals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchsum-'));
  const sess = path.join(tmp, 'sess-1.jsonl');
  const subDir = path.join(tmp, 'sess-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sessionLines = [
    { type: 'assistant', message: { model: 'claude-opus-4-6', usage: { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 2e6 } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'x', description: 'measured agent' } }] } },
    { type: 'user', toolUseResult: { agentId: 'ag1' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'y', description: 'unmeasured agent' } }] } },
    { type: 'user', toolUseResult: { totalTokens: 500, agentId: 'ag-gone' }, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
  ];
  fs.writeFileSync(sess, sessionLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-ag1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 0, cache_read_input_tokens: 1e6 } } }) + '\n');
  const s = sessionSummaryFromFile(sess);
  // orchestrator: opus 1M input ($5) + 2M cacheRead ($1) = $6; total excludes cacheRead
  assert.strictEqual(s.orch.costUSD, 6);
  assert.strictEqual(s.orch.total, 1e6);
  const measured = s.agents.find((a) => a.description === 'measured agent');
  // haiku 1M in ($1) + 1M out ($5) + 1M cacheRead ($0.1) = $6.1; usage carries cacheRead
  assert.strictEqual(measured.costUSD, 6.1);
  assert.strictEqual(measured.usage.cacheRead, 1e6);
  assert.strictEqual(measured.tokens, 2e6);   // input+output (cacheRead excluded from total)
  const unmeasured = s.agents.find((a) => a.description === 'unmeasured agent');
  assert.strictEqual(unmeasured.costUSD, null);  // sub-transcript absent → unmeasured, not zero
  assert.strictEqual(unmeasured.usage, undefined);
  assert.strictEqual(unmeasured.tokens, 500);    // legacy toolUseResult total still honored
  // totals: newTokens = orch 1M + measured 2M + unmeasured legacy 500
  assert.strictEqual(s.totals.newTokens, 1e6 + 2e6 + 500);
  assert.strictEqual(s.totals.cacheReadTokens, 2e6 + 1e6);
  assert.strictEqual(s.totals.costUSD, 12.1);
  assert.strictEqual(s.totals.agentsWithUsage, 1);
  assert.strictEqual(s.totals.agentsTotal, 2);
  assert.strictEqual(s.totals.orchestratorCostShare, Math.round((6 / 12.1) * 1000) / 1000);
  fs.rmSync(tmp, { recursive: true, force: true });
});

ok('rateFor knows current-generation models (fable/mythos), incl. via pricing.json', () => {
  assert.strictEqual(rateFor('claude-fable-5', DEFAULT_PRICING).input, 10);
  assert.strictEqual(rateFor('claude-mythos-5', DEFAULT_PRICING).cacheWrite, 12.5);
  const loaded = loadPricing();               // scripts/pricing.json (falls back to DEFAULT_PRICING)
  assert.strictEqual(rateFor('claude-fable-5', loaded).output, 50);
  assert.strictEqual(rateFor('claude-opus-4-6', loaded).output, 25);
});

ok('orchFromLines derives windowEstimate + rewarmFactor from the last turn', () => {
  const lines = [
    { type: 'assistant', message: { model: 'm', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } } },
    { type: 'assistant', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 100 } } },
  ];
  const t = orchFromLines(lines);
  assert.strictEqual(t.windowEstimate, 5 + 20 + 100);          // last turn's prompt side
  assert.strictEqual(t.lastModel, 'm');
  assert.strictEqual(t.rewarmFactor, Math.round((120 / 125) * 10) / 10);
  const empty = orchFromLines([]);
  assert.strictEqual(empty.windowEstimate, 0);
  assert.strictEqual(empty.rewarmFactor, null);                // no division by zero
});

ok('sessionSummaryFromFile: unknown model → warnings + measured portion survives', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchwarn-'));
  const sess = path.join(tmp, 'sess-2.jsonl');
  const subDir = path.join(tmp, 'sess-2', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sessionLines = [
    // orchestrator on a model the rate card doesn't know
    { type: 'assistant', message: { model: 'claude-futuremodel-9', usage: { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'x', description: 'priced agent' } }] } },
    { type: 'user', toolUseResult: { agentId: 'ag1' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ];
  fs.writeFileSync(sess, sessionLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-ag1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n');
  const s = sessionSummaryFromFile(sess);
  assert.strictEqual(s.orch.costUSD, null);                    // unmeasured, never guessed
  assert.strictEqual(s.totals.costUSD, null);                  // full total stays honest
  assert.strictEqual(s.totals.measuredCostUSD, 6);             // haiku agent: $1 + $5 — not blanked
  assert.deepStrictEqual(s.totals.unmeasuredModels, ['claude-futuremodel-9']);
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(s.warnings[0].includes('claude-futuremodel-9'));
  assert.ok(s.warnings[0].includes('pricing.json'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

ok('sessionSummaryFromFile: fully-priced run has empty warnings and matching totals', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchok-'));
  const sess = path.join(tmp, 'sess-3.jsonl');
  fs.writeFileSync(sess, JSON.stringify(
    { type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 } } }) + '\n');
  const s = sessionSummaryFromFile(sess);
  // fable: 10 + 50 + 12.5 + 1 = 73.5
  assert.strictEqual(s.orch.costUSD, 73.5);
  assert.strictEqual(s.totals.costUSD, 73.5);
  assert.strictEqual(s.totals.measuredCostUSD, 73.5);
  assert.deepStrictEqual(s.totals.unmeasuredModels, []);
  assert.deepStrictEqual(s.warnings, []);
  assert.strictEqual(s.orch.windowEstimate, 3e6);              // in + cacheWrite + cacheRead of the only turn
  assert.strictEqual(s.orch.rewarmFactor, Math.round((1e6 / 3e6) * 10) / 10);
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed.`);
