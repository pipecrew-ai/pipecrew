#!/usr/bin/env node
'use strict';
/**
 * Bash command guard for the troubleshooter agent.
 *
 * The troubleshooter agent's system prompt declares it operates in
 * READ-ONLY mode (see HARD RULES in templates/agents/troubleshooter.md.template).
 * The agent itself enforces those rules in its reasoning, but agents make
 * mistakes — this guard is the defense-in-depth layer.
 *
 * USED TWO WAYS:
 *   - Standalone CLI / PreToolUse hook (this file's own entry point).
 *   - As a module imported by scripts/pretooluse-dispatch.js, which reads the
 *     hook payload once and routes to classifyCommand() / markerActive() so a
 *     single Bash dispatch spawns ONE node process instead of two. The two
 *     exported functions are the pure logic; the CLI below is a thin wrapper.
 *
 * INVOCATION MODES (auto-detected by the CLI):
 *
 *   1. PreToolUse hook (the live enforcement path).
 *      Claude Code pipes the hook event payload as JSON on stdin:
 *        { "hook_event_name": "PreToolUse", "tool_name": "Bash",
 *          "tool_input": { "command": "...", "description": "..." }, ... }
 *      The script auto-detects this shape, extracts tool_input.command,
 *      and gates on the marker file (see "marker-file self-gating" below).
 *
 *   2. Plain stdin (one-line command).
 *        echo "aws logs tail /aws/x" | node troubleshooter-bash-guard.js
 *      No marker check — runs the full allow/deny logic.
 *
 *   3. argv (manual / test harness).
 *        node troubleshooter-bash-guard.js "aws logs tail /aws/x"
 *      No marker check — runs the full allow/deny logic.
 *
 * MARKER-FILE SELF-GATING (hook mode only):
 *   Plugin-shipped hooks fire on EVERY Bash dispatch from EVERY agent. We scope
 *   enforcement to an active /troubleshoot run with a marker file:
 *   ~/.claude/.pipecrew-troubleshooter-active (written by the skill before
 *   dispatch, removed on completion). markerActive() returns false (→ no-op)
 *   when the marker is absent OR points at a dead pid.
 *
 * EXIT CODES (CLI):
 *   0 — command is read-only / hook is no-op / marker absent or stale; allow
 *   1 — command violates the rules; deny (with reason on stderr)
 *
 * Zero dependencies — pure Node stdlib.
 *
 * Maintenance: when adjusting these patterns, also update the corresponding
 * R1/R2 lists in templates/agents/troubleshooter.md.template so the agent's
 * stated rules and the enforced rules stay in sync.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_PATH = path.join(os.homedir(), '.claude', '.pipecrew-troubleshooter-active');

// ── Anti-evasion checks (run FIRST) ──────────────────────────────────
// We cannot statically analyze arbitrary shell substitution / pipelines,
// so we forbid the constructs an evasive command would rely on.
const EVASION_PATTERNS = [
  { re: /\$\([^)]*\)/, reason: 'command substitution $(...) is forbidden — write the inner command directly so the guard can classify it' },
  { re: /`[^`]*`/, reason: 'backtick command substitution is forbidden — write the inner command directly so the guard can classify it' },
  { re: /(?:^|[;|&]\s*)(eval|exec)\s/, reason: 'standalone eval/exec is forbidden — runs arbitrary unclassifiable code' },
  { re: /\bbase64\s+(-d|--decode)\b.*\|/, reason: 'piping base64 -d into another command is forbidden' },
  { re: />>(?!\s*\/dev\/null\b)/, reason: 'output append redirection (>>) is forbidden — use the Write tool for report.md' },
  { re: /(^|[^>])>(?!>|\s*\/dev\/null\b)/, reason: 'output redirection is forbidden — use the Write tool for report.md' },
  { re: /(^|\s)&\s*$/, reason: 'background execution (trailing &) is forbidden' },
  { re: /\bnohup\b/, reason: 'nohup is forbidden — produces an unsupervised process' },
  { re: /\|\s*(tee|sponge)\b/, reason: 'tee / sponge are writes — use the Write tool instead' },
  { re: /(^|\s)sudo\s/, reason: 'sudo is forbidden — escalation must never happen from this agent' },
];

// ── Blocklist (overrides allowlist if matched) ───────────────────────
const BLOCKLIST = [
  { re: /\baws\s+ssm\s+start-session\b/i, reason: 'aws ssm start-session is shell access — forbidden' },
  { re: /\baws\s+ecs\s+execute-command\b/i, reason: 'aws ecs execute-command is shell access — forbidden' },
  { re: /\baws\s+s3\s+(rm|mv|cp|sync)\b/i, reason: 'AWS S3 mutating verb (rm/mv/cp/sync) — read-only only (use ls / s3api head-object / s3api list-objects-v2)' },
  { re: /\baws\s+\S+\s+(delete|put|create|update|run|start|stop|terminate|reboot|invoke|publish|execute|attach|detach|enable|disable|tag|untag|modify|register|deregister|associate|disassociate|copy|import|export|restore|cancel|abort|reset|rotate)-/i,
    reason: 'AWS mutating verb — read-only only (use describe/get/list/tail/filter)' },
  { re: /\bkubectl\s+(delete|apply|edit|patch|scale|rollout|exec|run|create|replace|cp|drain|cordon|uncordon|label|annotate|taint|expose|autoscale|attach|port-forward)\b/i,
    reason: 'kubectl mutating / shell-access verb — forbidden' },
  { re: /\bdocker\s+(rm|run|exec|kill|start|stop|restart|prune|build|push|pull|create|update|cp|commit|attach|rename|tag|save|load|swarm|service|stack|network\s+create|network\s+rm|volume\s+create|volume\s+rm)\b/i,
    reason: 'docker mutating / shell-access verb — forbidden' },
  { re: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|kill|edit|set-default|isolate)\b/i,
    reason: 'systemctl service control — forbidden' },
  { re: /\bservice\s+\S+\s+(start|stop|restart|reload|force-reload)\b/i,
    reason: 'service control — forbidden' },
  { re: /\bgit\s+(commit|push|rebase|reset|merge|stash|tag|cherry-pick|am|apply|rm|mv|clean|checkout|switch|restore)\b/i,
    reason: 'git mutation / branch-state change — forbidden (investigator must not move HEAD)' },
  { re: /\bgit\s+branch\s+(-d|-D|--delete)\b/i, reason: 'git branch deletion — forbidden' },
  { re: /(^|[\s;|&])(rm|mv|cp|chmod|chown|chgrp|ln|touch|truncate|dd|mkfs|fdisk|parted|wipefs)\s/i,
    reason: 'filesystem mutation — forbidden' },
  { re: /\bsed\s+(?:-[A-Za-z]*\s+)*-i\b/, reason: 'sed -i (in-place) is a write — forbidden' },
  { re: /\bawk\s+.*-i\s+inplace\b/i, reason: 'awk -i inplace is a write — forbidden' },
  { re: /\bperl\s+.*-i\b/i, reason: 'perl -i is a write — forbidden' },
  { re: /\b(npm|yarn|pnpm)\s+(install|uninstall|publish|run|exec|update|audit\s+fix|link|unlink|add|remove)\b/i,
    reason: 'package manager mutation — forbidden' },
  { re: /\bpip[3]?\s+(install|uninstall|wheel)\b/i, reason: 'pip mutation — forbidden' },
  { re: /\bpipx\s+(install|uninstall|upgrade|inject)\b/i, reason: 'pipx mutation — forbidden' },
  { re: /\bgem\s+(install|uninstall|update)\b/i, reason: 'gem mutation — forbidden' },
  { re: /\bcargo\s+(install|publish|run|build)\b/i, reason: 'cargo mutation / build — forbidden' },
  { re: /\bmake\s+(install|deploy|publish|release)\b/i, reason: 'make install/deploy — forbidden' },
  { re: /\bterraform\s+(apply|destroy|import|taint|untaint|state\s+(mv|rm|push))\b/i,
    reason: 'terraform mutation — forbidden (plan is allowed via read-only ops, but apply is not)' },
  { re: /\bcdk\s+(deploy|destroy|bootstrap|migrate|import)\b/i, reason: 'cdk mutation — forbidden' },
  { re: /\bserverless\s+(deploy|remove|invoke)\b/i, reason: 'serverless deploy — forbidden' },
  { re: /\bansible(-playbook)?\s+/i, reason: 'ansible playbook execution can mutate — forbidden; read inventory files instead' },
  { re: /\bcurl\b[^|;&]*\s-X\s+(POST|PUT|PATCH|DELETE)\b(?![^|;&]*\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b)/i,
    reason: 'curl mutating method (POST/PUT/PATCH/DELETE) outside localhost — forbidden' },
  { re: /(?:^|\s)--request\s+(POST|PUT|PATCH|DELETE)\b/i, reason: 'curl --request with mutating verb — forbidden (use localhost only with -X GET)' },
  { re: /\bwget\b.*--post-(data|file)\b/i, reason: 'wget --post — forbidden' },
  { re: /\b(psql|mysql|sqlcmd|sqlite3)\b[^|;]*?\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY)\b/i,
    reason: 'SQL mutation embedded in DB CLI invocation — forbidden' },
  { re: /\bmongosh\b[^|;]*?\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|dropDatabase|dropCollection|drop)\b/i,
    reason: 'mongosh mutation — forbidden' },
  { re: /\bredis-cli\b[^|;]*?\b(SET|DEL|FLUSHALL|FLUSHDB|CONFIG\s+SET|DEBUG\s+SLEEP)\b/i,
    reason: 'redis-cli mutation — forbidden' },
  { re: /\b(?:logs|tail|journalctl)\b[^|;]*\s(-f|--follow)\b/i,
    reason: 'follow mode (-f / --follow) is forbidden — pass --since instead and exit cleanly' },
  { re: /\bkubectl\s+(?:get|describe|top|logs)\s.*--watch\b/i,
    reason: 'kubectl --watch is long-running — pass --since/-l instead' },
  { re: /\bdocker\s+stats\b(?![^|;]*--no-stream)/i,
    reason: 'docker stats without --no-stream is long-running — pass --no-stream' },
  { re: /\bsudo\b/i, reason: 'sudo is forbidden' },
  { re: /\bsu\s+-/i, reason: 'su is forbidden' },
];

// ── Allowlist — explicit allow for the read-only command shapes ──────
const ALLOWLIST = [
  /^aws\s+(logs|ecs|ec2|cloudwatch|iam|sts|s3|s3api|sqs|sns|dynamodb|lambda|cloudformation|ssm)\s+(tail|logs|filter-log-events|get|get-[\w-]+|describe-[\w-]+|list|list-[\w-]+|head-[\w-]+|head|search-[\w-]+|select|test-[\w-]+|estimate-[\w-]+|simulate-[\w-]+)\b/i,
  /^aws\s+sts\s+get-caller-identity\b/i,
  /^aws\s+s3\s+ls\b/i,
  /^aws\s+s3api\s+(list|head|get)-[\w-]+\b/i,
  /^kubectl\s+(logs|get|describe|top|version|config\s+(view|get-[\w-]+|current-context))\b/i,
  /^kubectl\s+api-resources\b/i,
  /^kubectl\s+api-versions\b/i,
  /^kubectl\s+cluster-info\b/i,
  /^docker\s+(logs|ps|inspect|version|info|history|images(\s|$)|search|port|top)\b/i,
  /^docker\s+stats\s.*--no-stream/i,
  /^journalctl\s+(?:[^|;]*?)\s--since\b/i,
  /^git\s+(log|diff|show|blame|rev-parse|status|remote(\s+-v)?|ls-files|ls-tree|cat-file|describe|reflog|shortlog|fsck|count-objects|grep|whatchanged|notes\s+show|version|config\s+--get|config\s+--list)\b/i,
  /^git\s+branch(\s+(-a|-r|-v|--list))?\s*$/i,
  /^git\s+tag(\s+(-l|--list))?\s*$/i,
  /^(grep|rg|ripgrep|ack|ag|ls|find|tree|cat|head|tail|wc|sort|uniq|awk|sed(?!\s+-i)|cut|tr|column|xargs|file|stat|du|df|free|uptime|whoami|id|env|printenv|date|hostname|uname|which|type|command|alias|history|tee\s+\/dev\/null)\b/,
  /^curl\s+(?:[^|;&]*\s)?-X\s+(GET|HEAD|OPTIONS)\s+(?:[^|;&]*\s)?(?:https?:\/\/)?(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b/i,
  /^curl\s+(?:[^|;&]*\s)?(?:https?:\/\/)?(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b/i,
  /^(dig|nslookup|host|ping(\s+-[cnW]\s+\d+)+|traceroute|tracepath|mtr\s+--report)\b/,
  /^node\s+\S*\b(extract-block|extract-observability|validate-observability|validate-config|validate-checkpoints|validate-claude-md)\.js\b/,
];

// ── Pure classifier: command string → { allow, reason } ─────────────────────
function classifyCommand(cmd) {
  if (!cmd) return { allow: false, reason: 'empty command' };
  // Normalize: collapse whitespace, drop leading "bash -c" / "sh -c" wrappers.
  let normalized = cmd.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^(?:bash|sh|zsh)\s+-c\s+['"]?/, '');

  for (const p of EVASION_PATTERNS) if (p.re.test(normalized)) return { allow: false, reason: p.reason };
  for (const p of BLOCKLIST) if (p.re.test(normalized)) return { allow: false, reason: p.reason };
  for (const p of ALLOWLIST) if (p.test(normalized)) return { allow: true, reason: null };
  return { allow: false, reason: 'command did not match the read-only allowlist' };
}

// ── Marker gate (hook mode): true only when a /troubleshoot run is live ──────
function markerActive() {
  let marker;
  try { marker = fs.readFileSync(MARKER_PATH, 'utf8').trim(); }
  catch (_) { marker = null; }
  if (!marker) return false;
  // Marker contents: "pid=<n> run_id=<id> created_at=<iso>". Stale (dead pid) → no-op.
  const pidMatch = marker.match(/pid=(\d+)/);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; }   // signal 0 = liveness probe
    catch (_) { alive = false; }
    if (!alive) {
      try { fs.unlinkSync(MARKER_PATH); } catch (_) { /* ignore */ }
      return false;
    }
  }
  return true;
}

