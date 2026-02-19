/**
 * api-index-focused.mjs
 * Focused regression tests for API Index generator features
 */
import fs from 'fs';
import path from 'path';

import { runCommand } from '../../lib/exec.mjs';

export const name = 'api-index-focused';

function writeModule(rootDir, moduleId, openapiYaml) {
  const interactDir = path.join(rootDir, 'modules', moduleId, 'interact');
  fs.mkdirSync(interactDir, { recursive: true });
  fs.writeFileSync(path.join(interactDir, 'openapi.yaml'), openapiYaml, 'utf8');
  const registry = {
    version: 1,
    moduleId,
    updatedAt: new Date().toISOString(),
    artifacts: [
      { artifactId: 'openapi', type: 'openapi', path: `modules/${moduleId}/interact/openapi.yaml`, mode: 'contract', format: 'yaml', tags: ['api'] },
    ],
  };
  fs.writeFileSync(path.join(interactDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

function generateAndParse(ctlApiIndex, rootDir, testDir, label) {
  const gen = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'generate', '--repo-root', rootDir],
    evidenceDir: testDir,
    label,
  });
  if (gen.code !== 0) throw new Error(`generate failed: ${gen.stderr || gen.stdout}`);
  const outJson = path.join(rootDir, 'docs', 'context', 'api', 'api-index.json');
  return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

function fail(testName, msg) {
  return { name: testName, status: 'FAIL', error: msg };
}

function runSingleTest(testName, fn, ctx, ctlApiIndex) {
  const testDir = path.join(ctx.evidenceDir, name, testName);
  const rootDir = path.join(testDir, 'fixture');
  fs.mkdirSync(rootDir, { recursive: true });
  try {
    fn(rootDir, testDir, ctlApiIndex);
    ctx.log(`[${name}] ${testName}: PASS`);
    return { name: testName, status: 'PASS' };
  } catch (e) {
    ctx.log(`[${name}] ${testName}: FAIL — ${e.message}`);
    return { name: testName, status: 'FAIL', error: e.message };
  }
}

// ============================================================================
// Individual tests
// ============================================================================

function testIdempotentOutput(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'test.api', `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
paths:
  /api/test:
    get:
      operationId: getTest
      summary: Get test
      tags: [test]
      responses:
        '200':
          description: OK
`);

  const idx1 = generateAndParse(ctlApiIndex, rootDir, testDir, 'idempotent-1');
  const idx2 = generateAndParse(ctlApiIndex, rootDir, testDir, 'idempotent-2');

  const s1 = JSON.stringify({ ...idx1, generatedAt: '' });
  const s2 = JSON.stringify({ ...idx2, generatedAt: '' });
  if (s1 !== s2) throw new Error('Two generates produced different content');
}

function testSecuritySchemesLookup(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'auth.api', `openapi: 3.1.0
info:
  title: Auth Test
  version: 1.0.0
paths:
  /api/secret:
    get:
      operationId: getSecret
      summary: Get secret
      tags: [auth]
      security:
        - customAuth: []
      responses:
        '200':
          description: OK
        '401':
          description: Unauthorized
components:
  securitySchemes:
    customAuth:
      type: apiKey
      in: header
      name: X-My-Token
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'security-schemes');
  const ep = idx.endpoints.find(e => e.operationId === 'getSecret');
  if (!ep) throw new Error('getSecret not found');
  if (ep.auth !== 'apiKey') throw new Error(`Expected auth apiKey, got ${ep.auth}`);
  if (!ep.example.curl.includes('X-My-Token')) {
    throw new Error(`Expected X-My-Token in curl, got: ${ep.example.curl}`);
  }
}

function testAnchorFailFast(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'anchor.api', `openapi: 3.1.0
info:
  title: Anchor
  version: 1.0.0
paths:
  /api/anchor:
    get:
      operationId: getAnchor
      summary: &anchorName Test anchor
      tags: [test]
      responses:
        '200':
          description: OK
`);

  const gen = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'generate', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: 'anchor-fail-fast',
  });
  if (gen.code === 0) throw new Error('Expected failure for YAML with anchors');
  if (!gen.stderr.includes('anchors') && !gen.stdout.includes('anchors')) {
    throw new Error('Expected error message about anchors');
  }
}

function testPathLevelParams(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'params.api', `openapi: 3.1.0
info:
  title: Params
  version: 1.0.0
paths:
  /api/items/{itemId}:
    parameters:
      - name: itemId
        in: path
        required: true
    get:
      operationId: getItem
      summary: Get item
      tags: [items]
      parameters:
        - name: fields
          in: query
      responses:
        '200':
          description: OK
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'path-params');
  const ep = idx.endpoints.find(e => e.operationId === 'getItem');
  if (!ep) throw new Error('getItem not found');
  if (!ep.input.params.includes('itemId')) throw new Error('Missing path param itemId');
  if (!ep.input.query.includes('fields')) throw new Error('Missing query param fields');
}

