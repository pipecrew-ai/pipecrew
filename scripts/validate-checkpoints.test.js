#!/usr/bin/env node
/**
 * Unit tests for validate-checkpoints.js.
 * Zero deps: run with `node validate-checkpoints.test.js`.
 */

const { validate } = require('./validate-checkpoints');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const hasErr  = (r, s) => r.errors.some(x => x.includes(s));
const hasWarn = (r, s) => r.warnings.some(x => x.includes(s));

const baseRun = [
  { ts: '2026-04-15T09:12:34Z', event: 'run_start', skill: 'onboard',
    run_id: '2026-04-15-091234-dal', workspace_slug: 'dal', args: '--workspace=dal' },
  { ts: '2026-04-15T09:14:02Z', event: 'phase_start', skill: 'onboard',
    run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery' },
  { ts: '2026-04-15T09:17:58Z', event: 'agent_end', skill: 'onboard',
    run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery',
    agent_type: 'solution-architect', description: 'Architect discovery',
    input_tokens: 23105, output_tokens: 8942, cache_read_tokens: 45780,
    total_tokens: 77922, tool_uses: 28, duration_ms: 242835, status: 'ok' },
  { ts: '2026-04-15T09:18:05Z', event: 'phase_end', skill: 'onboard',
    run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery',
    duration_ms: 242835 },
  { ts: '2026-04-15T09:28:47Z', event: 'run_end', skill: 'onboard',
    run_id: '2026-04-15-091234-dal', status: 'completed', duration_ms: 933412 },
];

const toLines = arr => arr.map(o => JSON.stringify(o));

console.log('\nvalidate-checkpoints tests\n');

test('happy path — valid run log has no errors or warnings', () => {
  const r = validate(toLines(baseRun));
  assert(r.errors.length === 0, `unexpected errors: ${r.errors.join('; ')}`);
  assert(r.warnings.length === 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('missing required common field — run_id', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  delete evs[2].run_id;
  const r = validate(toLines(evs));
  assert(hasErr(r, 'missing required field "run_id"'));
});

test('invalid ISO timestamp', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[2].ts = '2026-04-15 09:17:58';
  const r = validate(toLines(evs));
  assert(hasErr(r, 'not ISO8601'), 'should flag bad ts');
});

test('unknown event type rejected', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs.push({ ts: '2026-04-15T09:20:00Z', event: 'agent_start', skill: 'onboard',
             run_id: '2026-04-15-091234-dal' });
  const r = validate(toLines(evs));
  assert(hasErr(r, 'unknown event "agent_start"'));
});

test('unknown skill rejected', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[2].skill = 'not-a-skill';
  const r = validate(toLines(evs));
  assert(hasErr(r, 'unknown skill'));
});

test('run_id format enforced', () => {
  const evs = [{ ts: '2026-04-15T09:12:34Z', event: 'run_start', skill: 'onboard',
                 run_id: 'not-a-valid-run-id', workspace_slug: 'dal' }];
  const r = validate(toLines(evs));
  assert(hasErr(r, 'does not match {YYYY-MM-DD-HHMMSS}'));
});

test('run_id with collision suffix accepted (-2)', () => {
  const evs = [{ ts: '2026-04-15T09:12:34Z', event: 'run_start', skill: 'onboard',
                 run_id: '2026-04-15-091234-dal-2', workspace_slug: 'dal' },
               { ts: '2026-04-15T09:12:35Z', event: 'run_end', skill: 'onboard',
                 run_id: '2026-04-15-091234-dal-2', status: 'completed', duration_ms: 1000 }];
  const r = validate(toLines(evs));
  assert(!r.errors.some(e => e.includes('run_id')), 'collision suffix should be accepted');
});

test('run_start requires workspace_slug', () => {
  const evs = [{ ts: '2026-04-15T09:12:34Z', event: 'run_start', skill: 'onboard',
                 run_id: '2026-04-15-091234-dal' }];
  const r = validate(toLines(evs));
  assert(hasErr(r, 'run_start missing required field "workspace_slug"'));
});

test('run_end requires status + duration_ms', () => {
  const evs = [{ ts: '2026-04-15T09:12:34Z', event: 'run_start', skill: 'onboard',
                 run_id: '2026-04-15-091234-dal', workspace_slug: 'dal' },
               { ts: '2026-04-15T09:28:47Z', event: 'run_end', skill: 'onboard',
                 run_id: '2026-04-15-091234-dal' }];
  const r = validate(toLines(evs));
  assert(hasErr(r, 'run_end missing required field "status"'));
  assert(hasErr(r, 'run_end missing required field "duration_ms"'));
});

test('run_end status enum enforced', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[4].status = 'done';
  const r = validate(toLines(evs));
  assert(hasErr(r, 'not in completed|failed|aborted|resumed_later'));
});

test('agent_end status enum enforced', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[2].status = 'success';
  const r = validate(toLines(evs));
  assert(hasErr(r, 'not in ok|retry|failed|deferred'));
});

