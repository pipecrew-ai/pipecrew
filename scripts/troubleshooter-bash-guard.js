#!/usr/bin/env node
/**
 * Bash command guard for the troubleshooter agent.
 *
 * The troubleshooter agent's system prompt declares it operates in
 * READ-ONLY mode (see HARD RULES in templates/agents/troubleshooter.md.template).
 * The agent itself enforces those rules in its reasoning, but agents make
 * mistakes — this guard is the defense-in-depth layer.
 *
 * INVOCATION MODES (auto-detected):
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
 *      No marker check — runs the full allow/deny logic. Useful for
 *      orchestrator-level pre-checks or piping from other agents.
 *
 *   3. argv (manual / test harness).
 *        node troubleshooter-bash-guard.js "aws logs tail /aws/x"
 *      No marker check — runs the full allow/deny logic.
 *
 * MARKER-FILE SELF-GATING (hook mode only):
 *
 *   Plugin-shipped hooks fire on EVERY Bash dispatch from EVERY agent in
 *   the user's session, and Claude Code's matcher syntax has no
 *   "agentMatcher" to scope a hook to one specific subagent. We work
 *   around this with a marker file:
 *
 *     - The /troubleshoot skill writes ~/.claude/.pipecrew-troubleshooter-active
 *       (containing the orchestrator's pid + run_id) before dispatching the
 *       troubleshooter agent, and removes it on completion (or on error).
 *     - When the hook fires, this script first checks the marker. If the
 *       marker is absent OR points at a dead pid, it exits 0 immediately
 *       — the hook becomes a no-op. Other agents (implementers, reviewers,
 *       the user's own Bash calls) are completely unaffected.
 *     - Only when the marker is present AND the pid is alive does the
 *       script proceed to the allow/deny classifier.
 *
 *   Plain-stdin and argv modes (#2 / #3) skip the marker check — those
 *   callers explicitly opted in to enforcement.
 *
 * EXIT CODES:
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

// ── Read input ─────────────────────────────────────────────────────────
//
// Three input shapes; auto-detect.

let cmd;
let invokedFromHook = false;

if (process.argv[2]) {
  // Mode 3: argv — explicit caller, no marker check.
  cmd = process.argv.slice(2).join(' ');
} else {
  // Mode 1 or 2: stdin. Try to parse as JSON first (hook payload); fall
  // back to raw command string.
  let raw;
  try { raw = fs.readFileSync(0, 'utf8').trim(); }
  catch { raw = ''; }

  if (raw.startsWith('{')) {
    try {
      const payload = JSON.parse(raw);
      // Validate it's actually a Bash PreToolUse payload — anything else
      // we can't classify safely; allow rather than deny so we don't
      // accidentally break a non-Bash hook.
      if (payload && payload.tool_name === 'Bash' && payload.tool_input && typeof payload.tool_input.command === 'string') {
        cmd = payload.tool_input.command;
        invokedFromHook = true;
      } else {
        // Unknown JSON shape on stdin from a hook. Allow — better than
        // accidentally blocking legitimate non-Bash tool calls if Claude
        // Code routes a different event our way.
        process.exit(0);
      }
    } catch {
      // Looked like JSON but didn't parse. Treat as raw command.
      cmd = raw;
    }
  } else {
    cmd = raw;
  }
}

// ── Marker-file self-gating (hook mode only) ───────────────────────────
//
// In hook mode, we need to make sure we ONLY classify Bash calls coming
// from a /troubleshoot run. The marker file is the signal.

if (invokedFromHook) {
  let marker;
  try { marker = fs.readFileSync(MARKER_PATH, 'utf8').trim(); }
  catch { marker = null; }

  if (!marker) {
    // No active /troubleshoot run — this Bash call is from a different
    // agent or a different skill. Allow without classifying.
    process.exit(0);
  }

  // Marker contents: "pid=<n> run_id=<id> created_at=<iso>". Parse and
  // verify the pid is still alive. Stale marker (process died without
  // cleanup) → treat as no marker.
  const pidMatch = marker.match(/pid=(\d+)/);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; }   // signal 0 = liveness probe
    catch { alive = false; }
    if (!alive) {
      // Stale marker — orchestrator died without cleanup. Best-effort
      // remove it so the next session starts clean, then allow this call.
      try { fs.unlinkSync(MARKER_PATH); } catch { /* ignore */ }
      process.exit(0);
    }
  }
  // Marker present + pid alive → fall through to the classifier.
}

