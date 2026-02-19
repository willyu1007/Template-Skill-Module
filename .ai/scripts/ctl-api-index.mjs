#!/usr/bin/env node
/**
 * ctl-api-index.mjs
 *
 * Generate, verify, and diff an LLM-friendly aggregated API Index
 * from per-module OpenAPI files in a module-first repository.
 *
 * Module discovery: scans modules/<id>/interact/registry.json for
 * artifacts with type "openapi", reads the corresponding OpenAPI file,
 * and merges all endpoints into a single aggregated index.
 *
 * Commands:
 *   generate   Read per-module OpenAPIs → produce aggregated api-index.json + API-INDEX.md
 *   verify     Check api-index.json freshness against module OpenAPI checksums
 *   diff       Show endpoints added/removed/changed since last generate
 *   help       Show help
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseYaml } from './lib/yaml.mjs';

// ============================================================================
// CLI
// ============================================================================

function usage(exitCode = 0) {
  const msg = `
Usage:
  node .ai/scripts/ctl-api-index.mjs <command> [options]

Commands:
  help
    Show this help.

  generate
    --repo-root <path>        Repo root (default: cwd)
    --module-id <id>          Only process this module (default: auto-discover all)
    --out-json <path>         JSON output  (default: docs/context/api/api-index.json)
    --out-md <path>           Markdown output (default: docs/context/api/API-INDEX.md)
    --touch                   Run ctl-context touch after generation
    --format <text|json>      Output format (default: text)
    --dry-run                 Show what would be written without writing

  verify
    --repo-root <path>        Repo root (default: cwd)
    --strict                  Exit with code 1 on mismatch
    --format <text|json>      Output format (default: text)

  diff
    --repo-root <path>        Repo root (default: cwd)
    --format <text|json>      Output format (default: text)

Notes:
- This script is safe to run in CI.
- It reads local OpenAPI files; it never makes network requests.
- Module discovery scans modules/*/interact/registry.json for type: openapi artifacts.
`;
  console.log(msg.trim());
  process.exit(exitCode);
}

function die(msg, exitCode = 1) {
  console.error(`[ctl-api-index] ERROR: ${msg}`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage(0);
  const command = args.shift();
  if (command === 'help') usage(0);
  const opts = {};
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
    }
  }
  return { command, opts };
}

// ============================================================================
// Utilities
// ============================================================================

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJson(p) {
  const raw = readFile(p);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function loadOpenApi(filePath) {
  const raw = readFile(filePath);
  if (raw == null) die(`Cannot read OpenAPI file: ${filePath}`);
  if (filePath.endsWith('.json')) {
    try { return { doc: JSON.parse(raw), raw }; } catch (e) { die(`Invalid JSON in ${filePath}: ${e.message}`); }
  }
  try { return { doc: parseYaml(raw), raw }; } catch (e) { die(`YAML parse error in ${filePath}: ${e.message}`); }
}

// ============================================================================
// Module Discovery
// ============================================================================

/**
 * Discover modules that have OpenAPI artifacts registered in their interact registry.
 * Returns array of { moduleId, openapiPath (repo-relative), registryPath }.
 */
function discoverModuleOpenApis(repoRoot, moduleFilter) {
  const modulesDir = path.join(repoRoot, 'modules');
  if (!fs.existsSync(modulesDir)) return [];

  const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleId = entry.name;
    if (moduleFilter && moduleId !== moduleFilter) continue;

    const registryPath = path.join(modulesDir, moduleId, 'interact', 'registry.json');
    const registry = readJson(registryPath);
    if (!registry || !Array.isArray(registry.artifacts)) continue;

    for (const artifact of registry.artifacts) {
      if (artifact.type !== 'openapi') continue;
      const openapiRelPath = artifact.path;
      if (!openapiRelPath) continue;
      const openapiAbs = path.isAbsolute(openapiRelPath)
        ? openapiRelPath
        : path.join(repoRoot, openapiRelPath);
      if (!fs.existsSync(openapiAbs)) continue;

      results.push({
        moduleId,
        openapiPath: openapiRelPath,
        openapiAbsPath: openapiAbs,
      });
    }
  }

  results.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  return results;
}

// ============================================================================
// OpenAPI Parsing Helpers
// ============================================================================

function resolveRef(doc, ref) {
  if (!ref || typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = doc;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return null;
    node = node[p];
  }
  return node ?? null;
}

function resolveSchema(doc, schemaOrRef) {
  if (!schemaOrRef || typeof schemaOrRef !== 'object') return null;
  if (schemaOrRef['$ref']) return resolveRef(doc, schemaOrRef['$ref']);
  return schemaOrRef;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

function extractFieldNames(doc, schema) {
  const resolved = resolveSchema(doc, schema);
  if (!resolved || typeof resolved !== 'object') return { required: [], optional: [] };

  if (resolved.allOf && Array.isArray(resolved.allOf)) {
    const merged = { required: [], optional: [] };
    for (const sub of resolved.allOf) {
      const r = extractFieldNames(doc, sub);
      merged.required.push(...r.required);
      merged.optional.push(...r.optional);
    }
    return merged;
  }

  const props = resolved.properties || {};
  const reqSet = new Set(Array.isArray(resolved.required) ? resolved.required : []);
  const required = [];
  const optional = [];
  for (const name of Object.keys(props)) {
    if (reqSet.has(name)) required.push(name);
    else optional.push(name);
  }
  return { required, optional };
}

function inferAuth(doc, security) {
  if (!security || !Array.isArray(security) || security.length === 0) return { type: 'none' };
  const hasAnonymous = security.some(e => e && typeof e === 'object' && Object.keys(e).length === 0);
  let schemeName = '';
  for (const entry of security) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = Object.keys(entry);
    if (keys.length > 0) { schemeName = keys[0]; break; }
  }
  if (!schemeName) return { type: 'none' };

  let result;
  const schemeDef = doc?.components?.securitySchemes?.[schemeName];
  if (schemeDef && typeof schemeDef === 'object') {
    const t = schemeDef.type;
    if (t === 'http') {
      const scheme = (schemeDef.scheme || '').toLowerCase();
      result = { type: scheme === 'bearer' ? 'bearer' : scheme === 'basic' ? 'basic' : (scheme || 'http') };
    } else if (t === 'apiKey') {
      result = { type: 'apiKey', in: schemeDef.in || 'header', name: schemeDef.name || 'X-API-Key' };
    } else if (t === 'oauth2') {
      result = { type: 'oauth2' };
    } else if (t === 'openIdConnect') {
      result = { type: 'openIdConnect' };
    } else {
      result = { type: t || schemeName };
    }
  } else if (/bearer/i.test(schemeName)) {
    result = { type: 'bearer' };
  } else if (/api.?key/i.test(schemeName)) {
    result = { type: 'apiKey', in: 'header', name: 'X-API-Key' };
  } else if (/oauth/i.test(schemeName)) {
    result = { type: 'oauth2' };
  } else if (/basic/i.test(schemeName)) {
    result = { type: 'basic' };
  } else {
    result = { type: schemeName };
  }

  if (hasAnonymous) result.optional = true;
  return result;
}

function findSuccessResponse(responses) {
  if (!responses || typeof responses !== 'object') return { status: 200, schema: null };
  for (const code of ['200', '201', '202', '204']) {
    if (responses[code]) {
      const body = responses[code];
      const schema = body?.content?.['application/json']?.schema ?? null;
      return { status: Number(code), schema };
    }
  }
  return { status: 200, schema: null };
}

function collectErrorCodes(responses) {
  if (!responses || typeof responses !== 'object') return [];
  return Object.keys(responses)
    .filter(c => /^[45]\d{2}$/.test(c))
    .map(Number)
    .sort((a, b) => a - b);
}

function buildRequestBodyInfo(doc, operation) {
  const rb = operation.requestBody;
  if (!rb) return null;
  const jsonContent = rb?.content?.['application/json'] ?? rb?.content?.['application/x-www-form-urlencoded'];
  if (!jsonContent?.schema) return { required: [], optional: [] };
  return extractFieldNames(doc, jsonContent.schema);
}

function buildParams(pathItem, operation) {
  const pathLevel = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
  const opLevel = Array.isArray(operation.parameters) ? operation.parameters : [];
  const merged = new Map();
  for (const p of pathLevel) { if (p?.name) merged.set(`${p.in}:${p.name}`, p); }
  for (const p of opLevel) { if (p?.name) merged.set(`${p.in}:${p.name}`, p); }
  const pathParams = [];
  const queryParams = [];
  for (const p of merged.values()) {
    if (p.in === 'path') pathParams.push(p.name);
    else if (p.in === 'query') queryParams.push(p.name);
  }
  return { path: pathParams, query: queryParams };
}

function buildCurlExample(method, apiPath, authInfo, bodyFields) {
  let urlPath = apiPath;
  const authType = authInfo.type;
  if (authType === 'apiKey' && (authInfo.in || 'header') === 'query') {
    const sep = urlPath.includes('?') ? '&' : '?';
    urlPath = `${urlPath}${sep}${authInfo.name || 'api_key'}=<api-key>`;
  }
  const parts = [`curl -X ${method.toUpperCase()} '${urlPath}'`];
  if (authType === 'bearer' || authType === 'oauth2' || authType === 'openIdConnect') {
    parts.push("-H 'Authorization: Bearer <token>'");
  } else if (authType === 'basic') {
    parts.push("-H 'Authorization: Basic <credentials>'");
  } else if (authType === 'apiKey') {
    const loc = authInfo.in || 'header';
    const paramName = authInfo.name || 'X-API-Key';
    if (loc === 'header') {
      parts.push(`-H '${paramName}: <api-key>'`);
    } else if (loc === 'cookie') {
      parts.push(`-H 'Cookie: ${paramName}=<api-key>'`);
    }
  } else if (authType && authType !== 'none' && authType !== 'unknown') {
    parts.push(`-H 'Authorization: <${authType}>'`);
  }
  if (bodyFields && bodyFields.required.length > 0) {
    parts.push("-H 'Content-Type: application/json'");
    const body = {};
    for (const f of bodyFields.required) body[f] = `<${f}>`;
    parts.push(`-d '${JSON.stringify(body)}'`);
  }
  return parts.join(' ');
}

// ============================================================================
// Index Generation (single module)
// ============================================================================

function generateModuleEndpoints(doc, moduleId) {
  const paths = doc.paths || {};
  const globalSecurity = doc.security ?? null;
  const endpoints = [];

  for (const [apiPath, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;

      const security = op.security ?? globalSecurity;
      const authInfo = inferAuth(doc, security);
      const params = buildParams(methods, op);
      const bodyInfo = buildRequestBodyInfo(doc, op);
      const successResp = findSuccessResponse(op.responses);
      const outputFields = extractFieldNames(doc, successResp.schema);
      const errors = collectErrorCodes(op.responses);

      endpoints.push({
        moduleId,
        method: method.toUpperCase(),
        path: apiPath,
        operationId: op.operationId || '',
        summary: op.summary || '',
        tag: Array.isArray(op.tags) && op.tags.length > 0 ? op.tags[0] : '',
        auth: authInfo.optional ? `${authInfo.type} (optional)` : authInfo.type,
        input: {
          params: params.path,
          query: params.query,
          body: bodyInfo,
        },
        output: {
          successStatus: successResp.status,
          coreFields: [...outputFields.required, ...outputFields.optional],
        },
        errors,
        example: {
          curl: buildCurlExample(method, apiPath, authInfo, bodyInfo),
        },
      });
    }
  }

  return endpoints;
}

// ============================================================================
// Aggregated Index Generation
// ============================================================================

function generateAggregatedIndex(repoRoot, moduleFilter) {
  const moduleSources = discoverModuleOpenApis(repoRoot, moduleFilter);

  if (moduleSources.length === 0) {
    return {
      version: 1,
      generatedAt: '',
      sources: [],
      stats: { totalEndpoints: 0, totalModules: 0, byModule: {}, byTag: {} },
      endpoints: [],
    };
  }

  const allEndpoints = [];
  const sources = [];

  for (const src of moduleSources) {
    const { doc, raw } = loadOpenApi(src.openapiAbsPath);
    const checksum = sha256(raw);
    const endpoints = generateModuleEndpoints(doc, src.moduleId);

    sources.push({
      moduleId: src.moduleId,
      openapiPath: src.openapiPath,
      checksumSha256: checksum,
    });

    allEndpoints.push(...endpoints);
  }

  const byModule = {};
  const byTag = {};
  for (const ep of allEndpoints) {
    byModule[ep.moduleId] = (byModule[ep.moduleId] || 0) + 1;
    const t = ep.tag || '_untagged';
    byTag[t] = (byTag[t] || 0) + 1;
  }

  return {
    version: 1,
    generatedAt: '',
    sources,
    stats: {
      totalEndpoints: allEndpoints.length,
      totalModules: sources.length,
      byModule,
      byTag,
    },
    endpoints: allEndpoints,
  };
}

function stableStringify(index) {
  const copy = { ...index, generatedAt: '__STABLE__' };
  return JSON.stringify(copy, null, 2);
}

function escMdCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function generateMarkdown(index) {
  const moduleIds = index.sources.map(s => s.moduleId);
  const lines = [
    '# API Index',
    '',
    `> Auto-generated at ${index.generatedAt} — do NOT hand-edit.`,
    `> Sources: ${index.stats.totalModules} module(s) (${moduleIds.join(', ')})`,
    '',
    `Total endpoints: **${index.stats.totalEndpoints}** across **${index.stats.totalModules}** module(s)`,
    '',
  ];

  const grouped = new Map();
  for (const ep of index.endpoints) {
    if (!grouped.has(ep.moduleId)) grouped.set(ep.moduleId, []);
    grouped.get(ep.moduleId).push(ep);
  }

  for (const [modId, endpoints] of grouped) {
    lines.push(`## ${modId} (${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''})`);
    lines.push('');
    lines.push('| Method | Path | Summary | Auth | Input (required) | Output (core) | Errors |');
    lines.push('|--------|------|---------|------|------------------|---------------|--------|');

    for (const ep of endpoints) {
      const inputReq = escMdCell(ep.input.body?.required?.join(', ') || ep.input.params?.join(', ') || '—');
      const outputCore = escMdCell(ep.output.coreFields?.join(', ') || '—');
      const errors = ep.errors.length > 0 ? ep.errors.join(', ') : '—';
      lines.push(
        `| ${ep.method} | ${escMdCell(ep.path)} | ${escMdCell(ep.summary || '—')} | ${ep.auth} | ${inputReq} | ${outputCore} | ${errors} |`
      );
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Commands
// ============================================================================

function cmdGenerate(opts) {
  const repoRoot = path.resolve(opts['repo-root'] || '.');
  const moduleFilter = opts['module-id'] || null;
  const outJsonRel = opts['out-json'] || 'docs/context/api/api-index.json';
  const outMdRel = opts['out-md'] || 'docs/context/api/API-INDEX.md';
  const outJsonAbs = path.isAbsolute(outJsonRel) ? outJsonRel : path.join(repoRoot, outJsonRel);
  const outMdAbs = path.isAbsolute(outMdRel) ? outMdRel : path.join(repoRoot, outMdRel);
  const fmt = opts.format || 'text';
  const dryRun = !!opts['dry-run'];
  const touch = !!opts.touch;

  const index = generateAggregatedIndex(repoRoot, moduleFilter);

  const existing = readJson(outJsonAbs);
  const contentChanged = !existing || stableStringify(index) !== stableStringify(existing);
  index.generatedAt = contentChanged
    ? new Date().toISOString()
    : (existing?.generatedAt || new Date().toISOString());

  const md = generateMarkdown(index);
  const jsonStr = JSON.stringify(index, null, 2) + '\n';

  if (dryRun) {
    if (fmt === 'json') {
      console.log(JSON.stringify({
        dryRun: true, outJson: outJsonRel, outMd: outMdRel,
        modules: index.stats.totalModules,
        endpoints: index.stats.totalEndpoints,
        contentChanged,
      }));
    } else {
      console.log(`[dry-run] Would write ${outJsonRel} (${index.stats.totalModules} modules, ${index.stats.totalEndpoints} endpoints, ${contentChanged ? 'changed' : 'unchanged'})`);
      console.log(`[dry-run] Would write ${outMdRel}`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(outJsonAbs), { recursive: true });
  fs.mkdirSync(path.dirname(outMdAbs), { recursive: true });
  fs.writeFileSync(outJsonAbs, jsonStr, 'utf8');
  fs.writeFileSync(outMdAbs, md, 'utf8');

  if (fmt === 'json') {
    console.log(JSON.stringify({
      ok: true, outJson: outJsonRel, outMd: outMdRel,
      modules: index.stats.totalModules,
      endpoints: index.stats.totalEndpoints,
    }));
  } else {
    console.log(`[ok] Generated ${outJsonRel} (${index.stats.totalModules} modules, ${index.stats.totalEndpoints} endpoints)`);
    console.log(`[ok] Generated ${outMdRel}`);
    for (const src of index.sources) {
      console.log(`     ${src.moduleId}: ${src.checksumSha256.slice(0, 16)}...`);
    }
  }

  if (touch) {
    const ctlContext = path.join(repoRoot, '.ai', 'skills', 'features', 'context-awareness', 'scripts', 'ctl-context.mjs');
    if (fs.existsSync(ctlContext)) {
      const r = spawnSync('node', [ctlContext, 'touch', '--repo-root', repoRoot], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) {
        if (fmt === 'text') console.log('[ok] ctl-context touch completed');
      } else {
        if (fmt === 'text') console.error(`[warn] ctl-context touch failed (exit ${r.status})`);
      }
    } else {
      if (fmt === 'text') console.log('[skip] ctl-context.mjs not found; skipping touch');
    }
  }
}

function cmdVerify(opts) {
  const repoRoot = path.resolve(opts['repo-root'] || '.');
  const outJsonRel = opts.index || 'docs/context/api/api-index.json';
  const outJsonAbs = path.isAbsolute(outJsonRel) ? outJsonRel : path.join(repoRoot, outJsonRel);
  const fmt = opts.format || 'text';
  const strict = !!opts.strict;

  const indexData = readJson(outJsonAbs);
  if (indexData == null) {
    if (strict) die(`API Index not found: ${outJsonAbs}`);
    if (fmt === 'json') console.log(JSON.stringify({ ok: false, reason: 'index-missing' }));
    else console.log('[warn] API Index file not found');
    return;
  }

  const storedSources = indexData.sources || [];

  const mismatches = [];
  const missing = [];

  for (const src of storedSources) {
    const absPath = path.isAbsolute(src.openapiPath)
      ? src.openapiPath
      : path.join(repoRoot, src.openapiPath);
    const raw = readFile(absPath);
    if (raw == null) {
      missing.push(src.moduleId);
      continue;
    }
    const currentChecksum = sha256(raw);
    if (currentChecksum !== src.checksumSha256) {
      mismatches.push({ moduleId: src.moduleId, stored: src.checksumSha256, current: currentChecksum });
    }
  }

  const currentModules = discoverModuleOpenApis(repoRoot);
  const storedModuleIds = new Set(storedSources.map(s => s.moduleId));
  const newModules = currentModules.filter(m => !storedModuleIds.has(m.moduleId));

  const ok = mismatches.length === 0 && missing.length === 0 && newModules.length === 0;

  if (fmt === 'json') {
    console.log(JSON.stringify({ ok, mismatches, missing, newModules: newModules.map(m => m.moduleId) }));
  } else {
    if (ok) {
      console.log(`[ok] API Index is up-to-date (${storedSources.length} modules)`);
    } else {
      if (mismatches.length > 0) {
        console.log('[mismatch] Stale module checksums:');
        for (const m of mismatches) console.log(`  ${m.moduleId}: stored ${m.stored.slice(0, 12)}... vs current ${m.current.slice(0, 12)}...`);
      }
      if (missing.length > 0) {
        console.log('[missing] OpenAPI files not found:');
        for (const id of missing) console.log(`  ${id}`);
      }
      if (newModules.length > 0) {
        console.log('[new] Modules with OpenAPI not in index:');
        for (const m of newModules) console.log(`  ${m.moduleId}`);
      }
      console.log('Run: node .ai/scripts/ctl-api-index.mjs generate --touch');
    }
  }

  if (strict && !ok) process.exit(1);
}

function cmdDiff(opts) {
  const repoRoot = path.resolve(opts['repo-root'] || '.');
  const outJsonRel = opts.index || 'docs/context/api/api-index.json';
  const outJsonAbs = path.isAbsolute(outJsonRel) ? outJsonRel : path.join(repoRoot, outJsonRel);
  const fmt = opts.format || 'text';

  const newIndex = generateAggregatedIndex(repoRoot);
  const oldIndex = readJson(outJsonAbs);

  if (!oldIndex) {
    if (fmt === 'json') {
      console.log(JSON.stringify({
        added: newIndex.endpoints.map(e => `[${e.moduleId}] ${e.method} ${e.path}`),
        removed: [],
        changed: [],
      }));
    } else {
      console.log('[info] No existing index — all endpoints are new:');
      for (const ep of newIndex.endpoints) console.log(`  + [${ep.moduleId}] ${ep.method} ${ep.path}`);
    }
    return;
  }

  const epKey = e => `[${e.moduleId}] ${e.method} ${e.path}`;
  const oldMap = new Map((oldIndex.endpoints || []).map(e => [epKey(e), e]));
  const newMap = new Map(newIndex.endpoints.map(e => [epKey(e), e]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, ep] of newMap) {
    if (!oldMap.has(key)) { added.push(key); continue; }
    const old = oldMap.get(key);
    if (old.operationId !== ep.operationId || old.summary !== ep.summary ||
        old.tag !== ep.tag || old.auth !== ep.auth ||
        JSON.stringify(old.input) !== JSON.stringify(ep.input) ||
        JSON.stringify(old.output) !== JSON.stringify(ep.output) ||
        JSON.stringify(old.errors) !== JSON.stringify(ep.errors) ||
        JSON.stringify(old.example) !== JSON.stringify(ep.example)) {
      changed.push(key);
    }
  }
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) removed.push(key);
  }

  if (fmt === 'json') {
    console.log(JSON.stringify({ added, removed, changed }));
  } else {
    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      console.log('[ok] No endpoint changes detected');
      return;
    }
    for (const k of added) console.log(`  + ${k}`);
    for (const k of removed) console.log(`  - ${k}`);
    for (const k of changed) console.log(`  ~ ${k}`);
    console.log(`\nSummary: ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  }
}

// ============================================================================
// Main
// ============================================================================

const { command, opts } = parseArgs(process.argv);

switch (command) {
  case 'generate': cmdGenerate(opts); break;
  case 'verify':   cmdVerify(opts);   break;
  case 'diff':     cmdDiff(opts);     break;
  default:         die(`Unknown command: ${command}. Run with --help.`);
}