function testMultiModuleAggregation(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'alpha.api', `openapi: 3.1.0
info:
  title: Alpha
  version: 1.0.0
paths:
  /api/alpha:
    get:
      operationId: getAlpha
      summary: Get alpha
      tags: [alpha]
      responses:
        '200':
          description: OK
`);

  writeModule(rootDir, 'beta.api', `openapi: 3.1.0
info:
  title: Beta
  version: 1.0.0
paths:
  /api/beta:
    get:
      operationId: getBeta
      summary: Get beta
      tags: [beta]
      responses:
        '200':
          description: OK
    post:
      operationId: createBeta
      summary: Create beta
      tags: [beta]
      responses:
        '201':
          description: Created
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'multi-module');
  if (idx.stats.totalModules !== 2) throw new Error(`Expected 2 modules, got ${idx.stats.totalModules}`);
  if (idx.stats.totalEndpoints !== 3) throw new Error(`Expected 3 endpoints, got ${idx.stats.totalEndpoints}`);
  if (idx.stats.byModule['alpha.api'] !== 1) throw new Error('Expected 1 endpoint for alpha.api');
  if (idx.stats.byModule['beta.api'] !== 2) throw new Error('Expected 2 endpoints for beta.api');

  const alpha = idx.endpoints.filter(e => e.moduleId === 'alpha.api');
  const beta = idx.endpoints.filter(e => e.moduleId === 'beta.api');
  if (alpha.length !== 1) throw new Error('Expected 1 alpha endpoint');
  if (beta.length !== 2) throw new Error('Expected 2 beta endpoints');
}

function testOptionalAuth(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'optauth.api', `openapi: 3.1.0
info:
  title: Optional Auth
  version: 1.0.0
paths:
  /api/public:
    get:
      operationId: getPublic
      summary: Public endpoint
      tags: [public]
      security:
        - {}
      responses:
        '200':
          description: OK
  /api/optional:
    get:
      operationId: getOptional
      summary: Optional auth endpoint
      tags: [public]
      security:
        - {}
        - bearerAuth: []
      responses:
        '200':
          description: OK
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'optional-auth');

  const pub = idx.endpoints.find(e => e.operationId === 'getPublic');
  if (!pub) throw new Error('getPublic not found');
  if (pub.auth !== 'none') throw new Error(`Expected auth none, got ${pub.auth}`);
  if (pub.example.curl.includes('Authorization')) {
    throw new Error('Public endpoint should have no Authorization header');
  }

  const opt = idx.endpoints.find(e => e.operationId === 'getOptional');
  if (!opt) throw new Error('getOptional not found');
  if (opt.auth !== 'bearer (optional)') throw new Error(`Expected bearer (optional), got ${opt.auth}`);
  if (!opt.example.curl.includes('Bearer')) {
    throw new Error('Optional auth should still generate Bearer header');
  }
}

function testMarkdownNotFalsePositive(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'md.api', `openapi: 3.1.0
info:
  title: Markdown Test
  version: 1.0.0
  description: "Supports *bold* text and &amp; entities"
paths:
  /api/md:
    get:
      operationId: getMd
      summary: "Get *formatted* data"
      tags: [md]
      responses:
        '200':
          description: OK
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'markdown-nofp');
  const ep = idx.endpoints.find(e => e.operationId === 'getMd');
  if (!ep) throw new Error('getMd not found');
}

function testRefWithHash(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'ref.api', `openapi: 3.1.0
info:
  title: Ref Test
  version: 1.0.0
paths:
  /api/refs:
    get:
      operationId: getRefs
      summary: Test refs
      tags: [ref]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                  name:
                    type: string
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'ref-hash');
  const ep = idx.endpoints.find(e => e.operationId === 'getRefs');
  if (!ep) throw new Error('getRefs not found');
  if (!ep.output.coreFields.includes('id')) throw new Error('Missing id in coreFields');
  if (!ep.output.coreFields.includes('name')) throw new Error('Missing name in coreFields');
}

