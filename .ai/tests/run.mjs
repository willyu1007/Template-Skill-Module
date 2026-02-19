#!/usr/bin/env node
/**
 * run.mjs
 * Test suite runner
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { createEvidenceDir, createLogger, generateRunId, rmEvidenceDir, writeRunJson } from './lib/evidence.mjs';

import * as uiSuite from './suites/ui/index.mjs';
import * as envSuite from './suites/environment/index.mjs';
import * as dbSuite from './suites/database/index.mjs';
import * as contextSuite from './suites/context-awareness/index.mjs';
import * as deploySuite from './suites/deployment/index.mjs';
import * as modularSuite from './suites/modular-system/index.mjs';
import * as iacSuite from './suites/iac/index.mjs';
import * as apiIndexSuite from './suites/api-index/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..');

const SUITES = {
  ui: uiSuite,
  environment: envSuite,
  database: dbSuite,
  iac: iacSuite,
  'context-awareness': contextSuite,
  deployment: deploySuite,
  'modular-system': modularSuite,
  'api-index': apiIndexSuite,
};

function usage(exitCode) {
  const msg = [
    'Usage:',
    '  node .ai/tests/run.mjs --list',
    '  node .ai/tests/run.mjs --suite <ui|environment|database|iac|context-awareness|deployment|modular-system|api-index>',
    '',
    'Options:',
    '  --keep-artifacts     Keep evidence even on PASS (default: false)',
    '  --suite <name>       Run one suite',
    '  --list               List available suites',
  ].join('\n');
  process.stderr.write(msg + '\n');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { list: false, suite: null, keepArtifacts: false };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--keep-artifacts') out.keepArtifacts = true;
    else if (a === '--suite') out.suite = argv[i + 1] || null;
    else if (a === '-h' || a === '--help') usage(0);
  }

  if (process.env.KEEP_TEST_ARTIFACTS === '1') out.keepArtifacts = true;
  return out;
}

function listSuites() {
  process.stdout.write('Available suites:\n');
  for (const k of Object.keys(SUITES)) {
    process.stdout.write(`- ${k}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    listSuites();
    return 0;
  }

  if (!args.suite) usage(1);

  const suite = SUITES[args.suite];
  if (!suite) {
    process.stderr.write(`Unknown suite: ${args.suite}\n`);
    listSuites();
    return 1;
  }

  const runId = generateRunId();
  const evidenceDir = createEvidenceDir({ repoRoot, suite: args.suite, runId });
  const logger = createLogger(evidenceDir);

  const runJson = {
    suite: args.suite,
    run_id: runId,
    started_at_utc: new Date().toISOString(),
    status: 'UNKNOWN',
    keep_artifacts: Boolean(args.keepArtifacts),
    node: process.version,
  };

  let status = 'PASS';
  let results = [];
  let errorMessage = null;

  logger.log(`[tests] suite=${args.suite} run_id=${runId}`);

  try {
    results = suite.run({
      repoRoot,
      suite: args.suite,
      runId,
      evidenceDir,
      log: logger.log,
      error: logger.error,
      keepArtifacts: Boolean(args.keepArtifacts),
    });
  } catch (err) {
    status = 'FAIL';
    errorMessage = err && err.message ? err.message : String(err);
  }

  const anyFail = results.some((r) => r && r.status === 'FAIL');
  if (anyFail) status = 'FAIL';

  runJson.finished_at_utc = new Date().toISOString();
  runJson.status = status;
  runJson.results = results;
  if (errorMessage) runJson.error = errorMessage;

  writeRunJson(evidenceDir, runJson);

  if (status === 'PASS' && !args.keepArtifacts) {
    try {
      rmEvidenceDir(evidenceDir);
      logger.log('[tests] PASS (evidence cleaned)');
    } catch (e) {
      logger.error(`[tests] cleanup failed; keeping evidence: ${evidenceDir}`);
      logger.error(`[tests] cleanup error: ${e && e.message ? e.message : String(e)}`);
      logger.log('[tests] PASS');
    }
    return 0;
  }

  if (status === 'PASS') {
    logger.log(`[tests] PASS (evidence kept): ${evidenceDir}`);
    return 0;
  }

  logger.error(`[tests] FAIL (evidence kept): ${evidenceDir}`);
  if (errorMessage) logger.error(`[tests] error: ${errorMessage}`);
  return 1;
}

try {
  const rc = main();
  process.exitCode = rc;
} catch (e) {
  process.stderr.write(`Fatal error: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
}
