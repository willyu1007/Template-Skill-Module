/**
 * quality-gate-tests.mjs
 * Tests for ctl-openapi-quality.mjs and glossary verify in ctl-context.mjs:
 *   1) Valid OpenAPI with all required fields passes
 *   2) Missing operationId detected
 *   3) Duplicate operationId detected
 *   4) Undeclared path param detected
 *   5) Missing security scheme ref detected
 *   6) Empty paths exits 0
 *   7) File not found exits 0 with skip message
 *   8) Glossary verify: valid empty glossary passes
 *   9) Glossary verify: term missing definition fails
 *  10) Glossary verify: missing "version" field fails strict
 *  11) Glossary verify: missing "terms" field fails strict
 *  12) Glossary verify: version != 1 fails strict (const constraint)
 *  13) Glossary verify: extra root property fails strict (additionalProperties)
 *  14) Glossary verify: extra item property fails strict (additionalProperties)
 *  15) Glossary verify: aliases with non-string items fails (items.type)
 *  16) Glossary verify: updatedAt with wrong type fails (type: string)
 *  17) Glossary verify: corrupt schema file fails hard
 *  18) Glossary verify: --strict works without Ajv (built-in fallback, catches errors)
 *  19) Cross-file duplicate operationId detected with --discover-modules
 */
import fs from 'fs';
import path from 'path';
import { runCommand } from '../../lib/exec.mjs';

export const name = 'quality-gate-tests';

function schemaTemplatePath(ctx) {
  return path.join(ctx.repoRoot, '.ai', 'skills', 'features', 'context-awareness',
    'templates', 'docs', 'context', 'knowledge', 'glossary.schema.json');
}

