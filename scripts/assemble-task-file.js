#!/usr/bin/env node
/**
 * Assemble a Phase 4.5 per-task markdown file deterministically.
 *
 * Why: the task-planner agent used to generate every task file token-by-token
 * through the LLM, reproducing large verbatim blocks (FR/EC bodies, architecture
 * context, Contract Reference, Out-of-Scope) that already exist on disk under
 * {run_dir}/outputs/. For a multi-repo feature that is 10-15 files of pure
 * photocopying — the dominant cost of `persist` mode. This script takes the LLM
 * out of the copy loop: the planner computes ONLY the two judgment payloads it
 * genuinely reasons about (the sub-task checklist and the stack-specific
 * anti-pattern selection) and passes them in; this script reads every pure-copy
 * source itself and writes the complete, self-contained task file.
 *
 * The emitted file is section-structure-equivalent to the hand-built template in
 * agents/task-planner.md (same frontmatter keys, same headings, same order) so
 * Phase 5 implementers see no change.
 *
 * Usage:
 *   node assemble-task-file.js --run-dir <path> --descriptor <file.json> \
 *        [--arch-md <path>] [--config <config.json>] [--out-dir <path>]
 *
 *   --descriptor  JSON: a single task-descriptor object OR an array of them.
 *   --arch-md     phase-2-architecture.md (default {run_dir}/outputs/phase-2-architecture.md)
 *   --config      workspace config.json — for worktree fallback paths (optional)
 *   --out-dir     where task files are written (default {run_dir}/tasks)
 *
 * Descriptor fields (per task):
 *   task_id, feature_slug, repo_key, repo_role, repo_type, tier, title,
 *   fr_refs[], spec_policy, spec_file?, worktree_path|null,
 *   fe_refs?: { component_ids[], route_ids[], api_ids[] }   (frontend only)
 *   checklist_md         (judgment payload — the "## Sub-task checklist" body)
 *   anti_pattern_bullets[] (judgment payload — selected stack-specific bullets)
 *   deferred_extra[]?     (minimum-only: deferred sub-task lines for Out of Scope)
 *
 * Exit codes:
 *   0 — all task files written
 *   1 — a required input file is missing / unreadable
 *   2 — usage error
 *   3 — an fr_ref is not present in requirements-index.json (fail loud)
 *   4 — an fe_ref names an id absent from frontend-architecture.json (fail loud)
 *   5 — an FR/EC body could not be found in phase-1-requirements.md (fail loud)
 *   6 — write failure
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

// ---------- arg parsing ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function die(code, msg) {
  console.error(`assemble-task-file: ${msg}`);
  process.exit(code);
}

const runDir = args['run-dir'];
const descriptorPath = args['descriptor'];
if (!runDir || !descriptorPath) {
  die(2, 'Usage: assemble-task-file.js --run-dir <path> --descriptor <file.json> [--arch-md <p>] [--config <p>] [--out-dir <p>]');
}

const archMd = args['arch-md'] || path.join(runDir, 'outputs', 'phase-2-architecture.md');
const outDir = args['out-dir'] || path.join(runDir, 'tasks');
const configPath = args['config'] || null;

// ---------- small IO helpers ----------

function readFileOr(code, p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    die(code, `cannot read ${p} (${e.message})`);
  }
}

function readJsonOr(code, p) {
  return JSON.parse(readFileOr(code, p));
}

function readBlockJson(name) {
  // outputs/blocks/<name>.json — materialized by split-design.js. Null if absent.
  const p = path.join(runDir, 'outputs', 'blocks', `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(1, `blocks/${name}.json is not valid JSON (${e.message})`);
  }
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// ---------- block prose extraction (mirrors extract-block.js --raw) ----------

function extractBlockRaw(content, blockName) {
  const begin = content.indexOf(`<!-- BEGIN ${blockName} -->`);
  const end = content.indexOf(`<!-- END ${blockName} -->`);
  if (begin === -1 || end === -1 || end < begin) return null;
  const body = content.slice(begin + `<!-- BEGIN ${blockName} -->`.length, end);
  return body.trim();
}

// Strip the leading ```json … ``` fence from a block body, leaving the prose.
function blockProseOnly(blockBody) {
  if (!blockBody) return '';
  return blockBody.replace(/```json\s*\n[\s\S]*?\n```/, '').trim();
}

// ---------- FR/EC body extraction from phase-1-requirements.md ----------
// Bodies are bullet lines: `- FR-1: <text>` / `- EC-2: <text>` under the
// FUNCTIONAL_REQUIREMENTS / EDGE_CASES sections. A body may continue on
// subsequent indented lines.

function buildRequirementBodyIndex(reqMd) {
  const lines = reqMd.split(/\r?\n/);
  const index = {};
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*((?:FR|EC)-\d+)\s*:\s*(.*)$/);
    if (m) {
      current = m[1];
      index[current] = m[2].trim();
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      // continuation line for the current requirement
      index[current] += '\n' + line.trim();
      continue;
    }
    if (line.trim() === '' || /^#/.test(line) || /^<!--/.test(line)) {
      current = null;
    }
  }
  return index;
}

// ---------- section builders ----------

function fm(descriptor, now) {
  const reqRefs = (descriptor.fr_refs || []).join(', ');
  const title = `${descriptor.repo_role}: ${descriptor.repo_key} — ${descriptor.title}`;
  return [
    '---',
    `id: ${descriptor.task_id}`,
    `feature: ${descriptor.feature_slug}`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    'status: todo',
    'phase: "4.5"',
    'severity: ""',
    `repo: "${descriptor.repo_key}"`,
    `requirement_refs: "${reqRefs}"`,
    'file_refs: ""',
    `created_at: ${now}`,
    `updated_at: ${now}`,
    'cumulative_duration_ms: 0',
    'cumulative_total_tokens: 0',
    'invocation_count: 0',
    'last_worked_by: ""',
    '---',
  ].join('\n');
}

function summarySection(descriptor) {
  return `## Summary\n${descriptor.title}${descriptor.summary ? ` — ${descriptor.summary}` : ''}.`;
}

function checklistSection(descriptor) {
  const body = (descriptor.checklist_md || '').trim();
  return `## Sub-task checklist\n${body || '_(none provided)_'}`;
}

function requirementsSection(descriptor, bodyIndex, reqIndex) {
  const refs = descriptor.fr_refs || [];
  const known = new Set([
    ...(reqIndex.requirements || []).map(r => r.id),
    ...(reqIndex.edge_cases || []).map(r => r.id),
  ]);
  const lines = ['## Functional requirements to enforce', ''];
  for (const id of refs) {
    if (!known.has(id)) {
      die(3, `fr_ref '${id}' (task ${descriptor.task_id}) is not present in requirements-index.json`);
    }
    const body = bodyIndex[id];
    if (body === undefined) {
      die(5, `FR/EC body for '${id}' not found in phase-1-requirements.md — PO heading/bullet format drift (task ${descriptor.task_id})`);
    }
    lines.push(`- **${id}**: ${body}`);
  }
  if (refs.length === 0) lines.push('_(none traced to this sub-task)_');
  return lines.join('\n');
}

function backendArchSection(descriptor) {
  const parts = ['## Architecture context', ''];
  const dm = readBlockJson('data-model');
  if (dm) {
    const entities = (dm.entities || []).filter(
      e => !e.service || e.service === descriptor.repo_key,
    );
    const dbc = (dm.database_changes || []).filter(
      c => !c.service || c.service === descriptor.repo_key,
    );
    if (entities.length || dbc.length) {
      parts.push('### Data model');
      parts.push('```json');
      parts.push(JSON.stringify({ entities, database_changes: dbc }, null, 2));
      parts.push('```');
    }
  }
  const ad = readBlockJson('api-design');
  if (ad) {
    const svc = (ad.services || []).find(s => s.name === descriptor.repo_key);
    if (svc) {
      parts.push('### API design (this service)');
      parts.push('```json');
      parts.push(JSON.stringify(svc, null, 2));
      parts.push('```');
    }
  }
  if (parts.length === 2) parts.push('_(no structured architecture blocks for this repo)_');
  return parts.join('\n');
}

function frontendArchSection(descriptor, archContent) {
  const fa = readBlockJson('frontend-architecture') || { components: [], routes: [], api_integration: [] };
  const refs = descriptor.fe_refs || { component_ids: [], route_ids: [], api_ids: [] };

  // Resolve by id when the entries carry ids (new schema). Fall back to name/path
  // when ids are absent (old-schema skeleton — EC-7 graceful degradation).
  const hasIds = (fa.components || []).some(c => c.id);
  let components, routes, apis;
  if (hasIds && refs.component_ids) {
    const want = (ids) => (arr, key = 'id') => (arr || []).filter(x => (ids || []).includes(x[key]));
    components = want(refs.component_ids)(fa.components);
    routes = want(refs.route_ids)(fa.routes);
    apis = want(refs.api_ids)(fa.api_integration);
    // Fail loud on dangling fe_refs.
    const allIds = new Set([
      ...(fa.components || []).map(c => c.id),
      ...(fa.routes || []).map(r => r.id),
      ...(fa.api_integration || []).map(a => a.id),
    ]);
    for (const id of [...(refs.component_ids || []), ...(refs.route_ids || []), ...(refs.api_ids || [])]) {
      if (!allIds.has(id)) die(4, `fe_ref '${id}' not found in frontend-architecture.json (task ${descriptor.task_id})`);
    }
  } else {
    // Old-schema fallback: the planner passes pre-filtered arrays directly.
    components = descriptor.fe_components || fa.components || [];
    routes = descriptor.fe_routes || fa.routes || [];
    apis = descriptor.fe_api || fa.api_integration || [];
  }

  const parts = ['## Architecture context', ''];
  parts.push('## Components to build');
  if (components.length) {
    for (const c of components) {
      parts.push(`- ${c.name} (${c.path}, kind=${c.kind || 'component'}, change_kind=${c.change_kind})${c.purpose ? ` — ${c.purpose}` : ''}`);
      if (Array.isArray(c.children) && c.children.length) {
        for (const ch of c.children) parts.push(`  - ${ch}`);
      }
    }
  } else parts.push('_(none)_');

  parts.push('', '## Routes affected');
  if (routes.length) {
    for (const r of routes) parts.push(`- ${r.path} (${r.change_kind}, page=${r.page_component}, guard=${r.guard == null ? 'public' : r.guard})`);
  } else parts.push('_(none)_');

  parts.push('', '## API integration');
  if (apis.length) {
    for (const a of apis) parts.push(`- ${a.service_function} (${a.file}) → ${a.endpoint} [req ${a.request_type}, res ${a.response_type}]`);
  } else parts.push('_(none)_');

  // Append the FRONTEND_ARCHITECTURE prose (state mgmt, i18n, styling) — the JSON
  // doesn't carry it. Trim everything before the detail-prose heading when present.
  if (archContent) {
    const raw = extractBlockRaw(archContent, 'FRONTEND_ARCHITECTURE');
    let prose = blockProseOnly(raw);
    const idx = prose.indexOf('## Frontend Architecture — detail (prose)');
    if (idx !== -1) prose = prose.slice(idx);
    if (prose) {
      parts.push('', prose);
    }
  }
  return parts.join('\n');
}

function mockArchSection() {
  const ad = readBlockJson('api-design');
  const parts = ['## Architecture context', ''];
  if (ad) {
    parts.push('```json');
    parts.push(JSON.stringify(ad, null, 2));
    parts.push('```');
  } else parts.push('_(no API_DESIGN block)_');
  return parts.join('\n');
}

function infraArchSection() {
  const ii = readBlockJson('infrastructure-impact');
  const parts = ['## Architecture context', ''];
  if (ii) {
    parts.push('```json');
    parts.push(JSON.stringify(ii, null, 2));
    parts.push('```');
  } else parts.push('_(no INFRASTRUCTURE_IMPACT block)_');
  return parts.join('\n');
}

function architectureSection(descriptor, archContent) {
  switch (descriptor.repo_role) {
    case 'frontend': return frontendArchSection(descriptor, archContent);
    case 'mock-server': return mockArchSection();
    case 'infrastructure': return infraArchSection();
    default: return backendArchSection(descriptor); // api-service / worker
  }
}

function resolveRepoPath(descriptor) {
  if (descriptor.worktree_path) return descriptor.worktree_path;
  if (configPath && fileExists(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const repo = cfg.repos && cfg.repos[descriptor.repo_key];
      if (repo && repo.path) return repo.path;
    } catch { /* fall through */ }
  }
  return null;
}

