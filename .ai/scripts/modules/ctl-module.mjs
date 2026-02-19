#!/usr/bin/env node
/**
 * ctl-module.mjs
 *
 * Module instance management + derived registry build.
 *
 * Module instance SSOT:
 * - modules/<module_id>/MANIFEST.yaml
 * - modules/<module_id>/interact/registry.json
 *
 * Derived artifacts:
 * - .system/modular/instance_registry.yaml
 *
 * Philosophy:
 * - Manifests are SSOT, derived registries are overwritable.
 * - Prefer script-driven changes and deterministic output ordering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseArgs, createUsage, die, isoNow, repoRootFromOpts, printDiagnostics } from '../lib/cli.mjs';
import { ensureDir, safeRel, readText, writeText, readJson, writeJson } from '../lib/fs-utils.mjs';
import { loadYamlFile, saveYamlFile, dumpYaml, parseYaml } from '../lib/yaml.mjs';
import {
  normalizeImplementsEntry,
  normalizeParticipatesInEntry,
  isValidModuleId,
  discoverModules,
  getModulesDir,
  validateManifest
} from '../lib/modular.mjs';

// =============================================================================
// CLI
// =============================================================================

const usageText = `
Usage:
  node .ai/scripts/modules/ctl-module.mjs <command> [options]

Options:
  --repo-root <path>          Repo root (default: cwd)

Commands:
  init
    --module-id <id>            Module id (kebab-case, e.g., billing-api)
    --module-type <type>        e.g., service|library|job (default: service)
    --description <text>        Optional
    --with-openapi              Create minimal OpenAPI scaffold + register artifact
    --apply                     Actually write files (default: dry-run)
    --force                     Overwrite existing files (dangerous)
    Initialize a new module instance skeleton.

  list
    --format <text|json>        Output format (default: text)
    List detected modules.

  registry-build
    --modules-dir <path>        Default: modules
    --out <path>                Default: .system/modular/instance_registry.yaml
    --format <text|json>        Output format (default: text)
    Build instance registry from module manifests (DERIVED).

  verify
    --modules-dir <path>        Default: modules
    --strict                    Fail on warnings
    Verify module manifests and module-local SSOT.

ID Naming Convention:
  All IDs must be kebab-case (lowercase letters, digits, hyphens only).
  Pattern: ^[a-z0-9]+(?:-[a-z0-9]+)*$
  Examples: user-api, billing-service, auth-module

Examples:
  node .ai/scripts/modules/ctl-module.mjs init --module-id billing-api --apply
  node .ai/scripts/modules/ctl-module.mjs registry-build
  node .ai/scripts/modules/ctl-module.mjs verify --strict
`;

const usage = createUsage(usageText);

// =============================================================================
// Module templates
// =============================================================================

function templateAgentsMd(moduleId, moduleType, description) {
  const desc = description ? `\n\n## Description\n\n${description}\n` : '';
  return `---
name: ${moduleId}
purpose: Module agent instructions for ${moduleId}
---

# ${moduleId}

## Operating rules

- Read this file first when working inside this module.
- Keep changes local to this module unless explicitly cross-cutting.
- For multi-step/multi-file work: create/resume \`dev-docs/active/<task_slug>/\` and keep dev docs synced (see \`dev-docs/AGENTS.md\`).
- If you change this module's manifest, run:
  - node .ai/scripts/modules/ctl-module.mjs registry-build
  - node .ai/scripts/modules/ctl-flow.mjs update-from-manifests
  - node .ai/scripts/modules/ctl-flow.mjs lint

## Key files

- MANIFEST.yaml (SSOT)
- interact/registry.json (SSOT)
- dev-docs/AGENTS.md (how to use dev docs)
- dev-docs/ (long-running module notes)
${desc}`;
}

function templateDevDocsAgentsMd(moduleId) {
  return `---
name: ${moduleId}-dev-docs
purpose: Dev-docs operating rules for ${moduleId}
---

# ${moduleId} — dev-docs

## Scope

Long-running task tracking, design decisions, and handoff documentation for this module.

## Operating rules (MUST)

- Do not start non-trivial implementation without a task folder under \`active/<task_slug>/\`.
- Prefer **resume over new**: if a related task already exists in \`active/\`, reuse it.
- Before doing any work in an existing task, read:
  - \`03-implementation-notes.md\`
  - \`05-pitfalls.md\`
- Keep execution synced during work:
  - \`01-plan.md\` (checklist + newly discovered TODOs)
  - \`03-implementation-notes.md\` (what changed + decisions + deviations)
  - \`04-verification.md\` (commands run + results + blockers)
- Before context switch / handoff / wrap-up: run \`update-dev-docs-for-handoff\` and ensure \`handoff.md\` is present and actionable.

## Structure

| Directory | Content |
|---|---|
| \`active/<task-slug>/\` | Current tasks |
| \`archive/<task-slug>/\` | Completed tasks |

## Workflow

1. If the user asks for planning before coding, write \`active/<task_slug>/roadmap.md\` via \`plan-maker\` (planning-only).
2. Create (or resume) the task bundle via \`create-dev-docs-plan\`.
3. Execute work while continuously syncing \`01-plan.md\`, \`03-implementation-notes.md\`, and \`04-verification.md\`.
4. Before handoff: use \`update-dev-docs-for-handoff\`.
5. On completion: move the folder to \`archive/\`.
`;
}

function templateAbilityMd(moduleId) {
  return `# ${moduleId} — Ability

Describe what this module is responsible for, and what it is NOT responsible for.

## Responsibilities
- TBD

## Non-responsibilities
- TBD

## External dependencies
- TBD
`;
}

function defaultManifest(moduleId, moduleType, description) {
  const manifest = {
    module_id: moduleId,
    module_type: moduleType || 'service'
  };
  if (description) manifest.description = description;
  manifest.status = 'planned';
  manifest.interfaces = [];
  manifest.dependencies = [];
  return manifest;
}

function defaultModuleContextRegistry(moduleId) {
  return {
    version: 1,
    moduleId,
    updatedAt: isoNow(),
    artifacts: []
  };
}

// =============================================================================
// Commands
// =============================================================================

function cmdInit(repoRoot, opts) {
  const moduleId = opts['module-id'];
  const moduleType = opts['module-type'] || 'service';
  const description = opts['description'] || '';
  const withOpenapi = !!opts['with-openapi'];
  const apply = !!opts['apply'];
  const force = !!opts['force'];

  if (!moduleId || !isValidModuleId(moduleId)) {
    die(
      `[error] Invalid module_id: "${moduleId || ''}"\n` +
      `  Required format: kebab-case (lowercase letters, digits, hyphens only)\n` +
      `  Examples: user-api, billing-service, auth-module\n` +
      `  Pattern: ^[a-z0-9]+(?:-[a-z0-9]+)*$`
    );
  }

  const modulesDir = getModulesDir(repoRoot, 'modules');
  const moduleDir = path.join(modulesDir, moduleId);

  const filesToWrite = [];

  const manifestPath = path.join(moduleDir, 'MANIFEST.yaml');
  const agentsPath = path.join(moduleDir, 'AGENTS.md');
  const abilityPath = path.join(moduleDir, 'ABILITY.md');
  const registryPath = path.join(moduleDir, 'interact', 'registry.json');
  const devDocsReadmePath = path.join(moduleDir, 'dev-docs', 'README.md');
  const devDocsAgentsPath = path.join(moduleDir, 'dev-docs', 'AGENTS.md');

  const manifestObj = defaultManifest(moduleId, moduleType, description);
  const manifestYaml = dumpYaml(manifestObj);

  const devDocsReadme = `# ${moduleId} — dev-docs

This folder contains long-running notes for the module.

Read first:
- dev-docs/AGENTS.md (how to use dev docs)

Recommended structure:

- active/ — current tasks
- archive/ — closed tasks

For integration-related work, prefer writing in modules/integration/dev-docs/.
`;

  const registry = defaultModuleContextRegistry(moduleId);

  if (withOpenapi) {
    registry.artifacts.push({
      artifactId: 'openapi',
      type: 'openapi',
      path: `modules/${moduleId}/interact/openapi.yaml`,
      mode: 'contract',
      format: 'openapi-3.1',
      tags: ['api']
    });

    const openapiPath = path.join(moduleDir, 'interact', 'openapi.yaml');
    const title = description || moduleId;
    const yamlQuote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    filesToWrite.push({
      path: openapiPath,
      content: `openapi: 3.1.0
info:
  title: ${yamlQuote(title)}
  version: 0.1.0
  description: ${yamlQuote(`API contract for ${moduleId}`)}
paths: {}
`
    });
  }

  filesToWrite.push({ path: manifestPath, content: manifestYaml });
  filesToWrite.push({ path: agentsPath, content: templateAgentsMd(moduleId, moduleType, description) });
  filesToWrite.push({ path: abilityPath, content: templateAbilityMd(moduleId) });
  filesToWrite.push({ path: registryPath, content: JSON.stringify(registry, null, 2) + '\n' });
  filesToWrite.push({ path: devDocsReadmePath, content: devDocsReadme });
  filesToWrite.push({ path: devDocsAgentsPath, content: templateDevDocsAgentsMd(moduleId) });

  const dirsToEnsure = [
    path.join(moduleDir, 'interact'),
    path.join(moduleDir, 'config'),
    path.join(moduleDir, 'src'),
    path.join(moduleDir, 'tests'),
    path.join(moduleDir, 'dev-docs', 'active'),
    path.join(moduleDir, 'dev-docs', 'archive')
  ];

  if (!apply) {
    console.log('[plan] Module init (dry-run)');
    console.log(`  module: ${moduleId}`);
    console.log(`  dir:    ${safeRel(repoRoot, moduleDir)}`);
    for (const d of dirsToEnsure) console.log(`  mkdir:  ${safeRel(repoRoot, d)}`);
    for (const f of filesToWrite) console.log(`  write:  ${safeRel(repoRoot, f.path)}`);
    console.log('\nRun again with --apply to write files.');
    return;
  }

  if (fs.existsSync(moduleDir) && !force) {
    die(`[error] Module dir already exists: ${safeRel(repoRoot, moduleDir)} (use --force to overwrite)`);
  }

  for (const d of dirsToEnsure) ensureDir(d);

  for (const f of filesToWrite) {
    if (!force && fs.existsSync(f.path)) {
      die(`[error] Refusing to overwrite existing file: ${safeRel(repoRoot, f.path)} (use --force)`);
    }
    writeText(f.path, f.content);
  }

  console.log(`[ok] Initialized module: ${moduleId}`);

  // Register bottom-up (derived)
  cmdRegistryBuild(repoRoot, { 'modules-dir': 'modules', out: '.system/modular/instance_registry.yaml', format: 'text' }, { quiet: true });

  // Rebuild project context registry (derived)
  const ctx = spawnSync(
    'node',
    ['.ai/skills/features/context-awareness/scripts/ctl-context.mjs', 'build', '--repo-root', repoRoot],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (ctx.status !== 0) {
    console.error('[warn] ctl-context build failed (module created, but project context registry not updated).');
  }

  // Update flow implementation index (derived)
  const flow = spawnSync('node', ['.ai/scripts/modules/ctl-flow.mjs', 'update-from-manifests'], { cwd: repoRoot, stdio: 'inherit' });
  if (flow.status !== 0) {
    console.error('[warn] ctl-flow update-from-manifests failed (module created, but flow implementation index not updated).');
  }
}

function cmdList(repoRoot, opts) {
  const format = (opts.format || 'text').toLowerCase();
  const mods = discoverModules(repoRoot, opts['modules-dir']);

  if (format === 'json') {
    console.log(JSON.stringify({ modules: mods.map(m => ({ id: path.basename(m.dir), dir: safeRel(repoRoot, m.dir) })) }, null, 2));
    return;
  }

  if (mods.length === 0) {
    console.log('[info] No modules found.');
    return;
  }

  console.log('Modules:');
  for (const m of mods) {
    console.log(`- ${path.basename(m.dir)}  (${safeRel(repoRoot, m.dir)})`);
  }
}

function buildInstanceRegistry(repoRoot, modulesDirOpt) {
  const mods = discoverModules(repoRoot, modulesDirOpt);
  const modules = [];

  const warnings = [];
  const errors = [];

  for (const m of mods) {
    const manifestRaw = readText(m.manifestPath);
    let manifest;
    try {
      manifest = parseYaml(manifestRaw);
    } catch (e) {
      errors.push(`Failed to parse YAML: ${safeRel(repoRoot, m.manifestPath)} (${e.message})`);
      continue;
    }

    const v = validateManifest(manifest, safeRel(repoRoot, m.manifestPath));
    warnings.push(...v.warnings.map(w => `[${path.basename(m.dir)}] ${w}`));
    errors.push(...v.errors.map(er => `[${path.basename(m.dir)}] ${er}`));

    const moduleId = manifest.module_id ?? manifest.moduleId ?? path.basename(m.dir);
    const moduleType = manifest.module_type ?? manifest.moduleType ?? null;

    const rec = {
      module_id: moduleId,
      module_type: moduleType,
      path: safeRel(repoRoot, m.dir),
      status: manifest.status ?? null,
      description: manifest.description ?? null,
      interfaces: [],
      participates_in: []
    };

    // Extract participates_in if present
    if (Array.isArray(manifest.participates_in) && manifest.participates_in.length > 0) {
      rec.participates_in = manifest.participates_in.map(entry => {
        const norm = normalizeParticipatesInEntry(entry);
        return {
          flow_id: norm.flow_id,
          node_id: norm.node_id,
          role: norm.role ?? null
        };
      }).filter(e => e.flow_id && e.node_id);
    }

    if (Array.isArray(manifest.interfaces)) {
      for (const it of manifest.interfaces) {
        const entry = {
          id: it.id,
          protocol: it.protocol ?? null,
          description: it.description ?? null,
          status: it.status ?? null
        };

        if (it.protocol === 'http') {
          entry.method = it.method ?? null;
          entry.path = it.path ?? null;
        }

        if (Array.isArray(it.implements)) {
          entry.implements = it.implements.map((imp) => {
            const norm = normalizeImplementsEntry(imp);
            return {
              flow_id: norm.flow_id,
              node_id: norm.node_id,
              variant: norm.variant ?? null,
              role: norm.role ?? null
            };
          });
        }

        rec.interfaces.push(entry);
      }
    }

    modules.push(rec);
  }

  // Deterministic ordering
  modules.sort((a, b) => (a.module_id || '').localeCompare(b.module_id || ''));

  return {
    registry: {
      version: 1,
      updatedAt: isoNow(),
      modules
    },
    warnings,
    errors
  };
}

function diffSummary(prev, next) {
  try {
    const prevStr = dumpYaml(prev);
    const nextStr = dumpYaml(next);
    if (prevStr === nextStr) return { changed: false };
  } catch {
    // ignore
  }
  return { changed: true };
}

function cmdRegistryBuild(repoRoot, opts, internal = { quiet: false }) {
  const modulesDirOpt = opts['modules-dir'] || 'modules';
  const outPath = path.join(repoRoot, opts.out || '.system/modular/instance_registry.yaml');
  const format = (opts.format || 'text').toLowerCase();

  const prev = fs.existsSync(outPath) ? loadYamlFile(outPath) : null;
  const { registry, warnings, errors } = buildInstanceRegistry(repoRoot, modulesDirOpt);

  ensureDir(path.dirname(outPath));
  saveYamlFile(outPath, registry);

  const diff = diffSummary(prev, registry);
  const reportPath = path.join(repoRoot, '.system', 'modular', 'reports', 'instance_registry.diff.json');
  ensureDir(path.dirname(reportPath));
  writeJson(reportPath, {
    generatedAt: isoNow(),
    out: safeRel(repoRoot, outPath),
    changed: diff.changed,
    warnings,
    errors
  });

  if (internal.quiet) return;

  if (format === 'json') {
    console.log(JSON.stringify({ out: safeRel(repoRoot, outPath), ...registry, warnings, errors }, null, 2));
    return;
  }

  console.log(`[ok] Wrote ${safeRel(repoRoot, outPath)}`);
  const { shouldExit } = printDiagnostics({ warnings, errors });
  if (shouldExit) process.exitCode = 1;
}

function cmdVerify(repoRoot, opts) {
  const strict = !!opts.strict;
  const mods = discoverModules(repoRoot, opts['modules-dir']);

  const warnings = [];
  const errors = [];

  if (mods.length === 0) warnings.push('No modules found (this may be OK for a new repository).');

  for (const m of mods) {
    const manifestRaw = readText(m.manifestPath);
    let manifest;
    try {
      manifest = parseYaml(manifestRaw);
    } catch (e) {
      errors.push(`Failed to parse YAML: ${safeRel(repoRoot, m.manifestPath)} (${e.message})`);
      continue;
    }

    const v = validateManifest(manifest, safeRel(repoRoot, m.manifestPath));
    warnings.push(...v.warnings.map(w => `[${path.basename(m.dir)}] ${w}`));
    errors.push(...v.errors.map(er => `[${path.basename(m.dir)}] ${er}`));

    const registryPath = path.join(m.dir, 'interact', 'registry.json');
    if (!fs.existsSync(registryPath)) {
      warnings.push(`[${path.basename(m.dir)}] Missing interact/registry.json (module context registry SSOT)`);
    } else {
      const reg = readJson(registryPath);
      if (!reg || typeof reg !== 'object') {
        errors.push(`[${path.basename(m.dir)}] interact/registry.json is not valid JSON`);
      }
    }

    // Verify participates_in consistency with implements
    if (Array.isArray(manifest.participates_in) && manifest.participates_in.length > 0) {
      // Build set of implemented flow/node pairs from interfaces
      const implementedFlowNodes = new Set();
      for (const iface of manifest.interfaces || []) {
        for (const impl of iface.implements || []) {
          const norm = normalizeImplementsEntry(impl);
          if (norm.flow_id && norm.node_id) {
            implementedFlowNodes.add(`${norm.flow_id}.${norm.node_id}`);
          }
        }
      }

      // Check each participates_in entry
      for (const entry of manifest.participates_in) {
        const norm = normalizeParticipatesInEntry(entry);
        if (!norm.flow_id || !norm.node_id) continue; // Already reported by validateManifest
        const key = `${norm.flow_id}.${norm.node_id}`;
        if (!implementedFlowNodes.has(key)) {
          errors.push(
            `[${path.basename(m.dir)}] participates_in references ${key} but no interface implements it\n` +
            `  Fix: Either add an interface that implements ${key}, or remove this participates_in entry`
          );
        }
      }
    }
  }

  const { shouldExit } = printDiagnostics({ warnings, errors }, { strict });

  if (shouldExit) process.exit(1);
  console.log('\n[ok] Module verification passed.');
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const { command, opts } = parseArgs(process.argv, { usageFn: usage });
  const repoRoot = repoRootFromOpts(opts);

  switch (command) {
    case 'init':
      cmdInit(repoRoot, opts);
      break;
    case 'list':
      cmdList(repoRoot, opts);
      break;
    case 'registry-build':
      cmdRegistryBuild(repoRoot, opts);
      break;
    case 'verify':
      cmdVerify(repoRoot, opts);
      break;
    default:
      die(`[error] Unknown command: ${command}`);
  }
}

main();
