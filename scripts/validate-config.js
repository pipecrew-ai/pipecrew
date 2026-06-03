#!/usr/bin/env node
/**
 * Workspace config validator.
 * Verifies structure, required fields, repo paths exist on disk,
 * and service → repo cross-references resolve.
 *
 * Usage:  node validate-config.js <config-path>
 * Exit 0 = valid, exit 1 = errors found (printed to stderr).
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node validate-config.js <config-path>');
  process.exit(1);
}

const errors = [];
const warnings = [];

function err(msg)  { errors.push(`ERROR: ${msg}`); }
function warn(msg) { warnings.push(`WARN:  ${msg}`); }

// ── Load + parse ──────────────────────────────────────────
let config;
try {
  const raw = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(raw);
} catch (e) {
  console.error(`Failed to read/parse ${configPath}: ${e.message}`);
  process.exit(1);
}

// ── workspace block ───────────────────────────────────────
if (!config.workspace)      err('Missing top-level "workspace" block');
else {
  if (!config.workspace.name) err('workspace.name is required');
  if (!config.workspace.slug) err('workspace.slug is required');
  else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(config.workspace.slug) && config.workspace.slug.length > 1)
    err(`workspace.slug "${config.workspace.slug}" is not valid kebab-case`);
}

// ── repos block ───────────────────────────────────────────
if (!config.repos || typeof config.repos !== 'object') {
  err('Missing top-level "repos" block');
} else {
  const VALID_TYPES = [
    'spring-boot', 'react', 'nextjs', 'nestjs', 'fastapi', 'node-mock', 'cdk',
    'flask', 'django', 'python-worker', 'terraform', 'schemas', 'api-collections',
    'other',
  ];
  const VALID_ROLES = [
    'api-service', 'frontend', 'mock-server', 'infrastructure', 'shared-lib',
    'worker', 'contract', 'other',
  ];

  for (const [name, repo] of Object.entries(config.repos)) {
    if (!repo.path) err(`repos.${name}.path is required`);
    else {
      const resolved = repo.path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
      if (!fs.existsSync(resolved)) err(`repos.${name}.path does not exist: ${resolved}`);
    }
    if (!repo.type) err(`repos.${name}.type is required`);
    else if (!VALID_TYPES.includes(repo.type))
      warn(`repos.${name}.type "${repo.type}" is not in the known list: ${VALID_TYPES.join(', ')}`);

    if (!repo.role) err(`repos.${name}.role is required`);
    else if (!VALID_ROLES.includes(repo.role))
      warn(`repos.${name}.role "${repo.role}" is not in the known list: ${VALID_ROLES.join(', ')}`);

    // Check spec_copies targets exist if repo path exists
    if (repo.spec_copies && repo.path) {
      const resolved = repo.path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
      if (fs.existsSync(resolved)) {
        for (const [svc, relPath] of Object.entries(repo.spec_copies)) {
          const full = path.join(resolved, relPath);
          if (!fs.existsSync(full)) warn(`repos.${name}.spec_copies.${svc} file not found: ${full}`);
        }
      }
    }
  }
}

// ── services block ────────────────────────────────────────
const VALID_SPEC_POLICIES = ['api-first', 'code-first', 'no-api', 'infra'];

if (!config.services || typeof config.services !== 'object') {
  err('Missing top-level "services" block');
} else {
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.repo) err(`services.${name}.repo is required`);
    else if (config.repos && !config.repos[svc.repo])
      err(`services.${name}.repo "${svc.repo}" does not match any key in repos`);

    // spec_policy is optional; defaults to 'api-first' when omitted for backward-compat.
    // Validate the enum when present, and cross-check against spec_file presence.
    const policy = svc.spec_policy;
    if (policy !== undefined && !VALID_SPEC_POLICIES.includes(policy)) {
      err(`services.${name}.spec_policy "${policy}" is not valid — must be one of: ${VALID_SPEC_POLICIES.join(', ')}`);
    }

    const repoKey = svc.repo;
    const repo = config.repos && config.repos[repoKey];
    const specFile = svc.spec_file || (repo && repo.spec_file);
    const effectivePolicy = policy || 'api-first';

    if (effectivePolicy === 'api-first' && !specFile) {
      warn(`services.${name} has spec_policy "api-first" but no spec_file — set spec_policy to "code-first" if the service has no OpenAPI spec`);
    }
    if (effectivePolicy === 'no-api' && specFile) {
      warn(`services.${name} has spec_policy "no-api" but declares spec_file "${specFile}" — no-api services should not have an OpenAPI spec`);
    }
    if (effectivePolicy === 'infra' && specFile) {
      warn(`services.${name} has spec_policy "infra" but declares spec_file "${specFile}" — infra services have no OpenAPI spec; the contract is the architect's INFRASTRUCTURE_IMPACT block`);
    }

    // Check spec_file exists if repo path is known
    if (repo && repo.path && specFile) {
      const resolved = repo.path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
      const full = path.join(resolved, specFile);
      if (fs.existsSync(resolved) && !fs.existsSync(full))
        warn(`services.${name} spec file not found: ${full}`);
    }
  }
}

// ── domain block (optional but warn if missing) ───────────
if (!config.domain) {
  warn('No "domain" block — /init Phase B2 will generate one');
}

// ── Report ────────────────────────────────────────────────
if (warnings.length > 0) {
  console.error('\nWarnings:');
  warnings.forEach(w => console.error('  ' + w));
}

if (errors.length > 0) {
  console.error('\nErrors:');
  errors.forEach(e => console.error('  ' + e));
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s). Config is INVALID.`);
  process.exit(1);
} else {
  const repoCount = config.repos ? Object.keys(config.repos).length : 0;
  const svcCount  = config.services ? Object.keys(config.services).length : 0;
  console.log(`Config valid: ${repoCount} repos, ${svcCount} services, ${warnings.length} warning(s).`);
  process.exit(0);
}