module.exports = { classifyCommand, markerActive, MARKER_PATH };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  let cmd;
  let invokedFromHook = false;

  if (process.argv[2]) {
    // Mode 3: argv — explicit caller, no marker check.
    cmd = process.argv.slice(2).join(' ');
  } else {
    // Mode 1 or 2: stdin. Try JSON (hook payload) first; fall back to raw command.
    let raw;
    try { raw = fs.readFileSync(0, 'utf8').trim(); } catch (_) { raw = ''; }

    if (raw.startsWith('{')) {
      try {
        const payload = JSON.parse(raw);
        if (payload && payload.tool_name === 'Bash' && payload.tool_input && typeof payload.tool_input.command === 'string') {
          cmd = payload.tool_input.command;
          invokedFromHook = true;
        } else {
          // Unknown JSON shape from a hook (e.g. a non-Bash tool). Allow — never
          // block a non-Bash dispatch.
          process.exit(0);
        }
      } catch (_) {
        cmd = raw; // looked like JSON but didn't parse — treat as raw command
      }
    } else {
      cmd = raw;
    }
  }

  // Marker-file self-gating (hook mode only).
  if (invokedFromHook && !markerActive()) process.exit(0);

  const { allow, reason } = classifyCommand(cmd);
  if (allow) process.exit(0);
  console.error(`DENY: ${reason}`);
  console.error(`  command: ${cmd}`);
  process.exit(1);
}
