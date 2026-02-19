/**
 * api-index-smoke.mjs
 * End-to-end smoke test: create fixture modules → generate → verify → diff → regenerate
 */
import fs from 'fs';
import path from 'path';

import { runCommand } from '../../lib/exec.mjs';
import { assertIncludes } from '../../lib/text.mjs';

export const name = 'api-index-smoke';

function writeFixtureModule(rootDir, moduleId, openapi) {
  const interactDir = path.join(rootDir, 'modules', moduleId, 'interact');
  fs.mkdirSync(interactDir, { recursive: true });

  fs.writeFileSync(path.join(interactDir, 'openapi.yaml'), openapi, 'utf8');

  const registry = {
    version: 1,
    moduleId,
    updatedAt: new Date().toISOString(),
    artifacts: [
      {
        artifactId: 'openapi',
        type: 'openapi',
        path: `modules/${moduleId}/interact/openapi.yaml`,
        mode: 'contract',
        format: 'yaml',
        tags: ['api', 'http'],
        checksumSha256: null,
        lastUpdated: null,
      },
    ],
  };
  fs.writeFileSync(path.join(interactDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

const USER_API_OPENAPI = `openapi: 3.1.0
info:
  title: User API
  version: 1.0.0
paths:
  /api/users:
    post:
      operationId: createUser
      summary: Create a new user
      tags: [users]
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email:
                  type: string
                password:
                  type: string
                name:
                  type: string
      responses:
        '201':
          description: User created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                  email:
                    type: string
        '400':
          description: Validation error
        '401':
          description: Unauthorized
    get:
      operationId: listUsers
      summary: List all users
      tags: [users]
      security:
        - bearerAuth: []
      responses:
        '200':
          description: Users list
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
        '401':
          description: Unauthorized
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

const BILLING_API_OPENAPI = `openapi: 3.1.0
info:
  title: Billing API
  version: 1.0.0
paths:
  /api/billing/invoices:
    post:
      operationId: createInvoice
      summary: Create an invoice
      tags: [billing]
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount:
                  type: number
                notes:
                  type: string
      responses:
        '201':
          description: Invoice created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                  amount:
                    type: number
        '400':
          description: Validation error
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

export function run(ctx) {
  const testDir = path.join(ctx.evidenceDir, name);
  const rootDir = path.join(testDir, 'fixture');
  fs.mkdirSync(rootDir, { recursive: true });

  const ctlApiIndex = path.join(ctx.repoRoot, '.ai', 'scripts', 'ctl-api-index.mjs');
  const outJson = path.join(rootDir, 'docs', 'context', 'api', 'api-index.json');
  const outMd = path.join(rootDir, 'docs', 'context', 'api', 'API-INDEX.md');

  // Step 1: Create two fixture modules
  writeFixtureModule(rootDir, 'user.api', USER_API_OPENAPI);
  writeFixtureModule(rootDir, 'billing.api', BILLING_API_OPENAPI);

  // Step 2: generate
  const gen = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'generate', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.generate`,
  });
  if (gen.code !== 0) {
    return { name, status: 'FAIL', error: `generate failed: ${gen.stderr || gen.stdout}` };
  }
  assertIncludes(gen.stdout, '[ok]', 'Expected [ok] in generate output');
  assertIncludes(gen.stdout, '2 modules', 'Expected 2 modules in generate output');
  assertIncludes(gen.stdout, '3 endpoints', 'Expected 3 endpoints in generate output');

  // Step 3: Verify output files exist
  if (!fs.existsSync(outJson)) {
    return { name, status: 'FAIL', error: 'api-index.json not created' };
  }
  if (!fs.existsSync(outMd)) {
    return { name, status: 'FAIL', error: 'API-INDEX.md not created' };
  }

  // Step 4: Validate JSON structure
  const index = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  if (index.version !== 1) {
    return { name, status: 'FAIL', error: `Expected version 1, got ${index.version}` };
  }
  if (index.stats.totalEndpoints !== 3) {
    return { name, status: 'FAIL', error: `Expected 3 endpoints, got ${index.stats.totalEndpoints}` };
  }
  if (index.stats.totalModules !== 2) {
    return { name, status: 'FAIL', error: `Expected 2 modules, got ${index.stats.totalModules}` };
  }
  if (index.sources.length !== 2) {
    return { name, status: 'FAIL', error: `Expected 2 sources, got ${index.sources.length}` };
  }

  const createUser = index.endpoints.find(e => e.operationId === 'createUser');
  if (!createUser) {
    return { name, status: 'FAIL', error: 'createUser endpoint not found' };
  }
  if (createUser.moduleId !== 'user.api') {
    return { name, status: 'FAIL', error: `Expected moduleId user.api, got ${createUser.moduleId}` };
  }
  if (createUser.auth !== 'bearer') {
    return { name, status: 'FAIL', error: `Expected auth bearer, got ${createUser.auth}` };
  }
  if (!createUser.input.body || !createUser.input.body.required.includes('email')) {
    return { name, status: 'FAIL', error: 'createUser missing required field email' };
  }

  // Step 5: verify (should pass)
  const ver = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'verify', '--repo-root', rootDir, '--strict'],
    evidenceDir: testDir,
    label: `${name}.verify`,
  });
  if (ver.code !== 0) {
    return { name, status: 'FAIL', error: `verify failed: ${ver.stderr || ver.stdout}` };
  }
  assertIncludes(ver.stdout, '[ok]', 'Expected [ok] in verify output');

  // Step 6: Modify billing OpenAPI → verify should detect drift
  const billingOpenApi = path.join(rootDir, 'modules', 'billing.api', 'interact', 'openapi.yaml');
  const modified = fs.readFileSync(billingOpenApi, 'utf8').replace('Create an invoice', 'Create a billing invoice');
  fs.writeFileSync(billingOpenApi, modified, 'utf8');

  const verDrift = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'verify', '--repo-root', rootDir, '--strict'],
    evidenceDir: testDir,
    label: `${name}.verify-drift`,
  });
  if (verDrift.code === 0) {
    return { name, status: 'FAIL', error: 'verify should have detected drift' };
  }
  assertIncludes(verDrift.stdout, 'mismatch', 'Expected mismatch in drift verify');

  // Step 7: diff should show changed endpoint
  const diff = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'diff', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.diff`,
  });
  if (diff.code !== 0) {
    return { name, status: 'FAIL', error: `diff failed: ${diff.stderr || diff.stdout}` };
  }
  assertIncludes(diff.stdout, '~', 'Expected ~ (changed) in diff output');
  assertIncludes(diff.stdout, 'billing.api', 'Expected billing.api in diff output');

  // Step 8: re-generate → re-verify
  const regen = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'generate', '--repo-root', rootDir],
    evidenceDir: testDir,
    label: `${name}.regenerate`,
  });
  if (regen.code !== 0) {
    return { name, status: 'FAIL', error: `regenerate failed: ${regen.stderr || regen.stdout}` };
  }

  const reVer = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'verify', '--repo-root', rootDir, '--strict'],
    evidenceDir: testDir,
    label: `${name}.re-verify`,
  });
  if (reVer.code !== 0) {
    return { name, status: 'FAIL', error: `re-verify failed: ${reVer.stderr || reVer.stdout}` };
  }

  // Step 9: Validate Markdown content
  const md = fs.readFileSync(outMd, 'utf8');
  assertIncludes(md, '## billing.api', 'Expected billing.api section in Markdown');
  assertIncludes(md, '## user.api', 'Expected user.api section in Markdown');
  assertIncludes(md, 'Create a new user', 'Expected "Create a new user" summary in Markdown');
  assertIncludes(md, '/api/users', 'Expected /api/users path in Markdown');

  // Step 10: Validate --format json output
  const genJson = runCommand({
    cmd: 'node',
    args: [ctlApiIndex, 'generate', '--repo-root', rootDir, '--format', 'json'],
    evidenceDir: testDir,
    label: `${name}.generate-json`,
  });
  if (genJson.code !== 0) {
    return { name, status: 'FAIL', error: `generate json failed: ${genJson.stderr || genJson.stdout}` };
  }
  const jsonOut = JSON.parse(genJson.stdout);
  if (!jsonOut.ok || jsonOut.modules !== 2) {
    return { name, status: 'FAIL', error: `Unexpected JSON output: ${genJson.stdout}` };
  }

  ctx.log(`[${name}] PASS`);
  return { name, status: 'PASS' };
}
