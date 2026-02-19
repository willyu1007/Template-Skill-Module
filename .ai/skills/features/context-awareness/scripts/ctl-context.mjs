#!/usr/bin/env node
/**
 * ctl-context.mjs
 *
 * Project context registry management for a module-first repository.
 *
 * SSOT registries:
 * - docs/context/project.registry.json                 (project-level SSOT)
 * - modules/<module_id>/interact/registry.json         (module-level SSOT)
 *
 * Derived registry:
 * - docs/context/registry.json                         (project-level aggregated view)
 *
 * Context Awareness feature adds:
 * - docs/context/config/environment-registry.json
 * - config/environments/*.yaml.template
 *
 * Commands:
 *   init              Initialize docs/context skeleton (idempotent)
 *   add-artifact      Add an artifact entry to an SSOT registry
 *   remove-artifact   Remove an artifact entry from an SSOT registry
 *   touch             Recompute checksums in SSOT registries
 *   build             Build docs/context/registry.json (DERIVED)
 *   list              List artifacts (SSOT or derived)
 *   verify            Verify SSOT registries and checksums
 *   help              Show help
 *   add-env           Add a new environment (context awareness feature)
 *   list-envs         List all environments (context awareness feature)
 *   verify-config     Verify environment configuration (context awareness feature)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function usage(exitCode = 0) {
  const msg = `
Usage:
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs <command> [options]

Commands:
  help
    Show this help.

  init
    --repo-root <path>          Repo root (default: cwd)
    --dry-run                   Show what would be created without writing
    Initialize docs/context skeleton (idempotent).

  add-artifact
    --module-id <id>            Target module registry (default: project)
    --artifact-id <id>          Artifact id (required; unique within module)
    --type <type>               Artifact type (required; e.g. openapi|db-schema|bpmn|json|yaml|markdown)
    --path <path>               Repo-relative path to artifact file (required)
    --mode <contract|generated> Artifact mode (default: contract)
    --format <string>           Optional format hint (e.g., openapi-3.1)
    --tags <csv>                Optional tags (comma-separated)
    --repo-root <path>          Repo root (default: cwd)
    Add an artifact entry to an SSOT registry and compute checksum (if file exists).

  remove-artifact
    --module-id <id>            Target module registry (default: project)
    --artifact-id <id>          Artifact id to remove (required)
    --repo-root <path>          Repo root (default: cwd)
    Remove an artifact entry from an SSOT registry.

  touch
    --module-id <id>            If set, only touch that registry (default: all)
    --repo-root <path>          Repo root (default: cwd)
    Recompute checksums and update updatedAt in SSOT registries.

  build
    --repo-root <path>          Repo root (default: cwd)
    --no-refresh                Do not modify SSOT registries (skip touch)
    Build docs/context/registry.json (DERIVED).

  list
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)
    --module-id <id>            SSOT registry to list (default: project)
    --derived                   List derived registry (docs/context/registry.json)
    List artifacts from an SSOT registry or from the derived view.

  verify
    --repo-root <path>          Repo root (default: cwd)
    --strict                    Treat warnings as errors
    Verify SSOT registries and (optionally) checksums without modifying files.

  add-env
    --id <string>               Environment ID (required)
    --description <string>      Description (optional)
    --repo-root <path>          Repo root (default: cwd)
    Add a new environment to the registry.

  list-envs
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)
    List all environments.

  verify-config
    --env <string>              Environment to verify (optional, verifies all if omitted)
    --repo-root <path>          Repo root (default: cwd)
    Verify environment configuration.

Examples:
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs init
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-artifact --module-id billing.api --artifact-id openapi --type openapi --path modules/billing.api/interact/openapi.yaml
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs build
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --strict
`;
  console.log(msg.trim());
  process.exit(exitCode);
}

function die(msg, exitCode = 1) {
  console.error(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage(0);

  const command = args.shift();
  const opts = {};
  const positionals = [];

  while (args.length > 0) {
    const token = args.shift();
    if (token === '-h' || token === '--help') usage(0);

    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (args.length > 0 && !args[0].startsWith('--')) {
        opts[key] = args.shift();
      } else {
        opts[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, opts, positionals };
}

// ============================================================================
// File Utilities
// ============================================================================

function toPosixPath(p) {
  return String(p).replace(/\\/g, '/');
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function readJsonOrNull(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isoNow() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return { op: 'mkdir', path: dirPath };
  }
  return { op: 'skip', path: dirPath, reason: 'exists' };
}

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return { op: 'skip', path: filePath, reason: 'exists' };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return { op: 'write', path: filePath };
}

function computeChecksumSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function isValidModuleId(id) {
  return /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(String(id || ''));
}

function isValidArtifactId(id) {
  return /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/.test(String(id || ''));
}

function normalizeEnvRegistry(raw) {
  const now = new Date().toISOString();
  const version = Number(raw?.version) || 1;
  const updatedAt = raw?.updatedAt || raw?.lastUpdated || now;
  const environments = Array.isArray(raw?.environments) ? raw.environments : [];

  const normalizedEnvs = environments
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const id = String(e.id || '').trim();
      const description = String(e.description || '').trim();
      if (!id || !description) return null;

      // New schema fields (preferred)
      if (e.database || e.secrets || e.deployment) {
        return {
          id,
          description,
          ...(e.database ? { database: e.database } : {}),
          ...(e.secrets ? { secrets: e.secrets } : {}),
          ...(e.deployment ? { deployment: e.deployment } : {})
        };
      }

      // Legacy mapping from { permissions: { database: { read/write/migrate }, deploy } }
      const perms = e.permissions || {};
      const dbPerms = perms.database || {};
      const deployPerm = perms.deploy;

      const writable = dbPerms.write ?? (id !== 'prod');
      const migrations = dbPerms.migrate ?? (id !== 'prod');
      const seedData = id === 'dev';
      const allowed = deployPerm ?? (id !== 'dev');
      const approval = id === 'prod' ? 'required' : 'optional';

      return {
        id,
        description,
        database: { writable: !!writable, migrations: migrations === true ? true : !!migrations, seedData },
        deployment: { allowed: !!allowed, approval }
      };
    })
    .filter(Boolean);

  return {
    version,
    updatedAt,
    environments: normalizedEnvs
  };
}

// ============================================================================
// Context Management
// ============================================================================

function getContextDir(repoRoot) {
  return path.join(repoRoot, 'docs', 'context');
}

function getDerivedRegistryPath(repoRoot) {
  return path.join(getContextDir(repoRoot), 'registry.json');
}

function getProjectRegistryPath(repoRoot) {
  return path.join(getContextDir(repoRoot), 'project.registry.json');
}

function registryPathForModule(repoRoot, moduleId) {
  if (!moduleId || moduleId === 'project') return getProjectRegistryPath(repoRoot);
  return path.join(repoRoot, 'modules', moduleId, 'interact', 'registry.json');
}

function discoverModuleRegistryPaths(repoRoot) {
  const modulesDir = path.join(repoRoot, 'modules');
  if (!fs.existsSync(modulesDir)) return [];
  const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'integration') continue;
    const p = path.join(modulesDir, e.name, 'interact', 'registry.json');
    if (fs.existsSync(p)) out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function loadModuleRegistry(absPath) {
  const data = readJsonOrNull(absPath);
  if (!data || typeof data !== 'object') {
    return { ok: false, registry: null, warnings: [], errors: [`Failed to read JSON: ${absPath}`] };
  }
  return { ok: true, registry: data, warnings: [], errors: [] };
}

function validateRegistryStructure(reg, absPath) {
  const warnings = [];
  const errors = [];

  if (!reg || typeof reg !== 'object') {
    errors.push(`Registry is not an object: ${absPath}`);
    return { warnings, errors };
  }

  if (reg.version !== 1) warnings.push(`Unexpected version in ${absPath} (expected 1)`);
  if (!reg.moduleId || typeof reg.moduleId !== 'string') errors.push(`Missing moduleId in ${absPath}`);
  if (reg.moduleId && !isValidModuleId(reg.moduleId)) warnings.push(`Invalid moduleId "${reg.moduleId}" in ${absPath}`);
  if (!Array.isArray(reg.artifacts)) errors.push(`Missing artifacts list in ${absPath}`);

  if (Array.isArray(reg.artifacts)) {
    const seen = new Set();
    for (const a of reg.artifacts) {
      if (!a || typeof a !== 'object') {
        errors.push(`Artifact entry must be an object: ${absPath}`);
        continue;
      }
      const aid = a.artifactId ?? a.id;
      if (!aid || typeof aid !== 'string') errors.push(`Artifact missing artifactId: ${absPath}`);
      else {
        if (seen.has(aid)) errors.push(`Duplicate artifactId "${aid}" in ${absPath}`);
        seen.add(aid);
        if (!isValidArtifactId(aid)) warnings.push(`artifactId "${aid}" has unusual characters (recommended: /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/)`);
      }
      if (!a.type || typeof a.type !== 'string') errors.push(`Artifact "${aid}" missing type in ${absPath}`);
      if (!a.path || typeof a.path !== 'string') errors.push(`Artifact "${aid}" missing path in ${absPath}`);
      if (a.mode && !['contract', 'generated'].includes(a.mode)) warnings.push(`Artifact "${aid}" has unknown mode "${a.mode}" in ${absPath}`);
    }
  }

  return { warnings, errors };
}

function touchRegistry(repoRoot, absPath, { apply } = { apply: true }) {
  const l = loadModuleRegistry(absPath);
  const warnings = [...l.warnings];
  const errors = [...l.errors];
  if (!l.ok) return { warnings, errors, changed: false };

  const registry = l.registry;
  const v = validateRegistryStructure(registry, absPath);
  warnings.push(...v.warnings);
  errors.push(...v.errors);

  let changed = false;

  if (Array.isArray(registry.artifacts)) {
    for (const a of registry.artifacts) {
      const aid = a.artifactId ?? a.id;
      const rel = a.path;
      if (!rel) continue;

      const abs = path.join(repoRoot, rel);
      if (!fs.existsSync(abs)) {
        warnings.push(`[${registry.moduleId}] artifact missing file: ${rel} (artifactId: ${aid})`);
        continue;
      }

      const actual = computeChecksumSha256(abs);
      if (a.checksumSha256 !== actual) {
        warnings.push(`[${registry.moduleId}] checksum mismatch for ${aid} (${apply ? 'updating' : 'not updating'})`);
        if (apply) {
          a.checksumSha256 = actual;
          a.lastUpdated = isoNow();
          changed = true;
        }
      }
    }
  }

  if (apply) {
    registry.updatedAt = isoNow();
    writeJson(absPath, registry);
  }

  return { warnings, errors, changed };
}

function buildDerivedRegistry(repoRoot, { refresh } = { refresh: true }) {
  const warnings = [];
  const errors = [];

  const registries = [];
  const projectPath = getProjectRegistryPath(repoRoot);
  if (!fs.existsSync(projectPath)) {
    errors.push(`Missing project registry: ${projectPath}`);
  } else {
    registries.push(projectPath);
  }
  registries.push(...discoverModuleRegistryPaths(repoRoot));

  if (refresh) {
    for (const p of registries) {
      const t = touchRegistry(repoRoot, p, { apply: true });
      warnings.push(...t.warnings);
      errors.push(...t.errors);
    }
  } else {
    for (const p of registries) {
      const l = loadModuleRegistry(p);
      if (!l.ok) {
        errors.push(...l.errors);
        continue;
      }
      const v = validateRegistryStructure(l.registry, p);
      warnings.push(...v.warnings);
      errors.push(...v.errors);
    }
  }

  const artifacts = [];
  for (const p of registries) {
    const l = loadModuleRegistry(p);
    if (!l.ok) continue;
    const reg = l.registry;
    const moduleId = reg.moduleId;
    for (const a of reg.artifacts || []) {
      const artifactId = a.artifactId ?? a.id;
      const id = `${moduleId}:${artifactId}`;
      const item = {
        id,
        moduleId,
        artifactId,
        type: a.type,
        path: a.path,
        mode: a.mode ?? 'contract'
      };
      if (a.format) item.format = a.format;
      if (Array.isArray(a.tags) && a.tags.length > 0) item.tags = a.tags;
      if (a.checksumSha256) item.checksumSha256 = a.checksumSha256;
      if (a.lastUpdated) item.lastUpdated = a.lastUpdated;
      if (a.source) item.source = a.source;
      artifacts.push(item);
    }
  }

  artifacts.sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  const derived = {
    version: 1,
    updatedAt: isoNow(),
    artifacts
  };

  return { derived, warnings, errors };
}

function getEnvRegistryPath(repoRoot) {
  return path.join(getContextDir(repoRoot), 'config', 'environment-registry.json');
}

function loadEnvRegistry(repoRoot) {
  const envRegistryPath = getEnvRegistryPath(repoRoot);
  const data = readJsonOrNull(envRegistryPath);
  if (!data) return null;
  return normalizeEnvRegistry(data);
}

function saveEnvRegistry(repoRoot, envRegistry) {
  const normalized = normalizeEnvRegistry(envRegistry);
  normalized.updatedAt = new Date().toISOString();
  writeJson(getEnvRegistryPath(repoRoot), normalized);
}

function isContextAwarenessEnabled(repoRoot) {
  const statePath = path.join(repoRoot, '.ai', 'project', 'state.json');
  const state = readJsonOrNull(statePath);
  if (!state || typeof state !== 'object') return false;
  if (state.context?.enabled === true) return true;
  if (state.features?.contextAwareness === true) return true;
  return false;
}

// ============================================================================
// Commands
// ============================================================================

function cmdInit(repoRoot, dryRun) {
  const contextDir = getContextDir(repoRoot);
  const actions = [];

  // Create directory structure
  const dirs = [
    contextDir,
    path.join(contextDir, 'api'),
    path.join(contextDir, 'db'),
    path.join(contextDir, 'process'),
    path.join(contextDir, 'config')
  ];

  for (const dir of dirs) {
    if (dryRun) {
      actions.push({ op: 'mkdir', path: dir, mode: 'dry-run' });
    } else {
      actions.push(ensureDir(dir));
    }
  }

  // Create INDEX.md
  const indexPath = path.join(contextDir, 'INDEX.md');
  const indexContent = `# Project context index (LLM-first)

This directory provides a **project-level** view of curated context artifacts.

## Important

- \`docs/context/registry.json\` is a **DERIVED artifact** — do not edit it by hand.
  - Regenerate it with: \`node .ai/skills/features/context-awareness/scripts/ctl-context.mjs build\`

## Sources of truth

Project context is aggregated bottom-up from:

1. **Project-level registry (SSOT)**: \`docs/context/project.registry.json\`
2. **Module registries (SSOT)**: \`modules/<module_id>/interact/registry.json\`

## How to load context (for AI/LLM)

1. Open \`docs/context/registry.json\` (derived, aggregated view).
2. Read \`docs/context/api/api-index.json\` for a one-read API overview (grouped by module).
3. [On demand] Read \`modules/<id>/interact/openapi.yaml\` for full endpoint definitions.
4. Select only the additional artifacts needed for the current task.
5. Open those files by path (do not scan folders).

## Rules

- Prefer script-driven updates (ctl-context) over manual edits.
- Never store secrets in context artifacts.
`;

  if (dryRun) {
    actions.push({ op: 'write', path: indexPath, mode: 'dry-run' });
  } else {
    actions.push(writeFileIfMissing(indexPath, indexContent));
  }

  // Create project-level SSOT registry
  const projectRegPath = getProjectRegistryPath(repoRoot);
  if (!fs.existsSync(projectRegPath) && !dryRun) {
    writeJson(projectRegPath, { version: 1, moduleId: 'project', updatedAt: isoNow(), artifacts: [] });
    actions.push({ op: 'write', path: projectRegPath });
  } else if (dryRun) {
    actions.push({ op: 'write', path: projectRegPath, mode: 'dry-run' });
  }

  // Create derived registry skeleton
  const derivedPath = getDerivedRegistryPath(repoRoot);
  if (!fs.existsSync(derivedPath) && !dryRun) {
    writeJson(derivedPath, { version: 1, updatedAt: '1970-01-01T00:00:00Z', artifacts: [] });
    actions.push({ op: 'write', path: derivedPath });
  } else if (dryRun) {
    actions.push({ op: 'write', path: derivedPath, mode: 'dry-run' });
  }

  // Create environment registry
  const envRegistryPath = getEnvRegistryPath(repoRoot);
  if (!fs.existsSync(envRegistryPath) && !dryRun) {
    const envRegistry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      environments: [
        {
          id: 'dev',
          description: 'Local development environment',
          database: { writable: true, migrations: true, seedData: true },
          deployment: { allowed: false, approval: 'none' }
        },
        {
          id: 'staging',
          description: 'Staging/QA environment',
          database: { writable: true, migrations: 'review-required', seedData: false },
          deployment: { allowed: true, approval: 'required' }
        },
        {
          id: 'prod',
          description: 'Production environment',
          database: { writable: false, migrations: 'change-request', seedData: false },
          deployment: { allowed: true, approval: 'required' }
        }
      ]
    };
    writeJson(envRegistryPath, envRegistry);
    actions.push({ op: 'write', path: envRegistryPath });
  } else if (dryRun) {
    actions.push({ op: 'write', path: envRegistryPath, mode: 'dry-run' });
  }

  // Do not overwrite existing schemas; init only creates missing skeletons.

  console.log('[ok] Context layer initialized.');
  for (const action of actions) {
    const mode = action.mode ? ` (${action.mode})` : '';
    const reason = action.reason ? ` [${action.reason}]` : '';
    console.log(`  ${action.op}: ${path.relative(repoRoot, action.path)}${mode}${reason}`);
  }
}

function normalizeArtifactType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'db') return 'db-schema';
  return t;
}

function parseCsv(csv) {
  if (!csv) return [];
  return String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cmdAddArtifact(repoRoot, opts) {
  const moduleId = opts['module-id'] || 'project';
  const artifactId = opts['artifact-id'] || opts.id;
  const type = opts.type;
  const relPath = opts.path;
  const mode = opts.mode || 'contract';
  const format = opts.format || null;
  const tags = parseCsv(opts.tags);

  if (!artifactId || !isValidArtifactId(artifactId)) {
    die('[error] --artifact-id is required (recommended pattern: /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/)');
  }
  if (!type) die('[error] --type is required');
  if (!relPath) die('[error] --path is required');
  if (!['contract', 'generated'].includes(mode)) die('[error] --mode must be contract|generated');

  const registryPath = registryPathForModule(repoRoot, moduleId);
  if (!fs.existsSync(registryPath)) {
    die(`[error] registry not found: ${registryPath} (run ctl-module init or ctl-context init)`);
  }

  const reg = readJson(registryPath);
  reg.artifacts = Array.isArray(reg.artifacts) ? reg.artifacts : [];
  if (reg.artifacts.find((a) => (a.artifactId ?? a.id) === artifactId)) {
    die(`[error] artifactId already exists: ${artifactId}`);
  }

  const absArtifact = path.join(repoRoot, relPath);
  const checksum = fs.existsSync(absArtifact) ? computeChecksumSha256(absArtifact) : null;

  reg.artifacts.push({
    artifactId,
    type: normalizeArtifactType(type),
    path: toPosixPath(relPath),
    mode,
    ...(format ? { format: String(format) } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(checksum ? { checksumSha256: checksum } : {}),
    lastUpdated: isoNow()
  });

  reg.updatedAt = isoNow();
  writeJson(registryPath, reg);

  console.log(`[ok] added artifact "${artifactId}" to ${path.relative(repoRoot, registryPath)}`);

  // Refresh derived view without mutating SSOT again.
  cmdBuild(repoRoot, { 'no-refresh': true });
}

function cmdRemoveArtifact(repoRoot, opts) {
  const moduleId = opts['module-id'] || 'project';
  const artifactId = opts['artifact-id'] || opts.id;
  if (!artifactId) die('[error] --artifact-id is required');

  const registryPath = registryPathForModule(repoRoot, moduleId);
  if (!fs.existsSync(registryPath)) die(`[error] registry not found: ${registryPath}`);

  const reg = readJson(registryPath);
  reg.artifacts = Array.isArray(reg.artifacts) ? reg.artifacts : [];
  const before = reg.artifacts.length;
  reg.artifacts = reg.artifacts.filter((a) => (a.artifactId ?? a.id) !== artifactId);
  if (reg.artifacts.length === before) die(`[error] artifactId not found: ${artifactId}`);

  reg.updatedAt = isoNow();
  writeJson(registryPath, reg);

  console.log(`[ok] removed artifact "${artifactId}" from ${path.relative(repoRoot, registryPath)}`);

  // Refresh derived view without mutating SSOT again.
  cmdBuild(repoRoot, { 'no-refresh': true });
}

function cmdTouch(repoRoot, opts) {
  const moduleId = opts['module-id'] || null;

  const targets = [];
  if (moduleId) {
    targets.push(registryPathForModule(repoRoot, moduleId));
  } else {
    targets.push(getProjectRegistryPath(repoRoot));
    targets.push(...discoverModuleRegistryPaths(repoRoot));
  }

  const warnings = [];
  const errors = [];
  let changedAny = false;

  for (const p of targets) {
    if (!fs.existsSync(p)) {
      warnings.push(`Missing registry: ${p}`);
      continue;
    }
    const t = touchRegistry(repoRoot, p, { apply: true });
    warnings.push(...t.warnings);
    errors.push(...t.errors);
    if (t.changed) changedAny = true;
  }

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`- ${w}`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`- ${e}`);
    process.exit(1);
  }

  console.log(`[ok] touch complete (changed: ${changedAny})`);
}

function cmdBuild(repoRoot, opts) {
  const refresh = !opts['no-refresh'];
  const outPath = getDerivedRegistryPath(repoRoot);

  const { derived, warnings, errors } = buildDerivedRegistry(repoRoot, { refresh });
  writeJson(outPath, derived);

  console.log(`[ok] wrote ${path.relative(repoRoot, outPath)} (refresh: ${refresh})`);

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`- ${w}`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`- ${e}`);
    process.exit(1);
  }
}

function cmdList(repoRoot, opts, format) {
  const derived = !!opts.derived;
  const moduleId = opts['module-id'] || 'project';

  if (derived) {
    const outPath = getDerivedRegistryPath(repoRoot);
    if (!fs.existsSync(outPath)) die(`[error] derived registry not found: ${path.relative(repoRoot, outPath)} (run: ctl-context build)`);
    const reg = readJson(outPath);
    if (format === 'json') {
      console.log(JSON.stringify(reg, null, 2));
      return;
    }
    const artifacts = Array.isArray(reg?.artifacts) ? reg.artifacts : [];
    console.log(`Derived Context Artifacts (${artifacts.length} total):`);
    console.log(`Updated at: ${reg.updatedAt || 'unknown'}\n`);
    for (const a of artifacts) {
      console.log(`  [${a.type}] ${a.id}`);
      console.log(`    Path: ${a.path}`);
      console.log(`    Mode: ${a.mode}`);
      if (a.checksumSha256) console.log(`    Checksum: ${a.checksumSha256}`);
    }
    return;
  }

  const registryPath = registryPathForModule(repoRoot, moduleId);
  if (!fs.existsSync(registryPath)) die(`[error] registry not found: ${path.relative(repoRoot, registryPath)}`);
  const reg = readJson(registryPath);
  if (format === 'json') {
    console.log(JSON.stringify(reg, null, 2));
    return;
  }

  const artifacts = Array.isArray(reg?.artifacts) ? reg.artifacts : [];
  console.log(`SSOT Artifacts (${artifacts.length} total) [moduleId=${reg.moduleId || moduleId}]:`);
  console.log(`Updated at: ${reg.updatedAt || 'unknown'}\n`);
  for (const a of artifacts) {
    const aid = a.artifactId ?? a.id;
    console.log(`  [${a.type}] ${aid}`);
    console.log(`    Path: ${a.path}`);
    console.log(`    Mode: ${a.mode || 'contract'}`);
    if (a.checksumSha256) console.log(`    Checksum: ${a.checksumSha256}`);
  }
}

function cmdVerify(repoRoot, strict) {
  const paths = [getProjectRegistryPath(repoRoot), ...discoverModuleRegistryPaths(repoRoot)];
  const warnings = [];
  const errors = [];

  for (const p of paths) {
    if (!fs.existsSync(p)) {
      warnings.push(`Missing registry: ${p}`);
      continue;
    }
    const l = loadModuleRegistry(p);
    if (!l.ok) {
      errors.push(...l.errors);
      continue;
    }
    const v = validateRegistryStructure(l.registry, p);
    warnings.push(...v.warnings);
    errors.push(...v.errors);

    for (const a of l.registry.artifacts || []) {
      const rel = a.path;
      if (!rel) continue;
      const abs = path.join(repoRoot, rel);
      if (!fs.existsSync(abs)) {
        warnings.push(`[${l.registry.moduleId}] missing file: ${rel}`);
        continue;
      }
      if (a.checksumSha256) {
        const actual = computeChecksumSha256(abs);
        if (actual !== a.checksumSha256) warnings.push(`[${l.registry.moduleId}] checksum mismatch: ${(a.artifactId ?? a.id)}`);
      }
    }
  }

  // Feature-level verification: env registry and INDEX.md
  if (isContextAwarenessEnabled(repoRoot)) {
    const envRegistryPath = getEnvRegistryPath(repoRoot);
    if (!fs.existsSync(envRegistryPath)) warnings.push('environment-registry.json does not exist (run: ctl-context init).');
    const indexPath = path.join(getContextDir(repoRoot), 'INDEX.md');
    if (!fs.existsSync(indexPath)) warnings.push('INDEX.md does not exist (run: ctl-context init).');
  }

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`- ${w}`);
  }
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`- ${e}`);
  }

  if (errors.length > 0) process.exit(1);
  if (strict && warnings.length > 0) process.exit(1);

  console.log('\n[ok] context verification passed.');
}

function cmdAddEnv(repoRoot, id, description) {
  if (!id) die('[error] --id is required');

  const envRegistry = loadEnvRegistry(repoRoot);
  if (!envRegistry) die('[error] environment-registry.json not found. Run: ctl-context init');
  
  // Check if environment already exists
  const existing = envRegistry.environments.find(e => e.id === id);
  if (existing) {
    die(`[error] Environment "${id}" already exists.`);
  }

  const defaultApproval = id === 'prod' ? 'required' : (id === 'dev' ? 'none' : 'optional');

  envRegistry.environments.push({
    id,
    description: description || `${id} environment`,
    database: {
      writable: id !== 'prod',
      migrations: id === 'prod' ? 'change-request' : (id === 'staging' ? 'review-required' : true),
      seedData: id === 'dev'
    },
    deployment: {
      allowed: id !== 'dev',
      approval: defaultApproval
    }
  });

  saveEnvRegistry(repoRoot, envRegistry);
  console.log(`[ok] Added environment: ${id}`);
}

function cmdListEnvs(repoRoot, format) {
  const envRegistry = loadEnvRegistry(repoRoot);
  if (!envRegistry) die('[error] environment-registry.json not found. Run: ctl-context init');

  if (format === 'json') {
    console.log(JSON.stringify(envRegistry, null, 2));
    return;
  }

  console.log(`Environments (${envRegistry.environments.length} total):\n`);

  for (const env of envRegistry.environments) {
    console.log(`  [${env.id}] ${env.description || ''}`);
    const db = env.database || {};
    const deploy = env.deployment || {};
    console.log(`    Database: writable=${db.writable ?? '-'}, migrations=${db.migrations ?? '-'}, seedData=${db.seedData ?? '-'}`);
    console.log(`    Deployment: allowed=${deploy.allowed ?? '-'}, approval=${deploy.approval ?? '-'}`);
  }
}

function cmdVerifyConfig(repoRoot, envId) {
  const envRegistry = loadEnvRegistry(repoRoot);
  if (!envRegistry) die('[error] environment-registry.json not found. Run: ctl-context init');
  const errors = [];
  const warnings = [];

  const envsToCheck = envId 
    ? envRegistry.environments.filter(e => e.id === envId)
    : envRegistry.environments;

  if (envId && envsToCheck.length === 0) {
    die(`[error] Environment "${envId}" not found.`);
  }

  for (const env of envsToCheck) {
    // Check for config template
    const templatePath = path.join(repoRoot, 'config', 'environments', `${env.id}.yaml.template`);
    const configPath = path.join(repoRoot, 'config', 'environments', `${env.id}.yaml`);

    if (!fs.existsSync(templatePath) && !fs.existsSync(configPath)) {
      warnings.push(`No config file found for environment "${env.id}".`);
    }

    // Check minimal policy keys exist
    if (!env.database) warnings.push(`Environment "${env.id}" has no database policy defined.`);
    if (!env.deployment) warnings.push(`Environment "${env.id}" has no deployment policy defined.`);
  }

  // Report results
  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const e of errors) console.log(`  - ${e}`);
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('[ok] Environment configuration verification passed.');
  } else if (errors.length === 0) {
    console.log('[ok] Environment configuration verification passed with warnings.');
  } else {
    console.log('[error] Environment configuration verification failed.');
    process.exit(1);
  }
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const { command, opts } = parseArgs(process.argv);
  const repoRoot = path.resolve(opts['repo-root'] || process.cwd());
  const format = (opts['format'] || 'text').toLowerCase();

  switch (command) {
    case 'help':
      usage(0);
      break;
    case 'init':
      cmdInit(repoRoot, !!opts['dry-run']);
      break;
    case 'add-artifact':
      cmdAddArtifact(repoRoot, opts);
      break;
    case 'remove-artifact':
      cmdRemoveArtifact(repoRoot, opts);
      break;
    case 'touch':
      cmdTouch(repoRoot, opts);
      break;
    case 'build':
      cmdBuild(repoRoot, opts);
      break;
    case 'list':
      cmdList(repoRoot, opts, format);
      break;
    case 'verify':
      cmdVerify(repoRoot, !!opts['strict']);
      break;
    case 'add-env':
      cmdAddEnv(repoRoot, opts['id'], opts['description']);
      break;
    case 'list-envs':
      cmdListEnvs(repoRoot, format);
      break;
    case 'verify-config':
      cmdVerifyConfig(repoRoot, opts['env']);
      break;
    default:
      console.error(`[error] Unknown command: ${command}`);
      usage(1);
  }
}

main();