function contractReferenceSection(descriptor, archContent) {
  const role = descriptor.repo_role;
  if (role !== 'api-service' && role !== 'worker') return null; // omitted for fe/mock/infra

  const parts = ['## Contract Reference', ''];
  const repoPath = resolveRepoPath(descriptor);

  if (descriptor.spec_policy === 'api-first') {
    const specAbs = descriptor.spec_file && repoPath
      ? `${repoPath.replace(/[\\/]+$/, '')}/${descriptor.spec_file}`
      : (descriptor.spec_file || '(spec path unresolved — worktree + spec_file both absent)');
    parts.push('**Spec policy**: `api-first`');
    parts.push(`**Spec file**: \`${specAbs}\` (absolute path inside the worktree)`);
    parts.push('');
    parts.push('**Endpoints (match spec field names byte-for-byte)**:');
    const ad = readBlockJson('api-design');
    const svc = ad && (ad.services || []).find(s => s.name === descriptor.repo_key);
    const eps = (svc && svc.endpoints) || [];
    if (eps.length) {
      for (const e of eps) parts.push(`- ${e.method} ${e.path} — ${e.summary || ''} ${(e.change_kind ? `(${e.change_kind})` : '')}`.trim());
    } else parts.push('- _(no endpoints enumerated for this service in API_DESIGN)_');
    parts.push('');
    parts.push('The spec is the source of truth — never rename a field, never change a type. If the spec is wrong, stop and flag it.');
  } else if (descriptor.spec_policy === 'code-first') {
    parts.push('**Spec policy**: code-first / **Spec file**: —');
    parts.push('');
    // Self-contained superset: include the full API_DESIGN prose (carries the inline contract).
    const prose = blockProseOnly(extractBlockRaw(archContent, 'API_DESIGN'));
    parts.push(prose || '_(no API_DESIGN prose found — re-architecture needed)_');
    parts.push('');
    parts.push('Deviation requires re-architecture (Phase 2 redo), not implementer judgment.');
  } else if (descriptor.spec_policy === 'no-api') {
    parts.push('**Spec policy**: `no-api` (event-driven worker)');
    parts.push('');
    const prose = blockProseOnly(extractBlockRaw(archContent, 'API_DESIGN'));
    if (prose) parts.push(prose);
    const ac = readBlockJson('affected-contracts');
    if (ac && Array.isArray(ac.contracts)) {
      parts.push('', '**Event schema files**:');
      for (const c of ac.contracts) {
        for (const f of (c.files || [])) {
          parts.push(`- ${c.repo_key}: \`${f.path}\` (${f.change_kind}, ${f.classification})`);
        }
      }
    }
  } else {
    return null;
  }
  return parts.join('\n');
}