function makeFixtureDir(ctx, sub) {
  const d = path.join(ctx.evidenceDir, name, sub);
  const apiDir = path.join(d, 'docs', 'context', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  return { rootDir: d, apiDir };
}

function qualityPath(ctx) {
  return path.join(ctx.repoRoot, '.ai', 'scripts', 'ctl-openapi-quality.mjs');
}

function contextPath(ctx) {
  return path.join(ctx.repoRoot, '.ai', 'skills', 'features', 'context-awareness', 'scripts', 'ctl-context.mjs');
}

function writeYaml(apiDir, yaml) {
  fs.writeFileSync(path.join(apiDir, 'openapi.yaml'), yaml, 'utf8');
}

function runQuality(ctx, rootDir, sub, extraArgs = []) {
  return runCommand({
    cmd: 'node',
    args: [qualityPath(ctx), 'verify', '--source', 'docs/context/api/openapi.yaml', '--repo-root', rootDir, '--strict', ...extraArgs],
    evidenceDir: path.join(ctx.evidenceDir, name),
    label: sub,
  });
}

const VALID_OPENAPI = `openapi: "3.1.0"
info:
  title: Test API
  version: 1.0.0
paths:
  /api/items:
    get:
      operationId: listItems
      summary: List all items
      tags: [items]
      responses:
        "200":
          description: OK
  /api/items/{id}:
    get:
      operationId: getItem
      summary: Get one item
      tags: [items]
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
        "404":
          description: Not found
components:
  schemas: {}
`;

export function run(ctx) {
  const checks = [];
  let allPass = true;

  function check(label, fn) {
    try {
      const ok = fn();
      checks.push({ label, ok });
      if (!ok) allPass = false;
    } catch (e) {
      checks.push({ label, ok: false, error: e.message });
      allPass = false;
    }
  }

  // 1) Valid OpenAPI passes
  check('valid-openapi-passes', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'valid');
    writeYaml(apiDir, VALID_OPENAPI);
    const r = runQuality(ctx, rootDir, 'valid');
    return r.code === 0;
  });

  // 2) Missing operationId detected
  check('missing-operationId', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'no-opid');
    writeYaml(apiDir, `openapi: "3.1.0"
info:
  title: Test
  version: 1.0.0
paths:
  /api/x:
    get:
      summary: No operationId
      tags: [x]
      responses:
        "200":
          description: OK
components:
  schemas: {}
`);
    const r = runQuality(ctx, rootDir, 'no-opid');
    return r.code !== 0 && (r.stdout + r.stderr).includes('operationId');
  });

  // 3) Duplicate operationId detected
  check('duplicate-operationId', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'dup-opid');
    writeYaml(apiDir, `openapi: "3.1.0"
info:
  title: Test
  version: 1.0.0
paths:
  /api/a:
    get:
      operationId: doStuff
      summary: A
      tags: [a]
      responses:
        "200":
          description: OK
  /api/b:
    get:
      operationId: doStuff
      summary: B
      tags: [b]
      responses:
        "200":
          description: OK
components:
  schemas: {}
`);
    const r = runQuality(ctx, rootDir, 'dup-opid');
    return r.code !== 0 && (r.stdout + r.stderr).includes('Duplicate');
  });

  // 4) Undeclared path param
  check('undeclared-path-param', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'bad-param');
    writeYaml(apiDir, `openapi: "3.1.0"
info:
  title: Test
  version: 1.0.0
paths:
  /api/items/{id}:
    get:
      operationId: getItem
      summary: Get item
      tags: [items]
      responses:
        "200":
          description: OK
components:
  schemas: {}
`);
    const r = runQuality(ctx, rootDir, 'bad-param');
    return r.code !== 0 && (r.stdout + r.stderr).includes('{id}');
  });

  // 5) Missing security scheme ref
  check('missing-security-scheme', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'bad-sec');
    writeYaml(apiDir, `openapi: "3.1.0"
info:
  title: Test
  version: 1.0.0
paths:
  /api/x:
    get:
      operationId: getX
      summary: X
      tags: [x]
      security:
        - nonExistentScheme: []
      responses:
        "200":
          description: OK
components:
  schemas: {}
  securitySchemes: {}
`);
    const r = runQuality(ctx, rootDir, 'bad-sec');
    return r.code !== 0 && (r.stdout + r.stderr).includes('nonExistentScheme');
  });

  // 6) Empty paths exits 0
  check('empty-paths-ok', () => {
    const { rootDir, apiDir } = makeFixtureDir(ctx, 'empty');
    writeYaml(apiDir, `openapi: "3.1.0"
info:
  title: Test
  version: 1.0.0
paths: {}
components:
  schemas: {}
`);
    const r = runQuality(ctx, rootDir, 'empty');
    return r.code === 0;
  });

  // 7) File not found exits 0
  check('file-not-found-skip', () => {
    const rootDir = path.join(ctx.evidenceDir, name, 'nofile');
    fs.mkdirSync(rootDir, { recursive: true });
    const r = runQuality(ctx, rootDir, 'nofile');
    return r.code === 0 && (r.stdout + r.stderr).includes('skip');
  });

  // --- Glossary verification tests ---
  // Module-first: uses project.registry.json (SSOT) with moduleId/artifactId fields

  function makeGlossaryFixture(ctx, sub, glossaryData) {
    const rootDir = path.join(ctx.evidenceDir, name, sub);
    const contextDir = path.join(rootDir, 'docs', 'context');
    fs.mkdirSync(path.join(contextDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(contextDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(contextDir, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'knowledge', 'glossary.json'),
      JSON.stringify(glossaryData, null, 2), 'utf8');
    const schemaSrc = schemaTemplatePath(ctx);
    if (fs.existsSync(schemaSrc)) {
      fs.copyFileSync(schemaSrc, path.join(contextDir, 'knowledge', 'glossary.schema.json'));
    }
    fs.writeFileSync(path.join(contextDir, 'project.registry.json'), JSON.stringify({
      version: 1, moduleId: 'project', updatedAt: '2025-01-01T00:00:00.000Z', artifacts: [
        { artifactId: 'glossary', type: 'json', path: 'docs/context/knowledge/glossary.json', mode: 'contract' }
      ]
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(contextDir, 'INDEX.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(contextDir, 'config', 'environment-registry.json'), JSON.stringify({
      version: 1, environments: []
    }, null, 2), 'utf8');
    return rootDir;
  }

  function runGlossaryVerify(ctx, rootDir, label, strict = true) {
    const args = [contextPath(ctx), 'verify', '--repo-root', rootDir];
    if (strict) args.push('--strict');
    return runCommand({
      cmd: 'node', args,
      evidenceDir: path.join(ctx.evidenceDir, name),
      label,
    });
  }

  // 8) Glossary verify: valid empty glossary
  check('glossary-verify-valid-empty', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-valid', {
      version: 1, updatedAt: '2025-01-01T00:00:00.000Z', terms: []
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-valid', false);
    return r.code === 0;
  });

  // 9) Glossary verify: term missing definition fails
  check('glossary-verify-invalid', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-invalid', {
      version: 1, updatedAt: '2025-01-01T00:00:00.000Z', terms: [{ term: 'foo' }]
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-invalid', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('definition');
  });

  // 10) Glossary verify: missing "version" field fails
  check('glossary-missing-version', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-no-version', { terms: [] });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-no-version', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('version');
  });

  // 11) Glossary verify: missing "terms" field fails
  check('glossary-missing-terms', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-no-terms', { version: 1 });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-no-terms', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('terms');
  });

  // 12) Glossary verify: version != 1 fails (const constraint from schema)
  check('glossary-wrong-version', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-wrong-ver', {
      version: 2, updatedAt: '2025-01-01T00:00:00.000Z', terms: []
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-wrong-ver', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('must be 1');
  });

  // 13) Glossary verify: extra root property fails (additionalProperties: false)
  check('glossary-extra-root-prop', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-extra-root', {
      version: 1, updatedAt: '2025-01-01T00:00:00.000Z', terms: [], extra_field: true
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-extra-root', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('extra_field');
  });

  // 14) Glossary verify: extra item property fails (additionalProperties: false)
  check('glossary-extra-item-prop', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-extra-item', {
      version: 1, updatedAt: '2025-01-01T00:00:00.000Z',
      terms: [{ term: 'foo', definition: 'bar', custom: 123 }]
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-extra-item', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('custom');
  });

  // 15) Glossary verify: aliases with non-string items fails (items.type)
  check('glossary-aliases-item-type', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-aliases-type', {
      version: 1, updatedAt: '2025-01-01T00:00:00.000Z',
      terms: [{ term: 'foo', definition: 'bar', aliases: [123] }]
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-aliases-type', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('string');
  });

  // 16) Glossary verify: updatedAt with wrong type fails (type: string)
  check('glossary-updatedAt-wrong-type', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-updatedAt-type', {
      version: 1, updatedAt: 123, terms: []
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-updatedAt-type', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('string');
  });

  // 17) Glossary verify: corrupt schema file fails hard (not silent degrade)
  check('glossary-corrupt-schema', () => {
    const rootDir = path.join(ctx.evidenceDir, name, 'glossary-corrupt-schema');
    const contextDir = path.join(rootDir, 'docs', 'context');
    fs.mkdirSync(path.join(contextDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(contextDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(contextDir, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'knowledge', 'glossary.json'), JSON.stringify({
      version: 1, terms: []
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(contextDir, 'knowledge', 'glossary.schema.json'), 'NOT VALID JSON{{{', 'utf8');
    fs.writeFileSync(path.join(contextDir, 'project.registry.json'), JSON.stringify({
      version: 1, moduleId: 'project', updatedAt: '2025-01-01T00:00:00.000Z', artifacts: [
        { artifactId: 'glossary', type: 'json', path: 'docs/context/knowledge/glossary.json', mode: 'contract' }
      ]
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(contextDir, 'INDEX.md'), '# Index\n', 'utf8');
    fs.writeFileSync(path.join(contextDir, 'config', 'environment-registry.json'), JSON.stringify({
      version: 1, environments: []
    }, null, 2), 'utf8');
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-corrupt-schema', false);
    return r.code !== 0 && (r.stdout + r.stderr).includes('failed to parse');
  });

  // 18) Glossary verify: --strict works with built-in fallback and catches errors
  check('glossary-strict-fallback-catches-errors', () => {
    const rootDir = makeGlossaryFixture(ctx, 'glossary-strict-fallback', {
      version: 2, updatedAt: '2025-01-01T00:00:00.000Z', terms: []
    });
    const r = runGlossaryVerify(ctx, rootDir, 'glossary-strict-fallback', true);
    return r.code !== 0 && (r.stdout + r.stderr).includes('must be 1');
  });

  // 19) Cross-file duplicate operationId detected with --discover-modules
  check('cross-file-duplicate-operationId', () => {
    const rootDir = path.join(ctx.evidenceDir, name, 'cross-dup');
    const modADir = path.join(rootDir, 'modules', 'modA', 'interact');
    const modBDir = path.join(rootDir, 'modules', 'modB', 'interact');
    fs.mkdirSync(modADir, { recursive: true });
    fs.mkdirSync(modBDir, { recursive: true });

    const modAReg = { version: 1, moduleId: 'modA', artifacts: [{ artifactId: 'api', type: 'openapi', path: 'modules/modA/interact/openapi.yaml' }] };
    const modBReg = { version: 1, moduleId: 'modB', artifacts: [{ artifactId: 'api', type: 'openapi', path: 'modules/modB/interact/openapi.yaml' }] };
    fs.writeFileSync(path.join(modADir, 'registry.json'), JSON.stringify(modAReg, null, 2), 'utf8');
    fs.writeFileSync(path.join(modBDir, 'registry.json'), JSON.stringify(modBReg, null, 2), 'utf8');

    const openapiA = `openapi: "3.1.0"
info:
  title: Module A
  version: 1.0.0
paths:
  /api/a/items:
    get:
      operationId: sameOp
      summary: A items
      tags: [a]
      responses:
        "200":
          description: OK
`;
    const openapiB = `openapi: "3.1.0"
info:
  title: Module B
  version: 1.0.0
paths:
  /api/b/items:
    get:
      operationId: sameOp
      summary: B items
      tags: [b]
      responses:
        "200":
          description: OK
`;
    fs.writeFileSync(path.join(modADir, 'openapi.yaml'), openapiA, 'utf8');
    fs.writeFileSync(path.join(modBDir, 'openapi.yaml'), openapiB, 'utf8');

    const r = runCommand({
      cmd: 'node',
      args: [qualityPath(ctx), 'verify', '--discover-modules', '--strict', '--repo-root', rootDir],
      evidenceDir: path.join(ctx.evidenceDir, name),
      label: 'cross-dup',
    });
    return r.code !== 0 && (r.stdout + r.stderr).includes('cross-file') && (r.stdout + r.stderr).includes('sameOp');
  });

  ctx.log(`[${name}] results: ${checks.map(c => `${c.label}=${c.ok ? 'PASS' : 'FAIL'}`).join(', ')}`);
  return {
    name,
    status: allPass ? 'PASS' : 'FAIL',
    checks,
  };
}