if (!cmd) {
  // Empty command should never reach the classifier; in hook mode we
  // already exited above on the marker check, so this only fires for
  // explicit empty argv/stdin invocations.
  console.error('troubleshooter-bash-guard: empty command');
  process.exit(1);
}

// Normalize: collapse whitespace, drop leading "bash -c" / "sh -c" wrappers.
let normalized = cmd.replace(/\s+/g, ' ').trim();
normalized = normalized.replace(/^(?:bash|sh|zsh)\s+-c\s+['"]?/, '');

// ── Anti-evasion checks (run FIRST) ──────────────────────────────────
// We cannot statically analyze arbitrary shell substitution / pipelines,
// so we forbid the constructs an evasive command would rely on.

const EVASION_PATTERNS = [
  // Shell substitution that could hide a forbidden inner command
  { re: /\$\([^)]*\)/, reason: 'command substitution $(...) is forbidden — write the inner command directly so the guard can classify it' },
  { re: /`[^`]*`/, reason: 'backtick command substitution is forbidden — write the inner command directly so the guard can classify it' },
  // Base64 / standalone eval / exec — classic obfuscation. Anchored to
  // start-of-command or a preceding shell separator so we don't false-positive
  // on subcommands like `kubectl exec` or flag args like `--eval`.
  // Only match `eval`/`exec` when starting a command segment — after start-of-string
  // or a shell separator (`;` / `|` / `&`). Plain-space prefix (e.g. `kubectl exec`)
  // is a SUBCOMMAND, not a shell builtin invocation, and is handled by its own rule.
  { re: /(?:^|[;|&]\s*)(eval|exec)\s/, reason: 'standalone eval/exec is forbidden — runs arbitrary unclassifiable code' },
  { re: /\bbase64\s+(-d|--decode)\b.*\|/, reason: 'piping base64 -d into another command is forbidden' },
  // Output redirect: append `>>` first (more specific), then single `>`.
  // Both forbidden EXCEPT redirecting to /dev/null.
  { re: />>(?!\s*\/dev\/null\b)/, reason: 'output append redirection (>>) is forbidden — use the Write tool for report.md' },
  { re: /(^|[^>])>(?!>|\s*\/dev\/null\b)/, reason: 'output redirection is forbidden — use the Write tool for report.md' },
  // Backgrounding
  { re: /(^|\s)&\s*$/, reason: 'background execution (trailing &) is forbidden' },
  { re: /\bnohup\b/, reason: 'nohup is forbidden — produces an unsupervised process' },
  // tee / sponge / sudo
  { re: /\|\s*(tee|sponge)\b/, reason: 'tee / sponge are writes — use the Write tool instead' },
  { re: /(^|\s)sudo\s/, reason: 'sudo is forbidden — escalation must never happen from this agent' },
];

for (const p of EVASION_PATTERNS) {
  if (p.re.test(normalized)) {
    console.error(`DENY: ${p.reason}`);
    console.error(`  command: ${cmd}`);
    process.exit(1);
  }
}

// ── Blocklist (overrides allowlist if matched) ───────────────────────

const BLOCKLIST = [
  // Shell-access into AWS workloads — checked FIRST so a more useful "shell
  // access" message wins over the generic "mutating verb" message.
  { re: /\baws\s+ssm\s+start-session\b/i, reason: 'aws ssm start-session is shell access — forbidden' },
  { re: /\baws\s+ecs\s+execute-command\b/i, reason: 'aws ecs execute-command is shell access — forbidden' },
  // AWS S3 high-level commands use bare verbs (rm/mv/cp/sync), not hyphenated.
  // Checked BEFORE the generic filesystem-rm rule so it gets the AWS message.
  { re: /\baws\s+s3\s+(rm|mv|cp|sync)\b/i, reason: 'AWS S3 mutating verb (rm/mv/cp/sync) — read-only only (use ls / s3api head-object / s3api list-objects-v2)' },
  // AWS API mutations — match `aws <service> <verb>` where verb is mutating
  { re: /\baws\s+\S+\s+(delete|put|create|update|run|start|stop|terminate|reboot|invoke|publish|execute|attach|detach|enable|disable|tag|untag|modify|register|deregister|associate|disassociate|copy|import|export|restore|cancel|abort|reset|rotate)-/i,
    reason: 'AWS mutating verb — read-only only (use describe/get/list/tail/filter)' },

  // kubectl mutations
  { re: /\bkubectl\s+(delete|apply|edit|patch|scale|rollout|exec|run|create|replace|cp|drain|cordon|uncordon|label|annotate|taint|expose|autoscale|attach|port-forward)\b/i,
    reason: 'kubectl mutating / shell-access verb — forbidden' },

  // Docker mutations
  { re: /\bdocker\s+(rm|run|exec|kill|start|stop|restart|prune|build|push|pull|create|update|cp|commit|attach|rename|tag|save|load|swarm|service|stack|network\s+create|network\s+rm|volume\s+create|volume\s+rm)\b/i,
    reason: 'docker mutating / shell-access verb — forbidden' },

  // Service control
  { re: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|kill|edit|set-default|isolate)\b/i,
    reason: 'systemctl service control — forbidden' },
  { re: /\bservice\s+\S+\s+(start|stop|restart|reload|force-reload)\b/i,
    reason: 'service control — forbidden' },

  // Git mutations (the investigator never moves HEAD)
  { re: /\bgit\s+(commit|push|rebase|reset|merge|stash|tag|cherry-pick|am|apply|rm|mv|clean|checkout|switch|restore)\b/i,
    reason: 'git mutation / branch-state change — forbidden (investigator must not move HEAD)' },
  { re: /\bgit\s+branch\s+(-d|-D|--delete)\b/i, reason: 'git branch deletion — forbidden' },

  // Filesystem mutations — match a leading-word command (so "logs:" etc don't false-positive)
  { re: /(^|[\s;|&])(rm|mv|cp|chmod|chown|chgrp|ln|touch|truncate|dd|mkfs|fdisk|parted|wipefs)\s/i,
    reason: 'filesystem mutation — forbidden' },
  { re: /\bsed\s+(?:-[A-Za-z]*\s+)*-i\b/, reason: 'sed -i (in-place) is a write — forbidden' },
  { re: /\bawk\s+.*-i\s+inplace\b/i, reason: 'awk -i inplace is a write — forbidden' },
  { re: /\bperl\s+.*-i\b/i, reason: 'perl -i is a write — forbidden' },

  // Package managers
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

  // HTTP mutations — POST/PUT/PATCH/DELETE EXCEPT against localhost
  // (curl GET against localhost is allowed; we need to block non-localhost mutations)
  { re: /\bcurl\b[^|;&]*\s-X\s+(POST|PUT|PATCH|DELETE)\b(?![^|;&]*\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b)/i,
    reason: 'curl mutating method (POST/PUT/PATCH/DELETE) outside localhost — forbidden' },
  { re: /(?:^|\s)--request\s+(POST|PUT|PATCH|DELETE)\b/i, reason: 'curl --request with mutating verb — forbidden (use localhost only with -X GET)' },
  { re: /\bwget\b.*--post-(data|file)\b/i, reason: 'wget --post — forbidden' },

  // Database mutations
  { re: /\b(psql|mysql|sqlcmd|sqlite3)\b[^|;]*?\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY)\b/i,
    reason: 'SQL mutation embedded in DB CLI invocation — forbidden' },
  { re: /\bmongosh\b[^|;]*?\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|dropDatabase|dropCollection|drop)\b/i,
    reason: 'mongosh mutation — forbidden' },
  { re: /\bredis-cli\b[^|;]*?\b(SET|DEL|FLUSHALL|FLUSHDB|CONFIG\s+SET|DEBUG\s+SLEEP)\b/i,
    reason: 'redis-cli mutation — forbidden' },

  // Long-running / interactive flags on otherwise-allowed commands
  { re: /\b(?:logs|tail|journalctl)\b[^|;]*\s(-f|--follow)\b/i,
    reason: 'follow mode (-f / --follow) is forbidden — pass --since instead and exit cleanly' },
  { re: /\bkubectl\s+(?:get|describe|top|logs)\s.*--watch\b/i,
    reason: 'kubectl --watch is long-running — pass --since/-l instead' },
  { re: /\bdocker\s+stats\b(?![^|;]*--no-stream)/i,
    reason: 'docker stats without --no-stream is long-running — pass --no-stream' },

  // Privilege / shell escapes
  { re: /\bsudo\b/i, reason: 'sudo is forbidden' },
  { re: /\bsu\s+-/i, reason: 'su is forbidden' },
];

for (const p of BLOCKLIST) {
  if (p.re.test(normalized)) {
    console.error(`DENY: ${p.reason}`);
    console.error(`  command: ${cmd}`);
    process.exit(1);
  }
}

// ── Allowlist — explicit allow for the read-only command shapes ──────
//
// We allow if the command's leading verb (after any pipe) is on this list.
// The blocklist above already cleared the obvious mutations; this layer
// ensures we don't allow random unknown binaries that aren't expressly
// approved (e.g. some custom CLI that mutates).

const ALLOWLIST = [
  // AWS read
  /^aws\s+(logs|ecs|ec2|cloudwatch|iam|sts|s3|s3api|sqs|sns|dynamodb|lambda|cloudformation|ssm)\s+(tail|logs|filter-log-events|get|get-[\w-]+|describe-[\w-]+|list|list-[\w-]+|head-[\w-]+|head|search-[\w-]+|select|test-[\w-]+|estimate-[\w-]+|simulate-[\w-]+)\b/i,
  /^aws\s+sts\s+get-caller-identity\b/i,
  /^aws\s+s3\s+ls\b/i,
  /^aws\s+s3api\s+(list|head|get)-[\w-]+\b/i,

  // kubectl read
  /^kubectl\s+(logs|get|describe|top|version|config\s+(view|get-[\w-]+|current-context))\b/i,
  /^kubectl\s+api-resources\b/i,
  /^kubectl\s+api-versions\b/i,
  /^kubectl\s+cluster-info\b/i,

  // docker read
  /^docker\s+(logs|ps|inspect|version|info|history|images(\s|$)|search|port|top)\b/i,
  /^docker\s+stats\s.*--no-stream/i,

  // journalctl read with --since (not --follow)
  /^journalctl\s+(?:[^|;]*?)\s--since\b/i,

  // git read
  /^git\s+(log|diff|show|blame|rev-parse|status|remote(\s+-v)?|ls-files|ls-tree|cat-file|describe|reflog|shortlog|fsck|count-objects|grep|whatchanged|notes\s+show|version|config\s+--get|config\s+--list)\b/i,
  /^git\s+branch(\s+(-a|-r|-v|--list))?\s*$/i,
  /^git\s+tag(\s+(-l|--list))?\s*$/i,

  // Plain shell read
  /^(grep|rg|ripgrep|ack|ag|ls|find|tree|cat|head|tail|wc|sort|uniq|awk|sed(?!\s+-i)|cut|tr|column|xargs|file|stat|du|df|free|uptime|whoami|id|env|printenv|date|hostname|uname|which|type|command|alias|history|tee\s+\/dev\/null)\b/,

  // Local-only HTTP / connectivity diagnostics
  /^curl\s+(?:[^|;&]*\s)?-X\s+(GET|HEAD|OPTIONS)\s+(?:[^|;&]*\s)?(?:https?:\/\/)?(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b/i,
  /^curl\s+(?:[^|;&]*\s)?(?:https?:\/\/)?(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b/i,
  /^(dig|nslookup|host|ping(\s+-[cnW]\s+\d+)+|traceroute|tracepath|mtr\s+--report)\b/,

  // Node / scripts the agent is allowed to run (the plugin's own extractors / validators)
  /^node\s+\S*\b(extract-block|extract-observability|validate-observability|validate-config|validate-checkpoints|validate-claude-md)\.js\b/,
];

for (const p of ALLOWLIST) {
  if (p.test(normalized)) {
    process.exit(0);
  }
}

// Not on allowlist and didn't match blocklist either → deny conservatively.
console.error('DENY: command did not match the read-only allowlist');
console.error('  If this is a legitimate read-only command, update either:');
console.error('    - HARD RULE R1 in templates/agents/troubleshooter.md.template');
console.error('    - the ALLOWLIST in scripts/troubleshooter-bash-guard.js');
console.error(`  command: ${cmd}`);
process.exit(1);