function worktreeSection(descriptor) {
  const parts = ['## Worktree path', ''];
  if (descriptor.worktree_path) {
    parts.push(descriptor.worktree_path);
  } else {
    parts.push(`TBD — Phase 5 will create a worktree at ${descriptor.repo_key}-${descriptor.feature_slug}`);
  }
  return parts.join('\n');
}

function antiPatternsSection(descriptor, auditFindings) {
  const stack = (descriptor.anti_pattern_bullets || []).filter(Boolean);
  const findings = auditFindings || [];
  if (stack.length + findings.length < 3) return null; // dilutes signal — omit (EC-5)

  const parts = ['## Known Anti-Patterns', ''];
  parts.push('Stack-specific traps to actively avoid in this repo. These are the predictable failure modes that derailed prior implementations.', '');
  if (stack.length) {
    parts.push(`### Stack-specific (${descriptor.repo_type})`);
    for (const b of stack) parts.push(`- ${b}`);
  }
  if (findings.length) {
    parts.push('', '### Workspace-specific findings from onboarding');
    for (const f of findings) parts.push(`- ${f}`);
  }
  return parts.join('\n');
}

function outOfScopeSection(descriptor, reqMd) {
  const parts = ['## Out of Scope', ''];
  const items = [];

  // Prose OUT_OF_SCOPE / Non-goals from phase-1 (whole-feature; included for context).
  const oos = extractBlockRaw(reqMd, 'OUT_OF_SCOPE');
  if (oos) {
    const bullets = oos.split(/\r?\n/).filter(l => /^\s*[-*]\s+/.test(l));
    for (const b of bullets) items.push(b.replace(/^\s*[-*]\s+/, '').trim());
  }

  // RISKS deferred_items owned by this repo (or cross-repo null). Fail loud if missing.
  const risks = readBlockJson('risks');
  if (!risks) {
    die(1, 'RISKS block (risks.json) missing or not materialized — re-dispatch the architect');
  }
  for (const d of (risks.deferred_items || [])) {
    if (d.owning_repo === descriptor.repo_key || d.owning_repo == null) {
      items.push(`[${d.tag}] ${d.summary} — ${d.rationale}`);
    }
  }

  // Deferred sub-tasks for this repo (minimum-only slice).
  for (const line of (descriptor.deferred_extra || [])) items.push(line);

  if (!items.length) {
    parts.push('*(none — every requirement traced to this repo is in scope)*');
  } else {
    for (const it of items) parts.push(`- ${it}`);
  }
  return parts.join('\n');
}

