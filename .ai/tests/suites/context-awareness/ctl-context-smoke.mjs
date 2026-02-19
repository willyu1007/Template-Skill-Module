/**
 * ctl-context-smoke.mjs
 * Smoke test for ctl-context.mjs (init → add-artifact → touch → verify)
 */
import fs from 'fs';
import path from 'path';

import { runCommand } from '../../lib/exec.mjs';
import { assertIncludes } from '../../lib/text.mjs';

export const name = 'context-awareness-ctl-context-smoke';

export function run(ctx) {
  const testDir = path.join(ctx.evidenceDir, name);
  const rootDir = path.join(testDir, 'fixture');
  fs.mkdirSync(rootDir, { recursive: true });

  const ctlContext = path.join(
    ctx.repoRoot,
    '.ai',
    'skills',
    'features',
    'context-awareness',
    'scripts',
    'ctl-context.mjs'
  );

  // 1) init
  const init = runCommand({
    cmd: 'node',
    args: [ctlContext, 'init', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.init`,
  });
  if (init.error || init.code !== 0) {
    const detail = init.error ? String(init.error) : init.stderr || init.stdout;
    return { name, status: 'FAIL', error: `ctl-context init failed: ${detail}` };
  }

  const registryPath = path.join(rootDir, 'docs', 'context', 'registry.json');
  if (!fs.existsSync(registryPath)) {
    return { name, status: 'FAIL', error: 'init did not create docs/context/registry.json' };
  }

  // 2) add-artifact (create a dummy openapi file first)
  const apiDir = path.join(rootDir, 'docs', 'context', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  const openapiPath = path.join(apiDir, 'test-api.yaml');
  fs.writeFileSync(
    openapiPath,
    `openapi: 3.1.0
info:
  title: Test API
  version: 0.1.0
paths: {}
`,
    'utf8'
  );

  const addArtifact = runCommand({
    cmd: 'node',
    args: [
      ctlContext,
      'add-artifact',
      '--artifact-id',
      'test-api',
      '--type',
      'openapi',
      '--path',
      'docs/context/api/test-api.yaml',
      '--repo-root',
      rootDir,
    ],
    evidenceDir: testDir,
    label: `${name}.add-artifact`,
  });
  if (addArtifact.error || addArtifact.code !== 0) {
    const detail = addArtifact.error ? String(addArtifact.error) : addArtifact.stderr || addArtifact.stdout;
    return { name, status: 'FAIL', error: `ctl-context add-artifact failed: ${detail}` };
  }

  // 3) touch
  const touch = runCommand({
    cmd: 'node',
    args: [ctlContext, 'touch', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.touch`,
  });
  if (touch.error || touch.code !== 0) {
    const detail = touch.error ? String(touch.error) : touch.stderr || touch.stdout;
    return { name, status: 'FAIL', error: `ctl-context touch failed: ${detail}` };
  }

  // 4) list
  const list = runCommand({
    cmd: 'node',
    args: [ctlContext, 'list', '--repo-root', rootDir, '--format', 'json'],
    evidenceDir: testDir,
    label: `${name}.list`,
  });
  if (list.error || list.code !== 0) {
    const detail = list.error ? String(list.error) : list.stderr || list.stdout;
    return { name, status: 'FAIL', error: `ctl-context list failed: ${detail}` };
  }
  assertIncludes(list.stdout, 'test-api', 'Expected test-api in list output');

  // 5) verify --strict
  const verify = runCommand({
    cmd: 'node',
    args: [ctlContext, 'verify', '--repo-root', rootDir, '--strict'],
    evidenceDir: testDir,
    label: `${name}.verify`,
  });
  if (verify.error || verify.code !== 0) {
    const detail = verify.error ? String(verify.error) : verify.stderr || verify.stdout;
    return { name, status: 'FAIL', error: `ctl-context verify failed: ${detail}` };
  }
  assertIncludes(verify.stdout, '[ok]', 'Expected [ok] in verify output');

  // 6) remove-artifact
  const removeArtifact = runCommand({
    cmd: 'node',
    args: [ctlContext, 'remove-artifact', '--artifact-id', 'test-api', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.remove-artifact`,
  });
  if (removeArtifact.error || removeArtifact.code !== 0) {
    const detail = removeArtifact.error ? String(removeArtifact.error) : removeArtifact.stderr || removeArtifact.stdout;
    return { name, status: 'FAIL', error: `ctl-context remove-artifact failed: ${detail}` };
  }

  // Verify artifact removed from registry
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const found = (registry.artifacts || []).find((a) => (a.artifactId ?? a.id) === 'test-api');
  if (found) {
    return { name, status: 'FAIL', error: 'test-api artifact still in registry after remove' };
  }

  ctx.log(`[${name}] PASS`);
  return { name, status: 'PASS' };
}