function testVerifyEmptySourcesDetectsModules(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'leak.api', `openapi: 3.1.0
info:
  title: Leak Test
  version: 1.0.0
paths:
  /api/leak:
    get:
      operationId: getLeak
      summary: Leak test
      tags: [leak]
      responses:
        '200':
          description: OK
`);

  const outDir = path.join(rootDir, 'docs', 'context', 'api');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'api-index.json'),
    JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00Z', sources: [], endpoints: [], stats: { totalModules: 0, totalEndpoints: 0, byModule: {} } }, null, 2) + '\n',
    'utf8'
  );

  const res = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'verify', '--strict', '--format', 'json', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: 'verify-empty-sources',
  });

  if (res.code === 0) {
    throw new Error('verify --strict should fail when sources is empty but modules exist');
  }

  const out = JSON.parse(res.stdout.trim());
  if (out.ok !== false) throw new Error(`Expected ok:false, got ok:${out.ok}`);
  if (!out.newModules || !out.newModules.includes('leak.api')) {
    throw new Error(`Expected newModules to include leak.api, got: ${JSON.stringify(out.newModules)}`);
  }
}

function testQuotedStringUnescape(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'quote.api', `openapi: 3.1.0
info:
  title: "Quote \\"Test\\""
  version: 1.0.0
paths:
  /api/quote:
    get:
      operationId: getQuote
      summary: "Say \\"hi\\""
      tags: [quote]
      responses:
        '200':
          description: OK
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'quoted-unescape');
  const ep = idx.endpoints.find(e => e.operationId === 'getQuote');
  if (!ep) throw new Error('getQuote not found');
  if (ep.summary !== 'Say "hi"') {
    throw new Error(`Expected summary 'Say "hi"', got: ${JSON.stringify(ep.summary)}`);
  }
}

function testLiteralBackslashInQuotedString(rootDir, testDir, ctlApiIndex) {
  writeModule(rootDir, 'bslash.api', `openapi: 3.1.0
info:
  title: Backslash Test
  version: 1.0.0
paths:
  /api/bslash:
    get:
      operationId: getBslash
      summary: "path is C:\\\\Users\\\\me"
      tags: [bslash]
      responses:
        '200':
          description: OK
  /api/literal-n:
    get:
      operationId: getLiteralN
      summary: "line ends with \\\\n"
      tags: [bslash]
      responses:
        '200':
          description: OK
`);

  const idx = generateAndParse(ctlApiIndex, rootDir, testDir, 'literal-backslash');

  const ep1 = idx.endpoints.find(e => e.operationId === 'getBslash');
  if (!ep1) throw new Error('getBslash not found');
  if (ep1.summary !== 'path is C:\\Users\\me') {
    throw new Error(`Expected 'path is C:\\Users\\me', got: ${JSON.stringify(ep1.summary)}`);
  }

  const ep2 = idx.endpoints.find(e => e.operationId === 'getLiteralN');
  if (!ep2) throw new Error('getLiteralN not found');
  if (ep2.summary !== 'line ends with \\n') {
    throw new Error(`Expected 'line ends with \\n' (4 chars at end), got: ${JSON.stringify(ep2.summary)} (last char code: ${ep2.summary.charCodeAt(ep2.summary.length - 1)})`);
  }
}

// ============================================================================
// Runner
// ============================================================================

export function run(ctx) {
  const ctlApiIndex = path.join(ctx.repoRoot, '.ai', 'scripts', 'ctl-api-index.mjs');
  const tests = [
    ['idempotent', testIdempotentOutput],
    ['securitySchemes', testSecuritySchemesLookup],
    ['anchor-fail-fast', testAnchorFailFast],
    ['path-level-params', testPathLevelParams],
    ['multi-module', testMultiModuleAggregation],
    ['optional-auth', testOptionalAuth],
    ['markdown-no-false-positive', testMarkdownNotFalsePositive],
    ['ref-with-hash', testRefWithHash],
    ['verify-empty-sources', testVerifyEmptySourcesDetectsModules],
    ['quoted-string-unescape', testQuotedStringUnescape],
    ['literal-backslash', testLiteralBackslashInQuotedString],
  ];

  let failed = 0;
  for (const [testName, fn] of tests) {
    const res = runSingleTest(testName, fn, ctx, ctlApiIndex);
    if (res.status === 'FAIL') failed++;
  }

  if (failed > 0) {
    return { name, status: 'FAIL', error: `${failed} focused test(s) failed` };
  }

  ctx.log(`[${name}] (${tests.length} tests) PASS`);
  return { name, status: 'PASS' };
}