// The report format is NOT pasted per task file — it lives once in
// rules/implementer-common.md § "Final report delivery", which every implementer
// loads on every dispatch. Duplicating it here was ~7 identical lines in every file.

// ---------- assemble one task file ----------

function assembleOne(descriptor, ctx) {
  const now = new Date().toISOString();
  const sections = [
    fm(descriptor, now),
    '',
    summarySection(descriptor),
    '',
    checklistSection(descriptor),
    '',
    requirementsSection(descriptor, ctx.bodyIndex, ctx.reqIndex),
    '',
    architectureSection(descriptor, ctx.archContent),
  ];

  const contract = contractReferenceSection(descriptor, ctx.archContent);
  if (contract) sections.push('', contract);

  sections.push('', worktreeSection(descriptor));

  const auditFindings = ctx.auditByRepo[descriptor.repo_key] || [];
  const anti = antiPatternsSection(descriptor, auditFindings);
  if (anti) sections.push('', anti);

  sections.push('', outOfScopeSection(descriptor, ctx.reqMd), '');

  const body = sections.join('\n');
  const outPath = path.join(outDir, `${descriptor.task_id}.md`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, body);
  } catch (e) {
    die(6, `write failed for ${outPath} (${e.message})`);
  }
  return { task_id: descriptor.task_id, repo_key: descriptor.repo_key, tier: descriptor.tier, title: descriptor.title, file_path: outPath };
}

