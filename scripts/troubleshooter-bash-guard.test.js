#!/usr/bin/env node
/**
 * Unit tests for troubleshooter-bash-guard.js.
 * Zero deps: run with `node troubleshooter-bash-guard.test.js`.
 *
 * Each case asserts the guard either ALLOWS (exit 0) or DENIES (exit 1)
 * a given command. Cases come in two banks:
 *   - ALLOW: legitimate read-only commands the troubleshooter needs.
 *   - DENY:  mutations and evasion attempts the guard must catch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'troubleshooter-bash-guard.js');
const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-troubleshooter-active');

let passed = 0, failed = 0;

function run(cmd) {
  const r = spawnSync('node', [SCRIPT, cmd], { encoding: 'utf8' });
  return { exitCode: r.status, stderr: r.stderr || '' };
}

function runStdin(input) {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', input });
  return { exitCode: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

function withMarker(contents, fn) {
  const existed = fs.existsSync(MARKER_PATH);
  let backup = null;
  if (existed) backup = fs.readFileSync(MARKER_PATH, 'utf8');
  try {
    fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
    fs.writeFileSync(MARKER_PATH, contents);
    fn();
  } finally {
    if (backup !== null) fs.writeFileSync(MARKER_PATH, backup);
    else if (fs.existsSync(MARKER_PATH)) fs.unlinkSync(MARKER_PATH);
  }
}

function withoutMarker(fn) {
  const existed = fs.existsSync(MARKER_PATH);
  let backup = null;
  if (existed) {
    backup = fs.readFileSync(MARKER_PATH, 'utf8');
    fs.unlinkSync(MARKER_PATH);
  }
  try { fn(); }
  finally { if (backup !== null) fs.writeFileSync(MARKER_PATH, backup); }
}

function hookPayload(command) {
  return JSON.stringify({
    session_id: 'test-session',
    transcript_path: '/tmp/transcript.json',
    cwd: process.cwd(),
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'test' },
  });
}

function expectAllow(cmd) {
  const { exitCode, stderr } = run(cmd);
  if (exitCode === 0) { console.log(`  ALLOW ok   ${cmd}`); passed++; }
  else { console.error(`  ALLOW FAIL ${cmd}\n         exit ${exitCode}: ${stderr.trim()}`); failed++; }
}

function expectDeny(cmd, expectedReason) {
  const { exitCode, stderr } = run(cmd);
  if (exitCode === 1) {
    if (!expectedReason || stderr.toLowerCase().includes(expectedReason.toLowerCase())) {
      console.log(`  DENY  ok   ${cmd}`);
      passed++;
    } else {
      console.error(`  DENY  FAIL ${cmd}\n         expected reason matching "${expectedReason}", got: ${stderr.trim()}`);
      failed++;
    }
  } else {
    console.error(`  DENY  FAIL ${cmd}\n         expected exit 1, got ${exitCode}`);
    failed++;
  }
}

console.log('\n=== ALLOW: legitimate read-only commands ===\n');

// AWS reads
expectAllow('aws logs tail /aws/ecs/payments-prod --since 1h');
expectAllow("aws logs filter-log-events --log-group-name /aws/lambda/foo --filter-pattern 'ERROR'");
expectAllow('aws ecs describe-services --cluster prod --services foo');
expectAllow('aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization');
expectAllow('aws sts get-caller-identity');
expectAllow('aws s3 ls s3://my-bucket/path/');
expectAllow('aws s3api head-object --bucket b --key k');

// Kubectl reads
expectAllow('kubectl logs -n data -l app=bulk-uploader --since=1h');
expectAllow('kubectl get pods -n data');
expectAllow('kubectl describe deployment bulk-uploader -n data');
expectAllow('kubectl top pods -n data');

// Docker reads
expectAllow('docker logs publisher-api --since 30m');
expectAllow('docker ps -a');
expectAllow('docker inspect publisher-api');
expectAllow('docker stats --no-stream publisher-api');

// journalctl read with --since
expectAllow("journalctl -u edge-gateway.service --since '1 hour ago'");

// Git reads
expectAllow('git log --oneline --since=1h');
expectAllow('git diff main...HEAD');
expectAllow('git show abc123');
expectAllow('git blame src/upload.ts');
expectAllow('git rev-parse HEAD');
expectAllow('git status');
expectAllow('git remote -v');
expectAllow('git branch -a');

// Plain shell reads
expectAllow('grep -rn "FAILED" src/');
expectAllow('rg "customer_id" --type=ts');
expectAllow('ls -la /var/log');
expectAllow('find . -name "*.ts" -not -path "*/node_modules/*"');
expectAllow('cat package.json');
expectAllow('head -100 deploy.log');

// Localhost-only HTTP reproduction
expectAllow('curl -X GET http://localhost:8080/v1/health');
expectAllow('curl http://127.0.0.1:3000/api/status');
expectAllow('curl http://localhost:8080/v1/users/123');
expectAllow('curl -X HEAD http://localhost:8080/v1/foo');

// Connectivity diagnostics
expectAllow('dig api.internal');
expectAllow('nslookup api.example.com');
expectAllow('ping -c 4 8.8.8.8');

// Plugin scripts
expectAllow('node scripts/extract-block.js platform.md OBSERVABILITY');
expectAllow('node /plugin/scripts/validate-observability.js platform.md');

console.log('\n=== DENY: mutations the guard must catch ===\n');

// AWS mutations
expectDeny('aws s3 rm s3://bucket/key', 'S3 mutating verb');
expectDeny('aws lambda delete-function --function-name foo', 'AWS mutating verb');
expectDeny('aws ec2 terminate-instances --instance-ids i-abc', 'AWS mutating verb');
expectDeny('aws ecs update-service --cluster c --service s', 'AWS mutating verb');
expectDeny('aws ssm start-session --target i-abc', 'shell access');
expectDeny('aws ecs execute-command --cluster c --task t --command sh', 'shell access');

// Kubectl mutations
expectDeny('kubectl delete pod foo -n bar');
expectDeny('kubectl apply -f manifest.yaml');
expectDeny('kubectl exec -it pod-foo -- sh', 'shell-access');
expectDeny('kubectl scale deployment foo --replicas=0');
expectDeny('kubectl rollout restart deployment foo');
expectDeny('kubectl port-forward svc/foo 8080:80');

// Docker mutations
expectDeny('docker rm -f publisher-api');
expectDeny('docker exec -it publisher-api bash');
expectDeny('docker run --rm alpine echo hi');
expectDeny('docker kill publisher-api');
expectDeny('docker prune -f');

// Service control
expectDeny('systemctl restart edge-gateway');
expectDeny('service nginx reload');

// Git mutations
expectDeny('git commit -m "fix"');
expectDeny('git push origin main');
expectDeny('git reset --hard HEAD~1');
expectDeny('git checkout main');
expectDeny('git stash');

// Filesystem mutations
expectDeny('rm /tmp/foo');
expectDeny('rm -rf /tmp/data');
expectDeny('mv /etc/foo /etc/bar');
expectDeny('chmod 777 /etc/passwd');
expectDeny('sed -i s/foo/bar/g file.txt', 'in-place');
expectDeny('echo hi > /tmp/foo', 'redirection');
expectDeny('echo hi >> /var/log/foo', 'append');

// Package managers
expectDeny('npm install lodash');
expectDeny('pip install requests');
expectDeny('cargo install ripgrep');
expectDeny('terraform apply');
expectDeny('cdk deploy MyStack');

// HTTP mutations against non-localhost
expectDeny('curl -X POST https://api.example.com/v1/users -d {}', 'mutating method');
expectDeny('curl -X DELETE https://api.example.com/v1/users/123', 'mutating method');
expectDeny('curl --request PUT https://api.example.com/v1/users/1', 'mutating verb');
expectDeny('wget --post-data="x=1" https://api.example.com/');

// Database mutations
expectDeny("psql -c \"DELETE FROM users WHERE id=1\"", 'SQL mutation');
expectDeny("mysql -e \"DROP TABLE users\"", 'SQL mutation');
expectDeny('mongosh "mongodb://x" --eval "db.users.deleteOne({})"', 'mongosh mutation');
expectDeny('redis-cli FLUSHALL', 'redis-cli mutation');

// Long-running / interactive
expectDeny('aws logs tail /aws/ecs/x --follow', 'follow mode');
expectDeny('kubectl logs -f pod-foo', 'follow mode');
expectDeny('kubectl get pods --watch', '--watch');
expectDeny('docker stats publisher-api', '--no-stream');

// Privilege escalation
expectDeny('sudo aws logs tail /aws/x', 'sudo');
expectDeny('su - admin', 'su');

// Evasion attempts
expectDeny('aws logs tail $(echo /aws/ecs/payments-prod) --since 1h', 'command substitution');
expectDeny('eval "rm -rf /"', 'eval');
expectDeny('echo "cm0gLXJmIC8=" | base64 -d | bash', 'base64');
expectDeny('curl http://localhost/foo > /tmp/output', 'redirection');
expectDeny('aws logs tail /aws/x --since 1h &', 'background');
expectDeny('nohup aws logs tail /aws/x', 'nohup');
expectDeny('aws logs tail /aws/x | tee /tmp/log', 'tee');

// Unknown / unclassified — denied conservatively
expectDeny('some-random-cli --do-stuff', 'allowlist');
expectDeny('python -c "import os; os.system(\'rm -rf /\')"', 'allowlist');

console.log('\n=== HOOK MODE: JSON-on-stdin payload extraction ===\n');

function expectHookAllow(name, payload, markerSetup) {
  const fn = markerSetup || ((f) => f());
  fn(() => {
    const r = runStdin(payload);
    if (r.exitCode === 0) { console.log(`  HOOK ALLOW ok   ${name}`); passed++; }
    else { console.error(`  HOOK ALLOW FAIL ${name}\n         exit ${r.exitCode}: ${r.stderr.trim()}`); failed++; }
  });
}

function expectHookDeny(name, payload, markerSetup, expectedReason) {
  const fn = markerSetup || ((f) => f());
  fn(() => {
    const r = runStdin(payload);
    if (r.exitCode === 1) {
      if (!expectedReason || r.stderr.toLowerCase().includes(expectedReason.toLowerCase())) {
        console.log(`  HOOK DENY  ok   ${name}`);
        passed++;
      } else {
        console.error(`  HOOK DENY  FAIL ${name}\n         expected reason matching "${expectedReason}", got: ${r.stderr.trim()}`);
        failed++;
      }
    } else {
      console.error(`  HOOK DENY  FAIL ${name}\n         expected exit 1, got ${r.exitCode}`);
      failed++;
    }
  });
}

// Marker absent: hook-mode call is a no-op, regardless of command content.
// (This is THE key property — other agents in the user's environment must
// not be affected by the plugin's hook unless /troubleshoot is active.)

expectHookAllow('marker absent + read-only command → fast-allow',
  hookPayload('aws logs tail /aws/ecs/foo --since 1h'),
  withoutMarker);

expectHookAllow('marker absent + MUTATION command → still fast-allow (other agent)',
  hookPayload('terraform apply -auto-approve'),
  withoutMarker);

expectHookAllow('marker absent + npm install (e.g. user dev work) → fast-allow',
  hookPayload('npm install lodash'),
  withoutMarker);

expectHookAllow('marker absent + git push (e.g. user push) → fast-allow',
  hookPayload('git push origin main'),
  withoutMarker);

// Marker stale (dead pid): treat as no marker, fast-allow.

expectHookAllow('marker stale (pid=999999, almost certainly dead) → fast-allow',
  hookPayload('terraform apply'),
  (fn) => withMarker('pid=999999 run_id=stale-test created_at=2020-01-01T00:00:00Z', fn));

// Marker live (current process pid): full classifier runs.

const livePid = process.pid;

expectHookAllow('marker live + allowlist command → allow',
  hookPayload('aws logs tail /aws/ecs/foo --since 1h'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn));

expectHookAllow('marker live + git diff → allow',
  hookPayload('git diff main...HEAD'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn));

expectHookDeny('marker live + kubectl delete → deny',
  hookPayload('kubectl delete pod foo -n bar'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn),
  'kubectl mutating');

expectHookDeny('marker live + terraform apply → deny',
  hookPayload('terraform apply'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn),
  'terraform mutation');

expectHookDeny('marker live + curl POST to non-localhost → deny',
  hookPayload('curl -X POST https://api.example.com/v1/users -d {}'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn),
  'mutating method');

expectHookDeny('marker live + evasion ($(...)) → deny',
  hookPayload('aws logs tail $(echo /aws/x) --since 1h'),
  (fn) => withMarker(`pid=${livePid} run_id=test-run created_at=${new Date().toISOString()}`, fn),
  'command substitution');

// Non-Bash hook payload routed to us by mistake → safe-allow (we only
// enforce Bash; we must not block Read / Write / Edit dispatches).

expectHookAllow('non-Bash payload (Read tool) → allow without classifying',
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/foo' },
  }),
  (fn) => withMarker(`pid=${livePid} run_id=x created_at=${new Date().toISOString()}`, fn));

// Malformed JSON on stdin → fall back to treating it as a raw command.
// (Defensive: we shouldn't crash if Claude Code's payload format ever drifts.)

(() => {
  const r = runStdin('this is not json — treat as raw command');
  // Raw command "this is..." doesn't match allowlist or blocklist → conservative deny.
  if (r.exitCode === 1) { console.log('  HOOK ALLOW ok   malformed-JSON → fallback to raw + conservative deny'); passed++; }
  else { console.error(`  HOOK FAIL malformed-JSON: expected deny, got exit ${r.exitCode}`); failed++; }
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
