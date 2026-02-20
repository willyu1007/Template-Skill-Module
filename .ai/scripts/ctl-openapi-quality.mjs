#!/usr/bin/env node
/**
 * ctl-openapi-quality.mjs
 *
 * OpenAPI semantic quality gate for the API context pipeline.
 * Zero-dependency layer validates structure; optional enhancement layer
 * uses @apidevtools/swagger-parser when available.
 *
 * Supports two modes:
 *   --source <path>         Validate a single OpenAPI file
 *   --discover-modules      Auto-discover and validate all module OpenAPI files
 *
 * Commands:
 *   verify   Validate OpenAPI file(s) for semantic quality
 *   help     Show help
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './lib/yaml.mjs';

// ============================================================================
// CLI
// ============================================================================

function usage(exitCode = 0) {
  const msg = `
Usage:
  node .ai/scripts/ctl-openapi-quality.mjs <command> [options]

Commands:
  help
    Show this help.

  verify
    --source <path>             Path to a single OpenAPI file
    --discover-modules          Auto-discover all module OpenAPI files
    --strict                    Treat warnings as errors
    --format <text|json>        Output format (default: text)
    --repo-root <path>          Repo root (default: cwd)

    When neither --source nor --discover-modules is given, defaults to
    --discover-modules if modules/ exists, otherwise checks
    docs/context/api/openapi.yaml.
`;
  console.log(msg.trim());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'verify';
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source' && args[i + 1]) opts.source = args[++i];
    else if (a === '--discover-modules') opts.discoverModules = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--format' && args[i + 1]) opts.format = args[++i];
    else if (a === '--repo-root' && args[i + 1]) opts['repo-root'] = args[++i];
    else if (a === '-h' || a === '--help') { usage(0); }
  }
  return { command, opts };
}

// ============================================================================
// Quality Checks (zero-dependency layer)
// ============================================================================

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

function collectEndpoints(doc) {
  const endpoints = [];
  const paths = doc.paths || {};
  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const merged = mergeParams(pathParams, opParams);
      endpoints.push({ apiPath, method, op, params: merged });
    }
  }
  return endpoints;
}

function mergeParams(pathLevel, opLevel) {
  const map = new Map();
  for (const p of pathLevel) {
    if (p && p.in && p.name) map.set(`${p.in}:${p.name}`, p);
  }
  for (const p of opLevel) {
    if (p && p.in && p.name) map.set(`${p.in}:${p.name}`, p);
  }
  return [...map.values()];
}

function checkRequiredFields(endpoints) {
  const issues = [];
  for (const { apiPath, method, op } of endpoints) {
    const loc = `${method.toUpperCase()} ${apiPath}`;
    if (!op.operationId) {
      issues.push({ level: 'error', check: 'required-fields', message: `${loc}: missing operationId` });
    }
    if (!op.summary) {
      issues.push({ level: 'error', check: 'required-fields', message: `${loc}: missing summary` });
    }
    if (!Array.isArray(op.tags) || op.tags.length === 0) {
      issues.push({ level: 'error', check: 'required-fields', message: `${loc}: missing or empty tags array` });
    }
    const responses = op.responses || {};
    const has2xx = Object.keys(responses).some(code => /^2\d{2}$/.test(code));
    if (!has2xx) {
      issues.push({ level: 'error', check: 'required-fields', message: `${loc}: no 2xx response defined` });
    }
  }
  return issues;
}

function checkUniqueOperationId(endpoints) {
  const issues = [];
  const seen = new Map();
  for (const { apiPath, method, op } of endpoints) {
    if (!op.operationId) continue;
    const key = op.operationId;
    if (seen.has(key)) {
      issues.push({
        level: 'error', check: 'unique-operationId',
        message: `Duplicate operationId "${key}": ${seen.get(key)} and ${method.toUpperCase()} ${apiPath}`
      });
    } else {
      seen.set(key, `${method.toUpperCase()} ${apiPath}`);
    }
  }
  return issues;
}

function checkSecurityRefs(doc, endpoints) {
  const issues = [];
  const schemes = doc.components?.securitySchemes || {};
  const schemeNames = new Set(Object.keys(schemes));

  for (const { apiPath, method, op } of endpoints) {
    const security = op.security ?? doc.security;
    if (!Array.isArray(security)) continue;
    for (const entry of security) {
      if (!entry || typeof entry !== 'object') continue;
      for (const name of Object.keys(entry)) {
        if (!schemeNames.has(name)) {
          issues.push({
            level: 'error', check: 'security-refs',
            message: `${method.toUpperCase()} ${apiPath}: security scheme "${name}" not found in components.securitySchemes`
          });
        }
      }
    }
  }
  return issues;
}

function checkPathParams(endpoints) {
  const issues = [];
  for (const { apiPath, method, params } of endpoints) {
    const placeholders = [...apiPath.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    const declaredPath = new Set(
      params.filter(p => p.in === 'path').map(p => p.name)
    );
    for (const ph of placeholders) {
      if (!declaredPath.has(ph)) {
        issues.push({
          level: 'error', check: 'path-params',
          message: `${method.toUpperCase()} ${apiPath}: path parameter "{${ph}}" not declared in parameters`
        });
      }
    }
  }
  return issues;
}

function checkRefResolution(doc) {
  const issues = [];
  const schemas = doc.components?.schemas || {};
  const schemaNames = new Set(Object.keys(schemas));

  function walkRefs(obj, context) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) walkRefs(item, context);
      return;
    }
    if (obj.$ref && typeof obj.$ref === 'string') {
      const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
      if (match && !schemaNames.has(match[1])) {
        issues.push({
          level: 'error', check: 'ref-resolution',
          message: `${context}: $ref "${obj.$ref}" references non-existent schema "${match[1]}"`
        });
      }
    }
    for (const [key, val] of Object.entries(obj)) {
      if (key === '$ref') continue;
      walkRefs(val, context);
    }
  }

  const paths = doc.paths || {};
  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      walkRefs(op, `${method.toUpperCase()} ${apiPath}`);
    }
  }
  return issues;
}

// ============================================================================
// Cross-File Checks
// ============================================================================

function checkCrossFileOperationIdUniqueness(allOperationIds) {
  const issues = [];
  const seen = new Map();
  for (const { id, loc, file } of allOperationIds) {
    const prev = seen.get(id);
    if (prev) {
      issues.push({
        level: 'error',
        check: 'cross-file-unique-operationId',
        message: `Duplicate operationId "${id}" across files: [${prev.file}] ${prev.loc} and [${file}] ${loc}`
      });
    } else {
      seen.set(id, { loc, file });
    }
  }
  return issues;
}

// ============================================================================
// Optional Enhancement Layer
// ============================================================================

async function tryEnhancedValidation(sourcePath) {
  try {
    const mod = await import('@apidevtools/swagger-parser');
    const SwaggerParser = mod.default || mod;
    await SwaggerParser.validate(sourcePath);
    return { available: true, issues: [] };
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      return { available: false, issues: [] };
    }
    return {
      available: true,
      issues: [{ level: 'error', check: 'openapi-spec-compliance', message: err.message }]
    };
  }
}

// ============================================================================
// Module Discovery
// ============================================================================

function discoverModuleOpenApis(repoRoot) {
  const modulesDir = path.join(repoRoot, 'modules');
  if (!fs.existsSync(modulesDir)) return [];

  const results = [];
  let entries;
  try { entries = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleId = entry.name;
    const registryPath = path.join(modulesDir, moduleId, 'interact', 'registry.json');
    let registry;
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { continue; }
    if (!registry || !Array.isArray(registry.artifacts)) continue;

    for (const art of registry.artifacts) {
      if (art.type !== 'openapi') continue;
      const openapiRel = art.path || path.join('modules', moduleId, 'interact', 'openapi.yaml');
      const openapiAbs = path.resolve(repoRoot, openapiRel);
      if (fs.existsSync(openapiAbs)) {
        results.push({ moduleId, path: openapiRel, absPath: openapiAbs });
      }
    }
  }
  return results;
}

// ============================================================================
// Report
// ============================================================================

function formatText(allIssues, enhanced) {
  if (allIssues.length === 0) {
    const suffix = enhanced ? ' (with full OpenAPI spec compliance)' : '';
    console.log(`[ok] OpenAPI quality check passed${suffix}.`);
    return;
  }
  const errors = allIssues.filter(i => i.level === 'error');
  const warnings = allIssues.filter(i => i.level === 'warning');
  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const i of errors) console.log(`  [${i.check}] ${i.message}`);
  }
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const i of warnings) console.log(`  [${i.check}] ${i.message}`);
  }
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
}

function formatJson(allIssues, enhanced) {
  console.log(JSON.stringify({ ok: allIssues.filter(i => i.level === 'error').length === 0, enhanced, issues: allIssues }, null, 2));
}

// ============================================================================
// Single-File Verify
// ============================================================================

async function verifySingleFile(resolvedPath, relPath) {
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let doc;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return {
      issues: [{ level: 'error', check: 'parse', message: `${relPath}: failed to parse OpenAPI: ${err.message}` }],
      operationIds: [],
      enhanced: false
    };
  }

  const endpoints = collectEndpoints(doc);
  if (endpoints.length === 0) return { issues: [], operationIds: [], enhanced: false };

  const issues = [
    ...checkRequiredFields(endpoints),
    ...checkUniqueOperationId(endpoints),
    ...checkSecurityRefs(doc, endpoints),
    ...checkPathParams(endpoints),
    ...checkRefResolution(doc),
  ];

  const enhanced = await tryEnhancedValidation(resolvedPath);
  if (enhanced.available) issues.push(...enhanced.issues);

  for (const issue of issues) {
    issue.message = `[${relPath}] ${issue.message}`;
  }

  const operationIds = endpoints
    .filter(e => e.op.operationId)
    .map(e => ({ id: e.op.operationId, loc: `${e.method.toUpperCase()} ${e.apiPath}`, file: relPath }));

  return { issues, operationIds, enhanced: enhanced.available };
}

// ============================================================================
// Main
// ============================================================================

async function cmdVerify(repoRoot, opts) {
  const strict = !!opts.strict;
  const format = (opts.format || 'text').toLowerCase();
  const source = opts.source;
  const discoverModulesFlag = opts.discoverModules;

  const filesToCheck = [];

  if (source) {
    const resolved = path.resolve(repoRoot, source);
    if (!fs.existsSync(resolved)) {
      console.log(`[skip] OpenAPI file not found: ${source}. Quality check skipped.`);
      process.exit(0);
    }
    filesToCheck.push({ relPath: source, absPath: resolved });
  } else if (discoverModulesFlag) {
    const moduleFiles = discoverModuleOpenApis(repoRoot);
    for (const m of moduleFiles) {
      filesToCheck.push({ relPath: m.path, absPath: m.absPath });
    }
    const projectOpenapi = path.resolve(repoRoot, 'docs/context/api/openapi.yaml');
    if (fs.existsSync(projectOpenapi)) {
      filesToCheck.push({ relPath: 'docs/context/api/openapi.yaml', absPath: projectOpenapi });
    }
    if (filesToCheck.length === 0) {
      console.log('[skip] No OpenAPI files found (no modules with OpenAPI, no project-level openapi.yaml). Quality check skipped.');
      process.exit(0);
    }
  } else {
    const modulesDir = path.join(repoRoot, 'modules');
    if (fs.existsSync(modulesDir)) {
      const moduleFiles = discoverModuleOpenApis(repoRoot);
      for (const m of moduleFiles) {
        filesToCheck.push({ relPath: m.path, absPath: m.absPath });
      }
    }
    const projectOpenapi = path.resolve(repoRoot, 'docs/context/api/openapi.yaml');
    if (fs.existsSync(projectOpenapi)) {
      filesToCheck.push({ relPath: 'docs/context/api/openapi.yaml', absPath: projectOpenapi });
    }
    if (filesToCheck.length === 0) {
      console.log('[skip] No OpenAPI files found. Quality check skipped.');
      process.exit(0);
    }
  }

  let allIssues = [];
  let enhanced = false;
  const allOperationIds = [];

  for (const file of filesToCheck) {
    const result = await verifySingleFile(file.absPath, file.relPath);
    allIssues.push(...result.issues);
    allOperationIds.push(...result.operationIds);
    enhanced = enhanced || !!result.enhanced;
  }

  if (filesToCheck.length > 1) {
    const crossFileIssues = checkCrossFileOperationIdUniqueness(allOperationIds);
    allIssues.push(...crossFileIssues);
  }

  if (format === 'json') {
    formatJson(allIssues, enhanced);
  } else {
    if (filesToCheck.length > 1) {
      console.log(`[info] Checked ${filesToCheck.length} OpenAPI files.`);
    }
    formatText(allIssues, enhanced);
  }

  const errors = allIssues.filter(i => i.level === 'error');
  const warnings = allIssues.filter(i => i.level === 'warning');
  const fail = errors.length > 0 || (strict && warnings.length > 0);
  process.exit(fail ? 1 : 0);
}

async function main() {
  const { command, opts } = parseArgs(process.argv);
  const repoRoot = path.resolve(opts['repo-root'] || process.cwd());

  switch (command) {
    case 'help':
      usage(0);
      break;
    case 'verify':
      await cmdVerify(repoRoot, opts);
      break;
    default:
      console.error(`[error] Unknown command: ${command}`);
      usage(1);
  }
}

main();