// ---------- audit-findings parsing (## {repo_key} sections) ----------

function parseAuditFindings(configForAudit) {
  // audit-findings.md lives at {workspace_root}/{slug}/context/audit-findings.md.
  // The caller passes its path via --config's sibling; we accept an explicit
  // --audit-findings path, else try to derive from config.json location.
  const explicit = args['audit-findings'];
  let p = explicit;
  if (!p && configPath) {
    p = path.join(path.dirname(configPath), 'context', 'audit-findings.md');
  }
  const byRepo = {};
  if (!p || !fileExists(p)) return byRepo;
  const md = fs.readFileSync(p, 'utf8');
  const lines = md.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1].trim(); byRepo[cur] = byRepo[cur] || []; continue; }
    if (cur && /^\s*[-*]\s+/.test(line)) byRepo[cur].push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return byRepo;
}

// ---------- main ----------

const descriptorRaw = readJsonOr(2, descriptorPath);
const descriptors = Array.isArray(descriptorRaw) ? descriptorRaw : [descriptorRaw];

const reqIndex = readBlockJson('requirements-index');
if (!reqIndex) die(1, 'requirements-index.json missing — Phase 1 did not materialize the REQUIREMENTS_INDEX block');

const reqMd = readFileOr(1, path.join(runDir, 'outputs', 'phase-1-requirements.md'));
const bodyIndex = buildRequirementBodyIndex(reqMd);
const archContent = fileExists(archMd) ? fs.readFileSync(archMd, 'utf8') : '';
const auditByRepo = parseAuditFindings();

const ctx = { reqIndex, reqMd, bodyIndex, archContent, auditByRepo };

const results = descriptors.map(d => assembleOne(d, ctx));

process.stdout.write(JSON.stringify({ tasks: results }, null, 2) + '\n');