test('agent_end allows status=failed with no token fields (tool errored early)', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[2] = { ts: '2026-04-15T09:17:58Z', event: 'agent_end', skill: 'onboard',
             run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery',
             agent_type: 'solution-architect', description: 'Architect discovery',
             status: 'failed' };
  const r = validate(toLines(evs));
  assert(r.errors.length === 0, `should accept failed without tokens; got: ${r.errors.join(';')}`);
});

test('agent_end rejects negative token count', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[2].input_tokens = -5;
  const r = validate(toLines(evs));
  assert(hasErr(r, 'input_tokens must be non-negative integer'));
});

test('orch_checkpoint requires jsonl_offset + orch_since_last', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs.splice(3, 0, { ts: '2026-04-15T09:18:00Z', event: 'orch_checkpoint', skill: 'onboard',
                     run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery' });
  const r = validate(toLines(evs));
  assert(hasErr(r, 'orch_checkpoint missing required field "jsonl_offset"'));
  assert(hasErr(r, 'orch_checkpoint missing required field "orch_since_last"'));
});

test('orch_checkpoint.orch_since_last requires input+output tokens', () => {
  const ev = { ts: '2026-04-15T09:18:00Z', event: 'orch_checkpoint', skill: 'onboard',
               run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery',
               jsonl_offset: 284500, orch_since_last: { cache_read_tokens: 40000 } };
  const r = validate(toLines([ev]));
  assert(hasErr(r, 'orch_since_last missing required "input_tokens"'));
  assert(hasErr(r, 'orch_since_last missing required "output_tokens"'));
});

test('orch_checkpoint valid shape passes', () => {
  const ev = { ts: '2026-04-15T09:18:00Z', event: 'orch_checkpoint', skill: 'onboard',
               run_id: '2026-04-15-091234-dal', phase: 'B2', stage: 'Architect Discovery',
               jsonl_offset: 284500, orch_since_last: { input_tokens: 1240, output_tokens: 3100, cache_read_tokens: 42000 } };
  const r = validate(toLines([ev]));
  assert(!hasErr(r, 'orch_checkpoint'), `unexpected: ${r.errors.join(';')}`);
});

test('bash_slow below 5000ms threshold rejected', () => {
  const ev = { ts: '2026-04-15T09:15:20Z', event: 'bash_slow', skill: 'feature',
               run_id: '2026-04-15-104502-book-upload', phase: '5a', stage: 'Backend',
               duration_ms: 3000, cmd_summary: 'mvn test' };
  const r = validate(toLines([ev]));
  assert(hasErr(r, 'below 5000ms threshold'));
});

test('bash_slow cmd_summary over 60 chars rejected', () => {
  const ev = { ts: '2026-04-15T09:15:20Z', event: 'bash_slow', skill: 'feature',
               run_id: '2026-04-15-104502-book-upload', phase: '5a', stage: 'Backend',
               duration_ms: 8000, cmd_summary: 'x'.repeat(80) };
  const r = validate(toLines([ev]));
  assert(hasErr(r, 'exceeds 60 chars'));
});

test('retry requires agent_type + description + retry_reason', () => {
  const ev = { ts: '2026-04-15T09:16:00Z', event: 'retry', skill: 'feature',
               run_id: '2026-04-15-104502-book-upload', phase: '5a', stage: 'Backend' };
  const r = validate(toLines([ev]));
  assert(hasErr(r, 'retry missing required field "agent_type"'));
  assert(hasErr(r, 'retry missing required field "description"'));
  assert(hasErr(r, 'retry missing required field "retry_reason"'));
});

test('non-monotonic ts warns', () => {
  const evs = JSON.parse(JSON.stringify(baseRun));
  evs[3].ts = '2026-04-15T09:10:00Z';  // before phase_start
  const r = validate(toLines(evs));
  assert(hasWarn(r, 'non-monotonic'));
});

test('multiple run_ids in one file warns', () => {
  const evs = [...baseRun.slice(0, 3),
    { ts: '2026-04-15T09:30:00Z', event: 'run_start', skill: 'feature',
      run_id: '2026-04-15-093000-book-upload', workspace_slug: 'dal' },
  ];
  const r = validate(toLines(evs));
  assert(hasWarn(r, 'events from 2 run_ids'));
});

test('missing run_start warns (not hard fails)', () => {
  const evs = baseRun.slice(1);  // drop run_start
  const r = validate(toLines(evs));
  assert(!hasErr(r, 'run_start'), 'missing run_start is a warning, not an error');
  assert(hasWarn(r, 'no run_start event seen'));
});

test('missing run_end warns (not hard fails)', () => {
  const evs = baseRun.slice(0, -1);  // drop run_end
  const r = validate(toLines(evs));
  assert(hasWarn(r, 'no run_end event seen'));
});

test('empty file is clean', () => {
  const r = validate([]);
  assert(r.errors.length === 0);
  assert(r.warnings.length === 0);
});

test('malformed JSON line flagged', () => {
  const r = validate(['{not json}']);
  assert(hasErr(r, 'invalid JSON'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
