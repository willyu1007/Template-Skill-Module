#!/usr/bin/env node
/**
 * ci-verify.mjs
 *
 * Shared, deterministic verification entrypoint used by CI templates.
 * This is NOT a Git hook; it lives under .githooks/ to co-locate governance checks
 * with the optional local hook automation.
 *
 * Usage:
 *   node .githooks/ci-verify.mjs
 *
 * Optional env:
 *   GOV_PROJECT=<slug>   Project slug for governance lint (default: main)
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const printable = `${cmd} ${args.join(' ')}`;
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    process.stderr.write(`\n[ci-verify] FAILED: ${printable}\n`);
    process.exit(res.status || 1);
  }
}

function assertTrackedAndClean(files) {
  const existing = files.filter(f => fs.existsSync(f));
  if (existing.length === 0) return;

  const untracked = [];
  for (const f of existing) {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', f], { encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) untracked.push(f);
  }
  if (untracked.length > 0) {
    process.stderr.write(`\n[ci-verify] FAILED: generated files not tracked by git:\n`);
    for (const f of untracked) process.stderr.write(`  ${f}\n`);
    process.stderr.write(`Add them with: git add ${untracked.join(' ')}\n`);
    process.exit(1);
  }

  const diffRes = spawnSync('git', ['diff', '--exit-code', ...existing], { stdio: 'inherit' });
  if (diffRes.status !== 0) {
    process.stderr.write(`\n[ci-verify] FAILED: git diff --exit-code ${existing.join(' ')}\n`);
    process.exit(diffRes.status || 1);
  }
}

function hasModuleOpenApis() {
  if (!fs.existsSync('modules')) return false;
  try {
    for (const entry of fs.readdirSync('modules', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const regPath = `modules/${entry.name}/interact/registry.json`;
      if (!fs.existsSync(regPath)) continue;
      try {
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        if (reg?.artifacts?.some(a => a.type === 'openapi')) return true;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return false;
}

function hasProjectOpenApi() {
  return fs.existsSync('docs/context/api/openapi.yaml') || fs.existsSync('docs/context/api/openapi.yml');
}

function main() {
  const project = process.env.GOV_PROJECT || 'main';

  // Governance checks
  run('node', ['.ai/scripts/lint-skills.mjs', '--strict']);
  run('node', ['.ai/scripts/lint-docs.mjs']);
  run('node', ['.ai/scripts/ctl-project-state.mjs', 'verify']);
  run('node', ['.ai/scripts/ctl-project-governance.mjs', 'lint', '--check', '--project', project]);

  // API context suite (skip if no OpenAPI files exist)
  if (hasModuleOpenApis() || hasProjectOpenApi()) {
    console.log('\n[ci-verify] Running api-context verification...');
    run('node', ['.ai/scripts/ctl-openapi-quality.mjs', 'verify', '--discover-modules', '--strict']);
    run('node', ['.ai/scripts/ctl-api-index.mjs', 'generate', '--touch']);
    run('node', ['.ai/scripts/ctl-api-index.mjs', 'verify', '--strict']);
    run('node', ['.ai/skills/features/context-awareness/scripts/ctl-context.mjs', 'build']);
    run('node', ['.ai/skills/features/context-awareness/scripts/ctl-context.mjs', 'verify', '--strict']);
    assertTrackedAndClean([
      'docs/context/api/api-index.json',
      'docs/context/api/API-INDEX.md',
      'docs/context/registry.json',
      'docs/context/project.registry.json',
    ]);
  } else {
    console.log('\n[ci-verify] [skip] api-context: no OpenAPI files found.');
  }
}

main();
