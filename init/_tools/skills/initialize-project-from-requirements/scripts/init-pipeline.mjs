#!/usr/bin/env node
/**
 * init-pipeline.mjs
 *
 * Dependency-free helper for a 3-stage, verifiable init pipeline:
 *
 *   Stage A: requirements docs under `init/_work/stage-a-docs/`
 *   Stage B: blueprint JSON at `init/_work/project-blueprint.json`
 *   Stage C: minimal scaffold + skill pack manifest update + wrapper sync
 *
 * Commands:
 *   - start          Initialize state file and show next steps
 *   - status         Show current initialization progress
 *   - advance        Print the next checkpoint actions for the current stage
 *   - approve        Record explicit user approval and advance to the next stage
 *   - validate       Validate a blueprint JSON (no writes)
 *   - check-docs     Validate Stage A docs (structure + template placeholders)
 *   - mark-must-ask  Update Stage A must-ask checklist state
 *   - review-packs   Mark Stage B packs review as completed
 *   - review-skill-retention Mark Stage C skill retention review as completed
 *   - suggest-packs  Recommend skill packs from blueprint capabilities (warn-only by default)
 *   - suggest-features Recommend features from blueprint capabilities
 *   - scaffold       Plan or apply a minimal directory scaffold from the blueprint
 *   - apply          validate + (optional) check-docs + scaffold + configs + pack enable + wrapper sync
 *   - cleanup-init   Remove the `init/` bootstrap kit (opt-in, guarded)
 *
 * This script is intentionally framework-agnostic. It avoids generating code.
 *
 * ============================================================================
 * CODE STRUCTURE (by functional module)
 * ============================================================================
 *
 * ## 1. Core Infrastructure (lines 115-260)
 *    - Imports and constants ............................ 115-130
 *    - setOutputFormat, childProcessStdio .............. 131-152
 *    - Path resolution (getInitRoot, resolveInitPaths) . 154-260
 *    - usage() ......................................... 262-380
 *
 * ## 2. Utilities (lines 381-495)
 *    - die(), parseArgs() .............................. 381-412
 *    - resolvePath, readJson, writeJson ................ 413-436
 *    - Interactive prompts (readLineSync, promptYesNoSync) 437-480
 *    - ensurePathWithinRepo, removeDirRecursive ........ 473-495
 *
 * ## 3. State Management (lines 497-630)
 *    - getStatePath, createInitialState ................ 497-545
 *    - loadState, saveState ............................ 546-573
 *    - addHistoryEvent ................................. 565-573
 *    - Must-ask checklist (isMustAskItemComplete, getMissingMustAskKeys) 574-590
 *    - getStageProgress ................................ 591-630
 *
 * ## 4. Status & Board Rendering
 *    - printStatus()
 *    - writeTextIfChanged
 *    - normalizeOutputLanguage, readOutputLanguage
 *    - upsertTextBetweenMarkers, renderInitBoardMachineSnapshot
 *    - syncInitBoard()
 *
 * ## 5. Config & Pack Management (lines 1302-1625)
 *    - generateConfigFiles (import from scaffold-configs.mjs) 1302-1305
 *    - packPrefixMap, packOrder, normalizePackList ..... 1306-1338
 *    - validateBlueprint() ............................. 1340-1512
 *    - featureFlags, isContextAwarenessEnabled ......... 1513-1537
 *    - recommendedPacksFromBlueprint ................... 1539-1555
 *    - recommendedFeaturesFromBlueprint ................ 1556-1593
 *    - checkPackInstall, printResult ................... 1594-1625
 *
 * ## 6. Stage A: Docs Validation (lines 1626-1761)
 *    - checkDocs() ..................................... 1626-1715
 *    - ensureDir, writeFileIfMissing ................... 1716-1742
 *    - ensureStartHere, ensureWorkAgents ............... 1731-1762
 *
 * ## 7. README & AGENTS.md Generation (lines 1763-2495)
 *    - generateProjectReadme() ......................... 1763-1888
 *    - copyFileIfMissing, listFilesRecursive ........... 1889-1920
 *    - copyDirIfMissing ................................ 1921-1959
 *    - runNodeScript, runNodeScriptWithRepoRootFallback  1981-2013
 *    - DB SSOT handling (getContextMode, dbSsotMode) ... 2015-2089
 *    - renderDbSsotAgentsBlock ......................... 2090-2160
 *    - patchRootAgentsDbSsot ........................... 2161-2204
 *    - Markdown helpers (normalizeMarkdownNewlines, etc) 2205-2263
 *    - patchRootAgentsProjectInfo ...................... 2335-2474
 *    - applyDbSsotSkillExclusions ...................... 2475-2523
 *    - CI provider handling ............................ 2496-2593
 *
 * ## 8. Feature Materialization (lines 2594-3122)
 *    - refreshDbContextContract ........................ 2594-2657
 *    - Feature enable checks (isDatabaseEnabled, etc) .. 2658-2702
 *    - findFeatureCtlScript ............................ 2704-2722
 *    - ensureFeature() ................................. 2723-2796
 *    - markProjectFeature .............................. 2797-2809
 *    - runPythonScript ................................. 2810-2826
 *    - ensureDatabaseFeature ........................... 2827-2897
 *    - ensureUiFeature ................................. 2898-2941
 *    - ensureEnvironmentFeature ........................ 2942-2986
 *    - ensureCiFeature ................................. 2987-3030
 *    - ensureContextAwarenessFeature ................... 3031-3122
 *
 * ## 9. Scaffold & Apply (lines 3123-3538)
 *    - planScaffold() .................................. 3123-3356
 *    - updateManifest() ................................ 3357-3452
 *    - syncWrappers() .................................. 3453-3470
 *    - runModularCoreBuild() ........................... 3471-3508
 *    - cleanupInit() ................................... 3509-3539
 *
 * ## 10. Main Entry Point (lines 3540-EOF)
 *    - main() .......................................... 3540-EOF
 *    - Command dispatch (start, status, advance, approve, etc)
 *
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import { fileURLToPath } from 'url';
import util from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INIT_DIRNAME = 'init';
const INIT_WORK_DIRNAME = '_work';
const INIT_KIT_MARKER_BASENAME = '.init-kit';
const INIT_KIT_MARKER_RELPATH = path.join('_tools', INIT_KIT_MARKER_BASENAME);

let OUTPUT_FORMAT = 'text';

function setOutputFormat(format) {
  OUTPUT_FORMAT = String(format || 'text').toLowerCase();
}

function childProcessStdio() {
  // When emitting machine-readable JSON, keep stdout clean.
  // Route child process output to stderr so `--format json` is parseable.
  return OUTPUT_FORMAT === 'json' ? ['inherit', 2, 2] : 'inherit';
}

function redirectConsoleToStderr() {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const write = (...args) => process.stderr.write(util.format(...args) + '\n');
  console.log = write;
  console.warn = write;
  console.error = write;
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

function getInitRoot(repoRoot) {
  return path.join(repoRoot, INIT_DIRNAME);
}

function getInitWorkRoot(repoRoot) {
  return path.join(getInitRoot(repoRoot), INIT_WORK_DIRNAME);
}

function getInitKitMarkerCandidates(repoRoot) {
  const initRoot = getInitRoot(repoRoot);
  // Marker lives under init/_tools/
  return [path.join(initRoot, INIT_KIT_MARKER_RELPATH)];
}

function findInitKitMarker(repoRoot) {
  for (const p of getInitKitMarkerCandidates(repoRoot)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveInitPaths(repoRoot) {
  const initRoot = getInitRoot(repoRoot);
  const workRoot = getInitWorkRoot(repoRoot);
  const mode = 'work';
  const root = workRoot;

  return {
    mode,
    initRoot,
    workRoot,
    root,
    statePath: path.join(root, '.init-state.json'),
    docsRoot: path.join(root, 'stage-a-docs'),
    blueprintPath: path.join(root, 'project-blueprint.json'),
    skillRetentionPath: path.join(root, 'skill-retention-table.template.md')
  };
}

function usage(exitCode = 0) {
  const msg = `
Usage:
  node init/_tools/skills/initialize-project-from-requirements/scripts/init-pipeline.mjs <command> [options]

Commands:
  start
    --repo-root <path>          Repo root (default: cwd)
    Initialize state file and show next steps.

  status
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)
    Show current initialization progress.

  advance
    --repo-root <path>          Repo root (default: cwd)
    Print the next checkpoint actions for the current stage.

  approve
    --repo-root <path>          Repo root (default: cwd)
    --stage <A|B|C>             Stage to approve (default: current state.stage)
    --note <text>               Optional audit note
    --skip-must-ask             Allow Stage A approval without must-ask completion
    --skip-agents-update        Allow Stage C approval without AGENTS.md update
    Record explicit user approval and advance state to the next stage.

  validate
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)

  check-docs
    --docs-root <path>          Stage A docs root (default: <repo-root>/init/_work/stage-a-docs)
    --repo-root <path>          Repo root (default: cwd)
    --strict                    Treat warnings as errors (exit non-zero)
    --format <text|json>        Output format (default: text)

  mark-must-ask
    --key <id>                  Must-ask key (required)
    --asked                     Mark as asked
    --answered                  Mark as answered
    --written-to <path>         Record where the answer was written
    --repo-root <path>          Repo root (default: cwd)

  review-packs
    --repo-root <path>          Repo root (default: cwd)
    --note <text>               Optional audit note

  review-skill-retention
    --repo-root <path>          Repo root (default: cwd)
    --note <text>               Optional audit note

  suggest-packs
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)
    --write                     Add missing recommended packs into blueprint (safe-add only)

  suggest-features
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --format <text|json>        Output format (default: text)
    --write                     Add missing recommended features into blueprint (safe-add only)

  scaffold
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --apply                     Actually create directories/files (default: dry-run)

  apply
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --providers <both|codex|claude|codex,claude>
    --force                     Allow running apply outside Stage C (requires --i-understand)
    --require-stage-a           Refuse apply if Stage A docs invalid
    --skip-configs              Do not generate config files
    --i-understand              Required acknowledgement when using --force

    Feature install controls:
    --force-features            Overwrite existing feature files when materializing templates
    --verify-features           Run feature verify commands after installation (when available)
    --blocking-features         Fail-fast on feature errors (default: non-blocking)

    Modular system controls:
    --skip-modular              Skip modular core build (not recommended)
    --blocking-modular          Fail-fast on modular core build errors (default: non-blocking)

    --format <text|json>        Output format (default: text)

  update-agents
    --blueprint <path>          Blueprint JSON path (default: init/_work/project-blueprint.json)
    --repo-root <path>          Repo root (default: cwd)
    --apply                     Write changes (default: dry-run)
    --format <text|json>        Output format (default: text)

  cleanup-init
    --repo-root <path>          Repo root (default: cwd)
    --apply                     Actually remove init/ (default: dry-run)
    --i-understand              Required acknowledgement (refuses without it)
    --force                     Allow cleanup before init completion (requires --i-understand)
    --archive                   Archive all (Stage A docs + blueprint) to docs/project/overview/
    --archive-docs              Archive Stage A docs only to docs/project/overview/
    --archive-blueprint         Archive blueprint only to docs/project/overview/project-blueprint.json

Examples:
  node .../init-pipeline.mjs start
  node .../init-pipeline.mjs status
  node .../init-pipeline.mjs check-docs --strict
  node .../init-pipeline.mjs validate
  node .../init-pipeline.mjs apply --providers both
  node .../init-pipeline.mjs cleanup-init --apply --i-understand --archive
  node .../init-pipeline.mjs approve --stage A
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
  if (args.length === 0 || args[0] === 'help' || args[0] === '-h' || args[0] === '--help') usage(0);

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

function resolvePath(base, p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

function stripUtf8Bom(raw) {
  const s = String(raw ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJson(filePath) {
  try {
    const raw = stripUtf8Bom(fs.readFileSync(filePath, 'utf8'));
    return JSON.parse(raw);
  } catch (e) {
    die(`[error] Failed to read JSON: ${filePath}\n${e.message}`);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function readLineSync(prompt) {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1);
  let line = '';
  while (true) {
    let bytes = 0;
    try {
      bytes = fs.readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (bytes === 0) break;
    const ch = buf.toString('utf8', 0, bytes);
    if (ch === '\n') break;
    if (ch === '\r') continue;
    line += ch;
  }
  return line.trim();
}

function promptYesNoSync(question, defaultYes) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  for (let i = 0; i < 3; i += 1) {
    const ans = readLineSync(`${question}${suffix}`).toLowerCase();
    if (!ans) return defaultYes;
    if (ans === 'y' || ans === 'yes') return true;
    if (ans === 'n' || ans === 'no') return false;
    console.log('[info] Please answer: y/yes or n/no.');
  }
  return defaultYes;
}

function ensurePathWithinRepo(repoRoot, targetPath, label) {
  const rr = path.resolve(repoRoot);
  const tp = path.resolve(targetPath);
  if (tp === rr || !tp.startsWith(rr + path.sep)) {
    die(`[error] Refusing to operate outside repo root for ${label}: ${tp}`);
  }
}

function removeDirRecursive(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// State Management
// ============================================================================

const SCRIPT_DIR = __dirname;
const TEMPLATES_DIR = path.join(SCRIPT_DIR, '..', 'templates');

function getStatePath(repoRoot) {
  return resolveInitPaths(repoRoot).statePath;
}

function createInitialState() {
  return {
    version: 1,
    stage: 'A',
    createdAt: new Date().toISOString(),
    outputLanguage: null,
    'stage-a': {
      mustAsk: {
        terminologyAlignment: { asked: false, answered: false, writtenTo: null },
        onePurpose: { asked: false, answered: false, writtenTo: null },
        userRoles: { asked: false, answered: false, writtenTo: null },
        mustRequirements: { asked: false, answered: false, writtenTo: null },
        outOfScope: { asked: false, answered: false, writtenTo: null },
        userJourneys: { asked: false, answered: false, writtenTo: null },
        constraints: { asked: false, answered: false, writtenTo: null },
        successMetrics: { asked: false, answered: false, writtenTo: null }
      },
      docsWritten: {
        requirements: false,
        nfr: false,
        glossary: false,
        riskQuestions: false
      },
      validated: false,
      userApproved: false
    },
    'stage-b': {
      drafted: false,
      validated: false,
      packsReviewed: false,
      userApproved: false
    },
    'stage-c': {
      scaffoldApplied: false,
      configsGenerated: false,
      manifestUpdated: false,
      wrappersSynced: false,
      skillRetentionReviewed: false,
      agentsUpdated: false,
      modularBuilt: false,
      userApproved: false
    },
    history: []
  };
}

function loadState(repoRoot) {
  const statePath = getStatePath(repoRoot);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(stripUtf8Bom(fs.readFileSync(statePath, 'utf8')));
  } catch (e) {
    console.error(`[warn] Failed to parse state file: ${e.message}`);
    return null;
  }
}

function saveState(repoRoot, state) {
  const statePath = getStatePath(repoRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function addHistoryEvent(state, event, details) {
  state.history = state.history || [];
  state.history.push({
    timestamp: new Date().toISOString(),
    event,
    details
  });
}

function isMustAskItemComplete(item) {
  const asked = !!item?.asked;
  const answered = !!item?.answered;
  const writtenTo = String(item?.writtenTo || '').trim();
  return asked && answered && writtenTo.length > 0;
}

function getMissingMustAskKeys(stageAState) {
  const mustAsk = (stageAState && stageAState.mustAsk) || {};
  const missing = [];
  for (const key of Object.keys(mustAsk)) {
    const item = mustAsk[key] || {};
    if (!isMustAskItemComplete(item)) missing.push(key);
  }
  return missing;
}

function getStageProgress(state) {
  const stage_a = state['stage-a'] || {};
  const stage_b = state['stage-b'] || {};
  const stage_c = state['stage-c'] || {};

  const mustAskKeys = Object.keys(stage_a.mustAsk || {});
  const mustAskAnswered = mustAskKeys.filter((k) => stage_a.mustAsk[k]?.answered).length;
  const mustAskCompleted = mustAskKeys.filter((k) => isMustAskItemComplete(stage_a.mustAsk[k] || {})).length;

  const docsKeys = ['requirements', 'nfr', 'glossary', 'riskQuestions'];
  const docsWritten = docsKeys.filter(k => stage_a.docsWritten?.[k]).length;

  return {
    stage: state.stage,
    'stage-a': {
      mustAskTotal: mustAskKeys.length,
      mustAskCompleted,
      mustAskAnswered,
      docsTotal: docsKeys.length,
      docsWritten,
      validated: !!stage_a.validated,
      userApproved: !!stage_a.userApproved
    },
    'stage-b': {
      drafted: !!stage_b.drafted,
      validated: !!stage_b.validated,
      packsReviewed: !!stage_b.packsReviewed,
      userApproved: !!stage_b.userApproved
    },
    'stage-c': {
      scaffoldApplied: !!stage_c.scaffoldApplied,
      configsGenerated: !!stage_c.configsGenerated,
      manifestUpdated: !!stage_c.manifestUpdated,
      wrappersSynced: !!stage_c.wrappersSynced,
      modularBuilt: !!stage_c.modularBuilt,
      skillRetentionReviewed: !!stage_c.skillRetentionReviewed,
      agentsUpdated: !!stage_c.agentsUpdated,
      userApproved: !!stage_c.userApproved
    }
  };
}

function printStatus(state, repoRoot) {
  const initPaths = resolveInitPaths(repoRoot);
  const docsRel = path.relative(repoRoot, initPaths.docsRoot);
  const bpRel = path.relative(repoRoot, initPaths.blueprintPath);
  const retentionRel = path.relative(repoRoot, initPaths.skillRetentionPath);
  const stateRel = path.relative(repoRoot, initPaths.statePath);
  const self = path.relative(repoRoot, __filename) || 'init-pipeline.mjs';

  const progress = getStageProgress(state);
  const stageNames = { A: 'Requirements', B: 'Blueprint', C: 'Scaffold', complete: 'Complete' };
  const stage_a = progress['stage-a'] || {};
  const stage_b = progress['stage-b'] || {};
  const stage_c = progress['stage-c'] || {};

  const outputLanguage = normalizeOutputLanguage(state?.outputLanguage);
  const yn = (value) => (value ? 'yes' : 'no');

  console.log('');
  console.log('== Init Status ==');
  console.log(`Stage: ${progress.stage} (${stageNames[progress.stage] || progress.stage})`);
  console.log(`State: ${stateRel}`);
  console.log(`Docs: ${docsRel}/`);
  console.log(`Blueprint: ${bpRel}`);
  console.log(`Output language: ${outputLanguage || '(not set)'}`);

  if (!outputLanguage) {
    console.log('Entry docs: pending (init/START-HERE.md and init/INIT-BOARD.md are created only after outputLanguage is set)');
    console.log(`Set: ${stateRel} -> outputLanguage (LLM may edit ONLY this field; do not change stages/flags by hand)`);
  } else {
    console.log('Entry docs: enabled (init/START-HERE.md and init/INIT-BOARD.md)');
  }

  if (progress.stage === 'A' || progress.stage === 'B' || progress.stage === 'C') {
    console.log('');
    console.log('Stage A');
    console.log(`- Must-ask checklist: ${stage_a.mustAskCompleted}/${stage_a.mustAskTotal} complete`);
    console.log(`- Docs written: ${stage_a.docsWritten}/${stage_a.docsTotal} complete`);
    console.log(`- Validation: ${yn(stage_a.validated)}`);
    console.log(`- User approval: ${yn(stage_a.userApproved)}`);
  }

  if (progress.stage === 'B' || progress.stage === 'C') {
    console.log('');
    console.log('Stage B');
    console.log(`- Drafted: ${yn(stage_b.drafted)}`);
    console.log(`- Validated: ${yn(stage_b.validated)}`);
    console.log(`- Packs reviewed: ${yn(stage_b.packsReviewed)}`);
    console.log(`- User approval: ${yn(stage_b.userApproved)}`);
  }

  if (progress.stage === 'C' || progress.stage === 'complete') {
    console.log('');
    console.log('Stage C');
    console.log(`- Scaffold applied: ${yn(stage_c.scaffoldApplied)}`);
    console.log(`- Configs generated: ${yn(stage_c.configsGenerated)}`);
    console.log(`- Manifest updated: ${yn(stage_c.manifestUpdated)}`);
    console.log(`- Wrappers synced: ${yn(stage_c.wrappersSynced)}`);
    console.log(`- Skill retention reviewed: ${yn(stage_c.skillRetentionReviewed)}`);
    console.log(`- Root AGENTS.md updated: ${yn(stage_c.agentsUpdated)}`);
    console.log(`- Modular core build: ${yn(stage_c.modularBuilt)}`);
  }

  console.log('');
  console.log('Next steps');
  const nextSteps = [];

  if (!outputLanguage) {
    nextSteps.push(`Choose one output language and set: ${stateRel} -> outputLanguage`);
    nextSteps.push(`Re-run status to refresh entry docs + board snapshot: node ${self} status --repo-root ${repoRoot}`);
  }

  if (progress.stage === 'A') {
    if (!stage_a.validated) {
      nextSteps.push(`Edit: ${docsRel}/`);
      nextSteps.push(`Run: node ${self} check-docs --repo-root ${repoRoot} --strict`);
    } else if (!stage_a.userApproved) {
      const missingMustAsk = getMissingMustAskKeys(state['stage-a']);
      if (missingMustAsk.length > 0) {
        nextSteps.push(`Complete must-ask checklist: ${missingMustAsk.join(', ')}`);
        nextSteps.push(`Record each: node ${self} mark-must-ask --repo-root ${repoRoot} --key <key> --asked --answered --written-to <path>`);
      }
      nextSteps.push('Have the user review the Stage A docs and explicitly approve.');
      nextSteps.push(`Then run: node ${self} approve --stage A --repo-root ${repoRoot}`);
    }
  } else if (progress.stage === 'B') {
    if (!stage_b.validated) {
      nextSteps.push(`Edit: ${bpRel}`);
      nextSteps.push(`Run: node ${self} validate --repo-root ${repoRoot} --blueprint ${bpRel}`);
    } else if (!stage_b.userApproved) {
      if (!stage_b.packsReviewed) {
        nextSteps.push(`Recommended: review packs and record: node ${self} review-packs --repo-root ${repoRoot}`);
      }
      nextSteps.push('Have the user review the blueprint and explicitly approve.');
      nextSteps.push(`Then run: node ${self} approve --stage B --repo-root ${repoRoot}`);
    }
  } else if (progress.stage === 'C') {
    if (!stage_c.wrappersSynced) {
      nextSteps.push(`Run: node ${self} apply --repo-root ${repoRoot} --providers both --blueprint ${bpRel}`);
    } else if (!stage_c.skillRetentionReviewed) {
      nextSteps.push(`Review skill retention (required): fill ${retentionRel}`);
      nextSteps.push(`Then run: node ${self} review-skill-retention --repo-root ${repoRoot}`);
    } else if (!stage_c.agentsUpdated) {
      nextSteps.push('AGENTS.md update (required): update root AGENTS.md with project info.');
      nextSteps.push(`Run: node ${self} update-agents --repo-root ${repoRoot} --apply`);
      nextSteps.push(`Or skip (not recommended): node ${self} approve --stage C --repo-root ${repoRoot} --skip-agents-update`);
    } else if (!stage_c.userApproved) {
      nextSteps.push('Have the user review the Stage C outputs and explicitly approve.');
      nextSteps.push(`Then run: node ${self} approve --stage C --repo-root ${repoRoot}`);
    }
  } else if (progress.stage === 'complete') {
    nextSteps.push('Initialization complete.');
    nextSteps.push(`Optional: node ${self} cleanup-init --repo-root ${repoRoot} --apply --i-understand --archive`);
  }

  if (nextSteps.length === 0) {
    nextSteps.push(`Run: node ${self} advance --repo-root ${repoRoot}`);
  }

  for (const step of nextSteps) console.log(`- ${step}`);
  console.log('');
}

// ============================================================================
// INIT-BOARD.md machine snapshot sync
// ============================================================================

function writeTextIfChanged(filePath, content) {
  try {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (existing === content) return { ok: true, changed: false };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const INIT_BOARD_MACHINE_SNAPSHOT_START = '<!-- INIT-BOARD:MACHINE_SNAPSHOT:START -->';
const INIT_BOARD_MACHINE_SNAPSHOT_END = '<!-- INIT-BOARD:MACHINE_SNAPSHOT:END -->';

function normalizeOutputLanguage(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.toLowerCase() === 'tbd') return null;
  return v;
}

function readOutputLanguageFromState(state) {
  return normalizeOutputLanguage(state?.outputLanguage);
}

function readOutputLanguage(_repoRoot, state) {
  const fromState = readOutputLanguageFromState(state);
  if (fromState) return { ok: true, value: fromState, source: 'state' };
  return { ok: true, value: null, source: 'none' };
}

function upsertTextBetweenMarkers(raw, startMarker, endMarker, innerContent) {
  const startIdx = raw.indexOf(startMarker);
  const endIdx = raw.indexOf(endMarker);

  const inner = String(innerContent ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    const suffix = [
      '',
      '',
      '<details>',
      '<summary>Machine snapshot (auto-updated; do not edit)</summary>',
      '',
      startMarker,
      inner,
      endMarker,
      '',
      '</details>',
      ''
    ].join('\n');
    const next = (raw || '').replace(/\s*$/, '') + suffix;
    return next.endsWith('\n') ? next : next + '\n';
  }

  const before = raw.slice(0, startIdx + startMarker.length);
  const after = raw.slice(endIdx);

  const next = `${before}\n${inner}\n${after}`;
  return next.endsWith('\n') ? next : next + '\n';
}

function deriveStateUpdatedAt(state) {
  const history = Array.isArray(state?.history) ? state.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const ts = history[i]?.timestamp;
    if (ts && String(ts).trim()) return String(ts).trim();
  }
  const createdAt = state?.createdAt;
  if (createdAt && String(createdAt).trim()) return String(createdAt).trim();
  return null;
}

function renderInitBoardMachineSnapshot({ repoRoot, docsRoot, blueprintPath, state, outputLanguage }) {
  const initPaths = resolveInitPaths(repoRoot);
  const progress = getStageProgress(state);
  const stage = progress?.stage || 'not-started';

  const docs = {
    requirements: path.join(docsRoot, 'requirements.md'),
    nfr: path.join(docsRoot, 'non-functional-requirements.md'),
    glossary: path.join(docsRoot, 'domain-glossary.md'),
    riskQuestions: path.join(docsRoot, 'risk-open-questions.md')
  };

  const stage_a = progress['stage-a'] || {};
  const stage_b = progress['stage-b'] || {};
  const stage_c = progress['stage-c'] || {};

  const requiredItems = [];
  if (!outputLanguage) {
    requiredItems.push({
      id: 'outputLanguage',
      stage: 'Pre-Stage A',
      status: 'NOT SET',
      action: 'Set `init/_work/.init-state.json` -> `outputLanguage`'
    });
  }

  if (stage === 'A' || (stage !== 'complete' && !stage_a.userApproved)) {
    const missingMustAsk = getMissingMustAskKeys(state['stage-a']);
    if (missingMustAsk.length > 0) {
      requiredItems.push({
        id: 'mustAskChecklist',
        stage: 'Stage A',
        status: `${stage_a.mustAskCompleted}/${stage_a.mustAskTotal}`,
        action: `Complete: ${missingMustAsk.join(', ')}`
      });
    }
    if (!stage_a.validated) {
      requiredItems.push({
        id: 'stageADocsValidation',
        stage: 'Stage A',
        status: 'NOT VALIDATED',
        action: 'Run `check-docs --strict`'
      });
    }
  }

  if (stage === 'B' || (stage === 'C' && !stage_b.userApproved)) {
    if (!stage_b.validated) {
      requiredItems.push({
        id: 'blueprintValidation',
        stage: 'Stage B',
        status: 'NOT VALIDATED',
        action: 'Run `validate`'
      });
    }
  }

  if (stage === 'C') {
    if (stage_c.wrappersSynced && !stage_c.skillRetentionReviewed) {
      requiredItems.push({
        id: 'skillRetentionReview',
        stage: 'Stage C',
        status: 'NOT REVIEWED',
        action: 'Run `review-skill-retention`'
      });
    }
    if (stage_c.skillRetentionReviewed && !stage_c.agentsUpdated) {
      requiredItems.push({
        id: 'agentsUpdate',
        stage: 'Stage C',
        status: 'NOT UPDATED',
        action: 'Run `update-agents --apply`'
      });
    }
  }

  const snapshot = {
    schema: 'init-board-machine-snapshot@1',
    stateUpdatedAt: deriveStateUpdatedAt(state),
    outputLanguage: outputLanguage || null,
    stage,
    workingLayout: {
      mode: initPaths.mode,
      root: path.relative(repoRoot, initPaths.root)
    },
    paths: {
      startHere: path.relative(repoRoot, path.join(getInitRoot(repoRoot), 'START-HERE.md')),
      initBoard: path.relative(repoRoot, path.join(getInitRoot(repoRoot), 'INIT-BOARD.md')),
      state: path.relative(repoRoot, initPaths.statePath),
      docsRoot: path.relative(repoRoot, docsRoot),
      blueprint: blueprintPath ? path.relative(repoRoot, blueprintPath) : null,
      skillRetention: path.relative(repoRoot, initPaths.skillRetentionPath)
    },
    progress,
    stageADocs: Object.fromEntries(
      Object.entries(docs).map(([k, absPath]) => [
        k,
        { exists: fs.existsSync(absPath), path: path.relative(repoRoot, absPath) }
      ])
    ),
    requiredItems,
    historyTail: (state.history || []).slice(-10)
  };

  return ['```json', JSON.stringify(snapshot, null, 2), '```'].join('\n');
}

function syncInitBoard({ repoRoot, docsRoot, blueprintPath }) {
  const marker = findInitKitMarker(repoRoot);
  if (!marker) return { ok: true, skipped: true };

  const state = loadState(repoRoot);
  if (!state) return { ok: true, skipped: true, reason: 'init not started' };

  const lang = readOutputLanguage(repoRoot, state);
  if (!lang.ok) return { ok: false, error: lang.error };
  if (!lang.value) return { ok: true, skipped: true, reason: 'outputLanguage not set' };

  // Only create entry docs after the output language is chosen.
  ensureStartHere(repoRoot, true);
  ensureInitBoard(repoRoot, true);
  ensureWorkAgents(repoRoot, true);

  const initDir = path.join(repoRoot, 'init');
  const boardPath = path.join(initDir, 'INIT-BOARD.md');
  if (!fs.existsSync(boardPath)) return { ok: true, skipped: true, reason: 'init/INIT-BOARD.md missing' };

  const current = fs.readFileSync(boardPath, 'utf8');
  const snapshot = renderInitBoardMachineSnapshot({
    repoRoot,
    docsRoot,
    blueprintPath,
    state,
    outputLanguage: lang.value
  });
  const next = upsertTextBetweenMarkers(current, INIT_BOARD_MACHINE_SNAPSHOT_START, INIT_BOARD_MACHINE_SNAPSHOT_END, snapshot);
  return writeTextIfChanged(boardPath, next);
}

// ============================================================================
// Config File Generation
// ============================================================================

// Import from scaffold-configs.mjs (single source of truth)
import { generateConfigFiles as genConfigFiles } from './scaffold-configs.mjs';

function generateConfigFiles(repoRoot, blueprint, apply) {
  return genConfigFiles(repoRoot, blueprint, apply);
}

function packPrefixMap() {
  // Must match actual .ai/skills/ directory structure
  return {
    workflows: 'workflows/',
    standards: 'standards/',
    testing: 'testing/',
    'context-core': 'features/context-awareness',
    backend: 'backend/',
    frontend: 'frontend/'
  };
}

function packOrder() {
  // Base packs available in template (matches .ai/skills/_meta/packs/)
  return ['workflows', 'standards', 'testing', 'context-core', 'backend', 'frontend'];
}

function normalizePackList(packs) {
  const cleaned = (packs || [])
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean);

  const order = packOrder();
  const ordered = [];
  for (const p of order) {
    if (cleaned.includes(p)) ordered.push(p);
  }
  for (const p of cleaned) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return uniq(ordered);
}

function validateBlueprint(blueprint) {
  const errors = [];
  const warnings = [];

  if (!blueprint || typeof blueprint !== 'object') {
    errors.push('Blueprint must be a JSON object.');
    return { ok: false, errors, warnings };
  }

  if (!Number.isInteger(blueprint.version) || blueprint.version < 1) {
    errors.push('Blueprint.version must be an integer >= 1.');
  }

  // Feature flags
  if (blueprint.features !== undefined) {
    if (blueprint.features === null || Array.isArray(blueprint.features) || typeof blueprint.features !== 'object') {
      errors.push('features must be an object when present.');
    }
  }
  if (blueprint.addons !== undefined) {
    errors.push('addons is not supported. Use features.* instead.');
  }

  const flags = featureFlags(blueprint);
  if (Object.prototype.hasOwnProperty.call(flags, 'contextAwareness') && flags.contextAwareness !== true) {
    errors.push('features.contextAwareness is mandatory and must be true (or omitted).');
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'database')) {
    errors.push('features.database is not supported. Use db.ssot to enable/disable database materialization.');
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'ci')) {
    errors.push('features.ci is not supported. Use ci.provider to enable/disable CI materialization.');
  }
  if (Object.prototype.hasOwnProperty.call(flags, 'iac')) {
    errors.push('features.iac is not supported. Use iac.tool to enable/disable IaC materialization (none|ros|terraform).');
  }

  const project = blueprint.project || {};
  if (!project.name || typeof project.name !== 'string') errors.push('project.name is required (string).');
  if (!project.description || typeof project.description !== 'string') errors.push('project.description is required (string).');
  if (
    project.name === 'acme-app' &&
    typeof project.description === 'string' &&
    project.description.toLowerCase().includes('example minimal project blueprint')
  ) {
    warnings.push('[template] Blueprint appears to still use the starter example values (acme-app / example description). Update project.name and project.description before approving Stage B.');
  }

  const repo = blueprint.repo || {};
  const validLayouts = ['single', 'monorepo'];
  if (!repo.layout || !validLayouts.includes(repo.layout)) {
    errors.push(`repo.layout is required and must be one of: ${validLayouts.join(', ')}`);
  }
  if (!repo.language || typeof repo.language !== 'string') {
    errors.push('repo.language is required (string).');
  }
  if (!repo.packageManager || typeof repo.packageManager !== 'string') {
    errors.push('repo.packageManager is required (string).');
  }

  // Capabilities sanity checks (warn-only unless obviously inconsistent)
  const caps = blueprint.capabilities || {};
  if (caps.database && caps.database.enabled) {
    if (!caps.database.kind || typeof caps.database.kind !== 'string') warnings.push('capabilities.database.enabled=true but capabilities.database.kind is missing.');
  }
  if (caps.api && caps.api.style && typeof caps.api.style !== 'string') warnings.push('capabilities.api.style should be a string.');
  if (caps.bpmn && typeof caps.bpmn.enabled !== 'boolean') warnings.push('capabilities.bpmn.enabled should be boolean when present.');



  // DB SSOT mode checks (mutually exclusive DB schema workflows)
  const db = blueprint.db || {};
  const validSsot = ['none', 'repo-prisma', 'database'];
  if (typeof db.enabled !== 'boolean') {
    errors.push('db.enabled is required (boolean).');
  }
  if (!db.ssot || typeof db.ssot !== 'string' || !validSsot.includes(db.ssot)) {
    errors.push(`db.ssot is required and must be one of: ${validSsot.join(', ')}`);
  }

  if (Object.prototype.hasOwnProperty.call(flags, 'dbMirror')) {
    errors.push('features.dbMirror is not supported. Use db.ssot to select DB SSOT mode (none|repo-prisma|database).');
  }

  if (db.ssot !== 'none' && db.enabled === false) {
    warnings.push('db.ssot is not none, but db.enabled is false. Ensure this is intentional.');
  }
  if (db.ssot === 'none' && db.enabled === true) {
    warnings.push('db.enabled=true but db.ssot=none. Set db.ssot to repo-prisma/database to enable DB materialization.');
  }
  if (db.ssot === 'none') {
    warnings.push('db.ssot=none: DB materialization is disabled (no prisma/db/DB schema context files will be generated).');
  }

  // Feature dependencies
  if (isObservabilityEnabled(blueprint) && !isContextAwarenessEnabled(blueprint)) {
    errors.push('features.observability=true requires features.contextAwareness=true (observability contracts live under docs/context/).');
  }

  // CI feature requirements
  const provider = ciProvider(blueprint);
  if (provider === null) {
    errors.push('ci.provider must be one of: none, github, gitlab.');
  }
  if (provider === 'none') {
    warnings.push('ci.provider=none: CI materialization is disabled (no CI files will be generated).');
  }
  const ci = blueprint.ci && typeof blueprint.ci === 'object' ? blueprint.ci : {};
  if (typeof ci.enabled === 'boolean') {
    if (ci.enabled === false && provider && provider !== 'none') {
      warnings.push('ci.enabled=false but ci.provider is not none. CI materialization is controlled by ci.provider (ci.enabled is informational only).');
    }
    if (ci.enabled === true && provider === 'none') {
      warnings.push('ci.enabled=true but ci.provider=none. CI materialization is controlled by ci.provider (ci.enabled is informational only).');
    }
  }

  // IaC tool selection (provider-driven IaC feature)
  const iac = blueprint.iac && typeof blueprint.iac === 'object' ? blueprint.iac : {};
  const rawIacTool = typeof iac.tool === 'string' ? iac.tool.trim() : '';
  const normalizedIacTool = rawIacTool ? rawIacTool.toLowerCase() : 'none';
  const validIacTools = ['none', 'ros', 'terraform'];
  if (rawIacTool && !validIacTools.includes(normalizedIacTool)) {
    errors.push(`iac.tool must be one of: ${validIacTools.join(', ')}.`);
  }

  // Default-on feature config "enabled" fields are informational only.
  // Materialization is controlled by blueprint.features.<id> (override-disable).
  const packagingCfg = blueprint.packaging && typeof blueprint.packaging === 'object' ? blueprint.packaging : {};
  if (typeof packagingCfg.enabled === 'boolean') {
    if (packagingCfg.enabled === false && isPackagingEnabled(blueprint)) {
      warnings.push('packaging.enabled=false but packaging materialization is enabled by default. packaging.enabled is informational only; use features.packaging=false to skip packaging.');
    }
    if (packagingCfg.enabled === true && !isPackagingEnabled(blueprint)) {
      warnings.push('packaging.enabled=true but features.packaging=false. packaging.enabled is informational only; remove the conflict or re-enable packaging by removing features.packaging=false.');
    }
  }

  const deployCfg = blueprint.deploy && typeof blueprint.deploy === 'object' ? blueprint.deploy : {};
  if (typeof deployCfg.enabled === 'boolean') {
    if (deployCfg.enabled === false && isDeploymentEnabled(blueprint)) {
      warnings.push('deploy.enabled=false but deployment materialization is enabled by default. deploy.enabled is informational only; use features.deployment=false to skip deployment.');
    }
    if (deployCfg.enabled === true && !isDeploymentEnabled(blueprint)) {
      warnings.push('deploy.enabled=true but features.deployment=false. deploy.enabled is informational only; remove the conflict or re-enable deployment by removing features.deployment=false.');
    }
  }

  const releaseCfg = blueprint.release && typeof blueprint.release === 'object' ? blueprint.release : {};
  if (typeof releaseCfg.enabled === 'boolean') {
    if (releaseCfg.enabled === false && isReleaseEnabled(blueprint)) {
      warnings.push('release.enabled=false but release materialization is enabled by default. release.enabled is informational only; use features.release=false to skip release.');
    }
    if (releaseCfg.enabled === true && !isReleaseEnabled(blueprint)) {
      warnings.push('release.enabled=true but features.release=false. release.enabled is informational only; remove the conflict or re-enable release by removing features.release=false.');
    }
  }

  const obsCfg = blueprint.observability && typeof blueprint.observability === 'object' ? blueprint.observability : {};
  if (typeof obsCfg.enabled === 'boolean') {
    if (obsCfg.enabled === false && isObservabilityEnabled(blueprint)) {
      warnings.push('observability.enabled=false but observability materialization is enabled by default. observability.enabled is informational only; use features.observability=false to skip observability.');
    }
    if (obsCfg.enabled === true && !isObservabilityEnabled(blueprint)) {
      warnings.push('observability.enabled=true but features.observability=false. observability.enabled is informational only; remove the conflict or re-enable observability by removing features.observability=false.');
    }
  }

  if ((caps.database && caps.database.enabled) && db.ssot === 'none') {
    warnings.push('capabilities.database.enabled=true but db.ssot=none. The template will not manage schema synchronization.');
  }
  if ((!caps.database || !caps.database.enabled) && db.ssot !== 'none') {
    warnings.push('db.ssot is not none, but capabilities.database.enabled is false. Ensure this is intentional.');
  }
  const skills = blueprint.skills || {};
  if (skills.packs && !Array.isArray(skills.packs)) errors.push('skills.packs must be an array of strings when present.');

  const packs = normalizePackList(skills.packs || []);
  if (!packs.includes('workflows')) warnings.push('skills.packs does not include "workflows". This is usually required.');
  if (!packs.includes('standards')) warnings.push('skills.packs does not include "standards". This is usually recommended.');

  const ok = errors.length === 0;
  return { ok, errors, warnings, packs };
}

function featureFlags(blueprint) {
  if (!blueprint || typeof blueprint !== 'object') return {};
  const features = blueprint.features;
  if (!features || Array.isArray(features) || typeof features !== 'object') return {};
  return features;
}

function isContextAwarenessEnabled(blueprint) {
  // Mandatory: always enabled in this template.
  // (If a blueprint explicitly sets features.contextAwareness=false, validateBlueprint rejects it.)
  return true;
}

function featureOverrideBool(blueprint, key) {
  const flags = featureFlags(blueprint);
  if (!flags || typeof flags !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(flags, key)) return undefined;
  return typeof flags[key] === 'boolean' ? flags[key] : undefined;
}

function defaultOnFeature(blueprint, key) {
  const ov = featureOverrideBool(blueprint, key);
  return ov === undefined ? true : ov === true;
}


function recommendedPacksFromBlueprint(blueprint) {
  const rec = new Set(['workflows', 'standards']);
  const caps = blueprint.capabilities || {};

  if (caps.backend && caps.backend.enabled) rec.add('backend');
  if (caps.frontend && caps.frontend.enabled) rec.add('frontend');

  // Optional packs can be added explicitly via blueprint.skills.packs.
  // (This function only computes recommendations; it does NOT mutate the blueprint.)

  const ordered = [];
  for (const p of packOrder()) {
    if (rec.has(p)) ordered.push(p);
  }
  return ordered;
}

function recommendedFeaturesFromBlueprint(blueprint) {
  const rec = [];

  // Mandatory foundation (cannot be disabled)
  rec.push('contextAwareness');

  // Provider/SSOT-driven features
  if (dbSsotMode(blueprint) !== 'none') rec.push('database');
  const provider = ciProvider(blueprint);
  if (provider && provider !== 'none') rec.push('ci');
  if (iacTool(blueprint) !== 'none') rec.push('iac');

  // Default-on, override-disable features
  if (defaultOnFeature(blueprint, 'ui')) rec.push('ui');
  if (defaultOnFeature(blueprint, 'environment')) rec.push('environment');
  if (defaultOnFeature(blueprint, 'packaging')) rec.push('packaging');
  if (defaultOnFeature(blueprint, 'deployment')) rec.push('deployment');
  if (defaultOnFeature(blueprint, 'release')) rec.push('release');
  if (defaultOnFeature(blueprint, 'observability')) rec.push('observability');

  return uniq(rec);
}

function getEnabledFeatures(blueprint) {
  const enabled = [];
  
  if (isContextAwarenessEnabled(blueprint)) enabled.push('contextAwareness');
  if (isDatabaseEnabled(blueprint)) enabled.push('database');
  if (isIacEnabled(blueprint)) enabled.push('iac');
  if (isUiEnabled(blueprint)) enabled.push('ui');
  if (isEnvironmentEnabled(blueprint)) enabled.push('environment');
  if (isPackagingEnabled(blueprint)) enabled.push('packaging');
  if (isDeploymentEnabled(blueprint)) enabled.push('deployment');
  if (isReleaseEnabled(blueprint)) enabled.push('release');
  if (isCiEnabled(blueprint)) enabled.push('ci');
  if (isObservabilityEnabled(blueprint)) enabled.push('observability');
  
  return enabled;
}

function checkPackInstall(repoRoot, pack) {
  const packFile = path.join(repoRoot, '.ai', 'skills', '_meta', 'packs', `${pack}.json`);
  if (fs.existsSync(packFile)) {
    return { pack, installed: true, via: 'pack-file', path: path.relative(repoRoot, packFile) };
  }
  return { pack, installed: false, reason: `missing ${path.relative(repoRoot, packFile)}` };
}

function printResult(result, format) {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // text
  if (result.summary) console.log(result.summary);
  if (result.errors && result.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of result.errors) console.log(`- ${e}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings) console.log(`- ${w}`);
  }
}

function checkDocs(docsRoot) {
  const errors = [];
  const warnings = [];

  const stageATemplateFiles = [
    'requirements.template.md',
    'non-functional-requirements.template.md',
    'domain-glossary.template.md',
    'risk-open-questions.template.md'
  ];

  const placeholderTokens = uniq(
    stageATemplateFiles
      .map((f) => path.join(TEMPLATES_DIR, f))
      .filter((fp) => fs.existsSync(fp))
      .flatMap((fp) => (fs.readFileSync(fp, 'utf8').match(/<[^>\n]{1,80}>/g) || []))
  );

  // Check if docs directory exists
  if (!fs.existsSync(docsRoot)) {
    return {
      ok: false,
      errors: [
        `Stage A docs directory not found: ${docsRoot}`,
        `Run: node init/_tools/skills/initialize-project-from-requirements/scripts/init-pipeline.mjs start --repo-root <repo-root>`
      ],
      warnings: []
    };
  }

  const required = [
    { name: 'requirements.md', mustContain: ['# Requirements', '## Conclusions', '## Goals', '## Non-goals'] },
    { name: 'non-functional-requirements.md', mustContain: ['# Non-functional Requirements', '## Conclusions'] },
    { name: 'domain-glossary.md', mustContain: ['# Domain Glossary', '## Terms'] },
    { name: 'risk-open-questions.md', mustContain: ['# Risks and Open Questions', '## Open questions'] }
  ];

  const placeholderPatterns = [
    { re: /^\s*[-*]\s*\.\.\.\s*$/gm, msg: 'placeholder bullet "- ..."' },
    { re: /:\s*\.\.\.\s*$/gm, msg: 'placeholder value ": ..."' }
  ];

  const missingFiles = [];
  for (const spec of required) {
    const fp = path.join(docsRoot, spec.name);
    if (!fs.existsSync(fp)) {
      missingFiles.push(spec.name);
      errors.push(`Missing required Stage A doc: ${path.relative(process.cwd(), fp)}`);
      continue;
    }
    const content = fs.readFileSync(fp, 'utf8');

    for (const needle of spec.mustContain) {
      if (!content.includes(needle)) {
        errors.push(`${spec.name} is missing required section/heading: "${needle}"`);
      }
    }

    for (const pat of placeholderPatterns) {
      const hits = content.match(pat.re);
      if (hits && hits.length > 0) {
        errors.push(`${spec.name} still contains ${pat.msg}. Replace all template placeholders.`);
      }
    }

    // Template placeholders like "<bullets>" are allowed in templates but should not remain in finalized docs.
    // Do NOT treat arbitrary HTML tags (e.g. <details>) as placeholders; only enforce tokens that appear in our templates.
    for (const token of placeholderTokens) {
      if (token && content.includes(token)) {
        errors.push(`${spec.name} still contains template placeholder ${JSON.stringify(token)}. Replace all template placeholders.`);
      }
    }

    // Soft signals
    if (content.includes('TODO') || content.includes('FIXME')) {
      warnings.push(`${spec.name} contains TODO/FIXME markers. Ensure they are tracked in risk-open-questions.md or removed.`);
    }
  }

  // Add hint if files are missing
  if (missingFiles.length > 0) {
    errors.push(`Hint: Run "scaffold --blueprint <path> --apply" to create missing template files`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function ensureDir(dirPath, apply) {
  if (fs.existsSync(dirPath)) return { op: 'skip', path: dirPath, reason: 'exists' };
  if (!apply) return { op: 'mkdir', path: dirPath, mode: 'dry-run' };
  fs.mkdirSync(dirPath, { recursive: true });
  return { op: 'mkdir', path: dirPath, mode: 'applied' };
}

function writeFileIfMissing(filePath, content, apply) {
  if (fs.existsSync(filePath)) return { op: 'skip', path: filePath, reason: 'exists' };
  if (!apply) return { op: 'write', path: filePath, mode: 'dry-run' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return { op: 'write', path: filePath, mode: 'applied' };
}

function ensureStartHere(repoRoot, apply) {
  const srcPath = path.join(TEMPLATES_DIR, 'START-HERE.template.md');
  const destPath = path.join(getInitRoot(repoRoot), 'START-HERE.md');
  return copyFileIfMissing(srcPath, destPath, apply);
}

function ensureInitBoard(repoRoot, apply) {
  const srcPath = path.join(TEMPLATES_DIR, 'INIT-BOARD.template.md');
  const destPath = path.join(getInitRoot(repoRoot), 'INIT-BOARD.md');
  return copyFileIfMissing(srcPath, destPath, apply);
}

function ensureWorkAgents(repoRoot, apply) {
  const srcPath = path.join(TEMPLATES_DIR, 'WORKSPACE-AGENTS.template.md');
  const destPath = path.join(getInitWorkRoot(repoRoot), 'AGENTS.md');
  return copyFileIfMissing(srcPath, destPath, apply);
}

function ensureSkillRetentionTemplate(repoRoot, apply) {
  const srcPath = path.join(TEMPLATES_DIR, 'skill-retention-table.template.md');
  const destPath = resolveInitPaths(repoRoot).skillRetentionPath;

  if (!fs.existsSync(srcPath)) {
    return { op: 'copy', path: destPath, mode: 'skipped', reason: 'template not found' };
  }
  if (fs.existsSync(destPath)) {
    return { op: 'copy', path: destPath, mode: 'skipped', reason: 'exists' };
  }
  if (!apply) return { op: 'copy', path: destPath, mode: 'dry-run' };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  return { op: 'copy', path: destPath, mode: 'applied' };
}

/**
 * Generates a project-specific README.md from the blueprint.
 * Replaces the template README with project information.
 */
function generateProjectReadme(repoRoot, blueprint, apply) {
  const readmePath = path.join(repoRoot, 'README.md');
  const templatePath = path.join(__dirname, 'templates', 'README.template.md');
  
  if (!fs.existsSync(templatePath)) {
    return { op: 'skip', path: readmePath, reason: 'template not found' };
  }
  
  let template = fs.readFileSync(templatePath, 'utf8');
  
  const project = blueprint.project || {};
  const repo = blueprint.repo || {};
  const caps = blueprint.capabilities || {};
  
  // Simple mustache-like replacement
  function replace(key, value) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  
  function conditionalBlock(key, value, show) {
    const regex = new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`, 'g');
    if (show && value) {
      template = template.replace(regex, (_, content) => content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value));
    } else {
      template = template.replace(regex, '');
    }
  }
  
  // Basic replacements
  replace('PROJECT_NAME', project.name || 'my-project');
  replace('PROJECT_DESCRIPTION', project.description || 'Project description');
  replace('LANGUAGE', repo.language || 'typescript');
  replace('PACKAGE_MANAGER', repo.packageManager || 'pnpm');
  replace('REPO_LAYOUT', repo.layout || 'single');
  
  // Conditional blocks
  conditionalBlock('DOMAIN', project.domain, !!project.domain);
  conditionalBlock('FRONTEND_FRAMEWORK', caps.frontend?.framework, caps.frontend?.enabled);
  conditionalBlock('BACKEND_FRAMEWORK', caps.backend?.framework, caps.backend?.enabled);
  conditionalBlock('DATABASE_KIND', caps.database?.kind, caps.database?.enabled);
  conditionalBlock('API_STYLE', caps.api?.style, !!caps.api?.style);

  // Table-friendly values (avoid empty cells in README templates)
  replace('FRONTEND_FRAMEWORK', caps.frontend?.enabled ? (caps.frontend?.framework || 'TBD') : 'none');
  replace('BACKEND_FRAMEWORK', caps.backend?.enabled ? (caps.backend?.framework || 'TBD') : 'none');
  replace('DATABASE_KIND', caps.database?.enabled ? (caps.database?.kind || 'TBD') : 'none');
  replace('API_STYLE', caps.api?.style || 'none');
  
  // Language-specific blocks
  const isNode = ['typescript', 'javascript'].includes(repo.language);
  const isPython = repo.language === 'python';
  const isGo = repo.language === 'go';
  
  conditionalBlock('IS_NODE', 'true', isNode);
  conditionalBlock('IS_PYTHON', 'true', isPython);
  conditionalBlock('IS_GO', 'true', isGo);
  
  // Install and dev commands based on package manager
  const installCommands = {
    pnpm: 'pnpm install',
    npm: 'npm install',
    yarn: 'yarn',
    pip: 'pip install -r requirements.txt',
    poetry: 'poetry install',
    go: 'go mod download'
  };
  
  const devCommands = {
    pnpm: 'pnpm dev',
    npm: 'npm run dev',
    yarn: 'yarn dev',
    pip: 'python main.py',
    poetry: 'poetry run python main.py',
    go: 'go run .'
  };
  
  const testCommands = {
    pnpm: 'pnpm test',
    npm: 'npm test',
    yarn: 'yarn test',
    pip: 'pytest',
    poetry: 'poetry run pytest',
    go: 'go test ./...'
  };
  
  const pm = repo.packageManager || 'pnpm';
  replace('INSTALL_COMMAND', installCommands[pm] || installCommands.pnpm);
  replace('DEV_COMMAND', devCommands[pm] || devCommands.pnpm);
  replace('TEST_COMMAND', testCommands[pm] || testCommands.pnpm);
  
  // Project structure based on layout
  let structure;
  if (repo.layout === 'monorepo') {
    structure = `apps/
  frontend/       # Frontend application
  backend/        # Backend services
packages/
  shared/         # Shared libraries
.ai/skills/       # AI skills (SSOT)
docs/             # Documentation
ops/              # DevOps configuration`;
  } else {
    structure = `src/
  frontend/       # Frontend code
  backend/        # Backend code
.ai/skills/       # AI skills (SSOT)
docs/             # Documentation
ops/              # DevOps configuration`;
  }
  replace('PROJECT_STRUCTURE', structure);
  
  // Clean up any remaining empty conditional blocks
  template = template.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '');
  template = template.replace(/\{\{\w+\}\}/g, '');
  
  // Clean up multiple empty lines
  template = template.replace(/\n{3,}/g, '\n\n');
  
  if (!apply) {
    return { op: 'write', path: readmePath, mode: 'dry-run' };
  }
  
  fs.writeFileSync(readmePath, template, 'utf8');
  return { op: 'write', path: readmePath, mode: 'applied' };
}

function copyFileIfMissing(srcPath, destPath, apply) {
  if (fs.existsSync(destPath)) {
    return { op: 'skip', path: destPath, reason: 'exists' };
  }
  if (!fs.existsSync(srcPath)) {
    return { op: 'skip', path: destPath, reason: 'source not found', srcPath };
  }
  if (!apply) {
    return { op: 'copy-template', from: srcPath, path: destPath, mode: 'dry-run' };
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  return { op: 'copy-template', from: srcPath, path: destPath, mode: 'applied' };
}

function listFilesRecursive(dir) {
  const out = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function copyDirIfMissing(srcDir, destDir, apply, force = false) {
  const actions = [];
  if (!fs.existsSync(srcDir)) {
    return { ok: false, actions, error: `source directory not found: ${srcDir}` };
  }

  const files = listFilesRecursive(srcDir);
  for (const srcFile of files) {
    const rel = path.relative(srcDir, srcFile);
    const destFile = path.join(destDir, rel);

    // Ensure parent directory exists
    const parent = path.dirname(destFile);
    if (!fs.existsSync(parent)) {
      if (!apply) {
        actions.push({ op: 'mkdir', path: parent, mode: 'dry-run', note: `parent ${path.relative(destDir, parent)}` });
      } else {
        fs.mkdirSync(parent, { recursive: true });
        actions.push({ op: 'mkdir', path: parent, mode: 'applied', note: `parent ${path.relative(destDir, parent)}` });
      }
    }

    if (fs.existsSync(destFile) && !force) {
      actions.push({ op: 'skip', path: destFile, reason: 'exists' });
      continue;
    }

    if (!apply) {
      actions.push({ op: force ? 'overwrite' : 'copy', from: srcFile, to: destFile, mode: 'dry-run' });
      continue;
    }

    fs.copyFileSync(srcFile, destFile);
    actions.push({ op: force ? 'overwrite' : 'copy', from: srcFile, to: destFile, mode: 'applied' });
  }

  return { ok: true, actions };
}

function findFeatureTemplatesDir(repoRoot, featureId) {
  const id = String(featureId || '');
  const dash = id.replace(/_/g, '-');

  // Some feature IDs may source templates from a different skill location.
  const overrides = new Map([
    ['database', path.join(repoRoot, '.ai', 'skills', 'features', 'database', 'sync-code-schema-from-db', 'templates')],
  ]);
  const override = overrides.get(dash);
  if (override && fs.existsSync(override) && fs.statSync(override).isDirectory()) return override;

  const candidates = [
    // preferred (single-level feature folder)
    path.join(repoRoot, '.ai', 'skills', 'features', dash, 'templates'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

function runNodeScript(repoRoot, scriptPath, args, apply) {
  const cmd = 'node';
  const fullArgs = [scriptPath, ...args];
  const printable = `${cmd} ${fullArgs.join(' ')}`;

  if (!apply) return { op: 'run', cmd: printable, mode: 'dry-run' };

  const res = childProcess.spawnSync(cmd, fullArgs, { stdio: childProcessStdio(), cwd: repoRoot });
  if (res.status !== 0) return { op: 'run', cmd: printable, mode: 'failed', exitCode: res.status };
  return { op: 'run', cmd: printable, mode: 'applied' };
}

function runNodeScriptWithRepoRootFallback(repoRoot, scriptPath, args, apply) {
  const first = runNodeScript(repoRoot, scriptPath, args, apply);
  if (!apply) return first;

  if (first && first.mode === 'failed' && args.includes('--repo-root')) {
    // Some scripts may not accept --repo-root; retry without it (cwd is already repoRoot).
    const altArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo-root') {
        i++; // skip value
        continue;
      }
      altArgs.push(args[i]);
    }
    const second = runNodeScript(repoRoot, scriptPath, altArgs, apply);
    second.note = 'fallback: retried without --repo-root';
    return second;
  }
  return first;
}


function getContextMode(blueprint) {
  const mode = ((blueprint.context && blueprint.context.mode) || '').toLowerCase();
  if (mode === 'snapshot' || mode === 'contract') return mode;
  return 'contract';
}

function ciProvider(blueprint) {
  const ci = blueprint && blueprint.ci && typeof blueprint.ci === 'object' ? blueprint.ci : {};
  const provider = String(ci.provider || '').trim().toLowerCase();
  if (provider === 'none' || provider === 'github' || provider === 'gitlab') return provider;

  // Compatibility hint: allow derivation from ci.platform when present.
  const platform = String(ci.platform || '').trim().toLowerCase();
  if (platform === 'github-actions') return 'github';
  if (platform === 'gitlab-ci') return 'gitlab';

  // Default: GitHub (can be overridden by setting ci.provider="none").
  if (!provider) return 'github';

  return null;
}



// ============================================================================
// DB SSOT helpers (mutually exclusive schema synchronization modes)
// ============================================================================

function dbSsotMode(blueprint) {
  const db = blueprint && blueprint.db ? blueprint.db : {};
  return String(db.ssot || 'none');
}

function dbSsotExclusionsForMode(mode) {
  const m = String(mode || 'none');
  if (m === 'repo-prisma') return ['sync-code-schema-from-db'];
  if (m === 'database') return ['sync-db-schema-from-code'];
  // 'none' (opt-out) => exclude both DB sync skills
  return ['sync-db-schema-from-code', 'sync-code-schema-from-db'];
}

function writeDbSsotConfig(repoRoot, blueprint, apply) {
  const mode = dbSsotMode(blueprint);
  const outPath = path.join(repoRoot, 'docs', 'project', 'db-ssot.json');

  const cfg = {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode,
    paths: {
      prismaSchema: 'prisma/schema.prisma',
      dbSchemaTables: 'db/schema/tables.json',
      dbContextContract: 'docs/context/db/schema.json'
    }
  };

  if (!apply) {
    return { op: 'write', path: outPath, mode: 'dry-run', note: `db.ssot=${mode}` };
  }

  writeJson(outPath, cfg);
  return { op: 'write', path: outPath, mode: 'applied', note: `db.ssot=${mode}` };
}

function ensureDbSsotConfig(repoRoot, blueprint, apply) {
  // Writes docs/project/db-ssot.json reflecting the selected db.ssot mode.
  // When db.ssot=none, do not generate any DB SSOT config files.
  const mode = dbSsotMode(blueprint);
  const outPath = path.join(repoRoot, 'docs', 'project', 'db-ssot.json');
  if (mode === 'none') {
    return { op: 'skip', path: outPath, mode: apply ? 'skipped' : 'dry-run', reason: 'db.ssot=none' };
  }
  return writeDbSsotConfig(repoRoot, blueprint, apply);
}

function renderDbSsotAgentsBlock(mode) {
  const m = String(mode || 'none');

  // Progressive disclosure: minimal routing first, details as nested bullets.
  const header = `## Database SSOT and synchronization

`;

  const commonEnabled = [
    `- DB context contract (LLM-first): \`docs/context/db/schema.json\``,
    `- SSOT selection file: \`docs/project/db-ssot.json\``
  ];
  const commonDisabled = [
    `- DB context contract (disabled; not generated when db.ssot=none): \`docs/context/db/schema.json\``,
    `- SSOT selection file (disabled; not generated when db.ssot=none): \`docs/project/db-ssot.json\``
  ];

  if (m === 'repo-prisma') {
    return (
      header +
      `**Mode: repo-prisma** (SSOT = \`prisma/schema.prisma\`)

` +
      commonEnabled.join('\n') +
      `
- If you need to change persisted fields / tables: use skill \`sync-db-schema-from-code\`.
` +
      `- If you need to mirror an external DB: do NOT; this mode assumes migrations originate in the repo.

` +
      `Rules:
- Business layer MUST NOT import Prisma (repositories return domain entities).
- After schema changes, refresh context via \`node .ai/scripts/ctl-db-ssot.mjs sync-to-context\`.
`
    );
  }

  if (m === 'database') {
    return (
      header +
      `**Mode: database** (SSOT = running database)

` +
      commonEnabled.join('\n') +
      `
- If the DB schema changed: use skill \`sync-code-schema-from-db\` (DB -> Prisma -> mirror -> context).
` +
      `- Do NOT hand-edit \`prisma/schema.prisma\` or \`db/schema/tables.json\` as desired-state.

` +
      `Rules:
- Human runs \`prisma db pull\` against the correct environment.
- Mirror update: \`node .ai/skills/features/database/sync-code-schema-from-db/scripts/ctl-db.mjs import-prisma\`.
- Context refresh: \`node .ai/scripts/ctl-db-ssot.mjs sync-to-context\`.
`
    );
  }

  // none
  return (
    header +
    `**Mode: none** (no managed DB SSOT in this repo)

` +
    commonDisabled.join('\n') +
    `
- DB sync skills are disabled. Document DB changes in dev-docs and ask a human to provide a schema snapshot.
`
  );
}

function patchRootAgentsDbSsot(repoRoot, blueprint, apply) {
  const mode = dbSsotMode(blueprint);
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  const start = '<!-- DB-SSOT:START -->';
  const end = '<!-- DB-SSOT:END -->';

  const content = renderDbSsotAgentsBlock(mode).trimEnd();

  if (!apply) {
    return { op: 'edit', path: agentsPath, mode: 'dry-run', note: `update DB SSOT block (${mode})` };
  }

  let raw = '';
  if (fs.existsSync(agentsPath)) raw = fs.readFileSync(agentsPath, 'utf8');

  if (!raw.includes(start) || !raw.includes(end)) {
    // If no managed block exists, append one.
    const suffix = `

${start}
${content}
${end}
`;
    fs.writeFileSync(agentsPath, (raw || '').trimEnd() + suffix, 'utf8');
    return { op: 'edit', path: agentsPath, mode: 'applied', note: 'appended DB SSOT managed block' };
  }

  const before = raw.split(start)[0];
  const after = raw.split(end)[1];
  const next = `${before}${start}
${content}
${end}${after}`;
  fs.writeFileSync(agentsPath, next, 'utf8');
  return { op: 'edit', path: agentsPath, mode: 'applied', note: `updated DB SSOT managed block (${mode})` };
}

function patchRootAgentsDbSsotSection(repoRoot, blueprint, apply) {
  return patchRootAgentsDbSsot(repoRoot, blueprint, apply);
}

// ============================================================================
// Root AGENTS.md project info updater (project type + tech stack + key dirs)
// ============================================================================

function normalizeMarkdownNewlines(raw) {
  return String(raw || '').replace(/\r\n/g, '\n');
}

function ensureTrailingNewline(raw) {
  const s = String(raw || '');
  return s.endsWith('\n') ? s : `${s}\n`;
}

function stripBackticks(s) {
  return String(s || '').replace(/`/g, '').trim();
}

function findH2Index(lines, headingLine) {
  const h = String(headingLine || '').trim();
  if (!h.startsWith('## ')) throw new Error(`findH2Index requires a '## ' headingLine; got: ${headingLine}`);
  return lines.findIndex((l) => l.trim() === h);
}

function findNextH2Index(lines, startIdx) {
  for (let i = startIdx; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) return i;
  }
  return lines.length;
}

function replaceH2SectionBody(lines, headingLine, bodyLines) {
  const idx = findH2Index(lines, headingLine);
  if (idx === -1) return { lines, changed: false, op: 'skip', reason: 'heading not found' };

  const start = idx + 1;
  const end = findNextH2Index(lines, start);

  const before = lines.slice(0, start);
  const after = lines.slice(end);

  const next = [...before];
  if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
  next.push(...bodyLines);
  if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
  next.push(...after);

  return { lines: next, changed: true, op: 'replace' };
}

function insertH2SectionBefore(lines, beforeHeadingLine, headingLine, bodyLines) {
  const beforeIdx = findH2Index(lines, beforeHeadingLine);
  const insertAt = beforeIdx === -1 ? lines.length : beforeIdx;

  const next = [...lines.slice(0, insertAt)];
  if (next.length > 0 && next[next.length - 1].trim() !== '') next.push('');
  next.push(headingLine.trim());
  next.push('');
  next.push(...bodyLines);
  next.push('');
  next.push(...lines.slice(insertAt));

  return { lines: next, changed: true, op: 'insert', insertAt };
}

function renderTechStackTableRows(blueprint) {
  const project = blueprint.project || {};
  const repo = blueprint.repo || {};
  const caps = blueprint.capabilities || {};
  const db = blueprint.db || {};
  const ci = blueprint.ci || {};

  const frontend = caps.frontend?.enabled ? (caps.frontend?.framework || 'enabled') : 'none';
  const backend = caps.backend?.enabled ? (caps.backend?.framework || 'enabled') : 'none';
  const database = db.ssot ? `${db.ssot}${caps.database?.kind ? ` (${caps.database.kind})` : ''}` : (caps.database?.enabled ? (caps.database.kind || 'enabled') : 'none');
  const apiStyle = caps.api?.style || 'none';
  const primaryUsers = Array.isArray(project.primaryUsers) ? project.primaryUsers.filter(Boolean).join(', ') : '';

  const rows = [
    { area: 'Language', choice: repo.language || 'unknown' },
    { area: 'Package manager', choice: repo.packageManager || 'unknown' },
    { area: 'Repo layout', choice: repo.layout || 'unknown' },
    { area: 'Frontend', choice: frontend },
    { area: 'Backend', choice: backend },
    { area: 'API style', choice: apiStyle },
    { area: 'Database', choice: database },
    { area: 'CI', choice: ci.provider || 'github' },
  ];

  if (primaryUsers) rows.push({ area: 'Primary users', choice: primaryUsers });

  return rows;
}

function deriveProjectKeyDirectories(blueprint) {
  const repo = blueprint.repo || {};
  const caps = blueprint.capabilities || {};
  const rows = [];

  if (repo.layout === 'monorepo') {
    rows.push({ dir: '`apps/`', purpose: 'Application entrypoints' });
    rows.push({ dir: '`packages/`', purpose: 'Shared packages/libraries' });
    if (caps.frontend?.enabled) rows.push({ dir: '`apps/frontend/`', purpose: 'Frontend app' });
    if (caps.backend?.enabled) rows.push({ dir: '`apps/backend/`', purpose: 'Backend app/services' });
  } else {
    rows.push({ dir: '`src/`', purpose: 'Source code' });
    if (caps.frontend?.enabled) rows.push({ dir: '`src/frontend/`', purpose: 'Frontend code' });
    if (caps.backend?.enabled) rows.push({ dir: '`src/backend/`', purpose: 'Backend code' });
  }

  // Project SSOT + init archive (docs/project is used by multiple features)
  rows.push({ dir: '`docs/project/`', purpose: 'Project SSOT (blueprint, db/env ssot, init state)' });
  rows.push({ dir: '`docs/project/overview/`', purpose: 'Archived init overview (Stage A docs)' });

  return rows;
}

function parseTwoColMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return null;
  const parts = trimmed.split('|').slice(1, -1).map((s) => s.trim());
  if (parts.length < 2) return null;
  return { dirCell: parts[0], purposeCell: parts[1] };
}

function formatTwoColMarkdownTable(rows) {
  const out = [];
  out.push('| Directory | Purpose |');
  out.push('|---|---|');
  for (const r of rows) {
    out.push(`| ${r.dir} | ${r.purpose} |`);
  }
  return out;
}

function patchRootAgentsProjectInfo(repoRoot, blueprint, apply) {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { op: 'edit', path: agentsPath, mode: apply ? 'failed' : 'dry-run', reason: 'AGENTS.md not found' };
  }

  const project = blueprint.project || {};
  const repo = blueprint.repo || {};

  const raw0 = fs.readFileSync(agentsPath, 'utf8');
  const raw = normalizeMarkdownNewlines(raw0);
  let lines = raw.split('\n');

  const changes = [];

  // Replace the template intro line if it exists verbatim (keeps the rest of the template guidance).
  const templateIntro = 'This is an **AI-Friendly, Module-First Repository Template**.';
  const projectIntro = `This repository is for **${project.name || 'my-project'}** - ${project.description || 'Project description'}.`;
  const introIdx = lines.findIndex((l) => l.trim() === templateIntro);
  if (introIdx !== -1) {
    lines[introIdx] = projectIntro;
    changes.push('intro');
  }

  // Project Type (upsert)
  const projectTypeHeading = '## Project Type';
  const projectTypeBody = [`${project.name || 'my-project'} - ${project.description || 'Project description'}`];
  if (findH2Index(lines, projectTypeHeading) === -1) {
    const inserted = insertH2SectionBefore(lines, '## First Time?', projectTypeHeading, projectTypeBody);
    lines = inserted.lines;
    changes.push('projectType:insert');
  } else {
    const replaced = replaceH2SectionBody(lines, projectTypeHeading, projectTypeBody);
    lines = replaced.lines;
    if (replaced.changed) changes.push('projectType:update');
  }

  // Tech Stack (upsert)
  const techStackHeading = '## Tech Stack';
  const techRows = renderTechStackTableRows(blueprint).map((r) => ({ dir: r.area, purpose: r.choice }));
  const techBody = formatTwoColMarkdownTable(techRows).map((l) => l.replace('| Directory | Purpose |', '| Area | Choice |').replace('|---|---|', '|---|---|'));
  if (findH2Index(lines, techStackHeading) === -1) {
    const inserted = insertH2SectionBefore(lines, '## First Time?', techStackHeading, techBody);
    lines = inserted.lines;
    changes.push('techStack:insert');
  } else {
    const replaced = replaceH2SectionBody(lines, techStackHeading, techBody);
    lines = replaced.lines;
    if (replaced.changed) changes.push('techStack:update');
  }

  // Key Directories table (inject project dirs first; preserve template rows and existing custom rows)
  const keyDirsHeading = '## Key Directories';
  const keyIdx = findH2Index(lines, keyDirsHeading);
  if (keyIdx === -1) {
    changes.push('keyDirs:skip(noHeading)');
  } else {
    // Find the first markdown table under the heading
    let tableStart = -1;
    for (let i = keyIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '') continue;
      if (t.startsWith('|')) {
        tableStart = i;
        break;
      }
      if (/^##\s+/.test(t)) break;
    }

    if (tableStart === -1) {
      changes.push('keyDirs:skip(noTable)');
    } else {
      let tableEnd = tableStart;
      for (let i = tableStart; i < lines.length; i++) {
        if (!lines[i].trim().startsWith('|')) {
          tableEnd = i;
          break;
        }
        tableEnd = i + 1;
      }

      const existingRowLines = lines.slice(tableStart + 2, tableEnd);
      const existingRows = [];
      for (const l of existingRowLines) {
        const parsed = parseTwoColMarkdownTableRow(l);
        if (parsed) existingRows.push(parsed);
      }

      const templateDirDefaults = [
        { dir: '`modules/`', purpose: '**Module instances** + cross-module integration workspace' },
        { dir: '`.system/modular/`', purpose: '**Modular system SSOT** (flow graph, bindings, type graph) + derived registries/graphs' },
        { dir: '`docs/context/`', purpose: 'Context registries (project SSOT + derived aggregated view)' },
      ];

      const templateDirSet = new Set(templateDirDefaults.map((r) => stripBackticks(r.dir)));
      const projectDirDefaults = deriveProjectKeyDirectories(blueprint);
      const managedProjectDirSet = new Set(projectDirDefaults.map((r) => stripBackticks(r.dir)));

      const existingOrder = existingRows.map((r) => stripBackticks(r.dirCell));
      const existingMap = new Map();
      for (const r of existingRows) {
        const key = stripBackticks(r.dirCell);
        if (!existingMap.has(key)) existingMap.set(key, r);
      }

      const templateRows = [];
      for (const r of templateDirDefaults) {
        const key = stripBackticks(r.dir);
        const existing = existingMap.get(key);
        templateRows.push({ dir: existing ? existing.dirCell : r.dir, purpose: existing ? existing.purposeCell : r.purpose });
      }

      const otherRows = [];
      const used = new Set([...templateDirSet, ...managedProjectDirSet]);
      for (const key of existingOrder) {
        if (used.has(key)) continue;
        const r = existingMap.get(key);
        if (!r) continue;
        otherRows.push({ dir: r.dirCell, purpose: r.purposeCell });
      }

      const finalRows = [...projectDirDefaults, ...templateRows, ...otherRows];
      const newTable = formatTwoColMarkdownTable(finalRows);

      lines = [...lines.slice(0, tableStart), ...newTable, ...lines.slice(tableEnd)];
      changes.push('keyDirs:update');
    }
  }

  const next = ensureTrailingNewline(lines.join('\n'));
  const changed = next !== ensureTrailingNewline(raw);

  if (!apply) {
    return { op: 'edit', path: agentsPath, mode: 'dry-run', changed, changes, summary: `${project.name || 'my-project'} (${repo.language || 'unknown'}, ${repo.layout || 'unknown'})` };
  }

  fs.writeFileSync(agentsPath, next, 'utf8');
  return { op: 'edit', path: agentsPath, mode: 'applied', changed, changes, summary: `${project.name || 'my-project'} (${repo.language || 'unknown'}, ${repo.layout || 'unknown'})` };
}

function applyDbSsotSkillExclusions(repoRoot, blueprint, apply) {
  const mode = dbSsotMode(blueprint);
  const manifestPath = path.join(repoRoot, '.ai', 'skills', '_meta', 'sync-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { op: 'edit', path: manifestPath, mode: apply ? 'failed' : 'dry-run', note: 'manifest missing' };
  }

  const manifest = readJson(manifestPath);
  const existing = Array.isArray(manifest.excludeSkills) ? manifest.excludeSkills.map(String) : [];
  const cleaned = existing.filter((s) => s !== 'sync-db-schema-from-code' && s !== 'sync-code-schema-from-db');
  const desired = dbSsotExclusionsForMode(mode);
  manifest.excludeSkills = uniq([...cleaned, ...desired]);

  if (!apply) {
    return { op: 'edit', path: manifestPath, mode: 'dry-run', note: `excludeSkills += ${desired.join(', ')}` };
  }

  writeJson(manifestPath, manifest);
  return { op: 'edit', path: manifestPath, mode: 'applied', note: `excludeSkills += ${desired.join(', ')}` };
}

function ciProviderSkillExclusionsForProvider(provider) {
  const p = String(provider || 'github').toLowerCase();
  if (p === 'gitlab') return ['github-actions-ci'];
  if (p === 'none') return ['github-actions-ci', 'gitlab-ci'];
  // default: github
  return ['gitlab-ci'];
}

function applyCiProviderSkillExclusions(repoRoot, blueprint, apply) {
  const provider = ciProvider(blueprint);
  const manifestPath = path.join(repoRoot, '.ai', 'skills', '_meta', 'sync-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { op: 'edit', path: manifestPath, mode: apply ? 'failed' : 'dry-run', note: 'manifest missing' };
  }

  const manifest = readJson(manifestPath);
  const existing = Array.isArray(manifest.excludeSkills) ? manifest.excludeSkills.map(String) : [];
  const cleaned = existing.filter((s) => s !== 'github-actions-ci' && s !== 'gitlab-ci');
  const desired = ciProviderSkillExclusionsForProvider(provider);
  manifest.excludeSkills = uniq([...cleaned, ...desired]);

  if (!apply) {
    return { op: 'edit', path: manifestPath, mode: 'dry-run', note: `excludeSkills += ${desired.join(', ')}` };
  }

  writeJson(manifestPath, manifest);
  return { op: 'edit', path: manifestPath, mode: 'applied', note: `excludeSkills += ${desired.join(', ')}` };
}

function cleanupCiProviderArtifacts(repoRoot, blueprint, apply) {
  const provider = ciProvider(blueprint);
  const targets = [
    path.join(repoRoot, '.gitlab-ci.yml'),
    path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
    path.join(repoRoot, '.github', 'workflows', 'delivery.yml'),
    path.join(repoRoot, 'ci', 'config.json')
  ];

  if (provider !== 'none') {
    return {
      op: 'skip',
      mode: apply ? 'skipped' : 'dry-run',
      reason: `ci.provider=${provider || 'unset'}`
    };
  }

  if (!apply) {
    return {
      op: 'ci-cleanup',
      mode: 'dry-run',
      reason: 'ci.provider=none',
      targets: targets.map((p) => path.relative(repoRoot, p))
    };
  }

  const actions = [];
  let hadErrors = false;

  for (const p of targets) {
    if (!fs.existsSync(p)) continue;
    try {
      fs.rmSync(p, { force: true });
      actions.push({ op: 'rm', path: p, mode: 'applied' });
    } catch (e) {
      hadErrors = true;
      actions.push({ op: 'rm', path: p, mode: 'failed', reason: e.message });
    }
  }

  // Prune empty dirs created by CI providers (best-effort; avoids deleting unrelated files).
  const dirsToPrune = [
    path.join(repoRoot, '.github', 'workflows'),
    path.join(repoRoot, '.github'),
    path.join(repoRoot, 'ci')
  ];

  for (const dir of dirsToPrune) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (!fs.statSync(dir).isDirectory()) continue;
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) continue;
      fs.rmSync(dir, { recursive: false, force: true });
      actions.push({ op: 'rmdir', path: dir, mode: 'applied' });
    } catch (e) {
      hadErrors = true;
      actions.push({ op: 'rmdir', path: dir, mode: 'failed', reason: e.message });
    }
  }

  return {
    op: 'ci-cleanup',
    mode: hadErrors ? 'partial' : 'applied',
    reason: 'ci.provider=none',
    actions
  };
}

function refreshDbContextContract(repoRoot, blueprint, apply, verifyFeatures) {
  const outPath = path.join(repoRoot, 'docs', 'context', 'db', 'schema.json');

  // Only meaningful when context-awareness exists (contract directory + registry).
  if (!isContextAwarenessEnabled(blueprint)) {
    return {
      op: 'skip',
      path: outPath,
      mode: apply ? 'skipped' : 'dry-run',
      reason: 'context-awareness feature not enabled'
    };
  }

  if (dbSsotMode(blueprint) === 'none') {
    if (!apply) {
      return {
        op: 'skip',
        path: outPath,
        mode: 'dry-run',
        reason: 'db.ssot=none'
      };
    }

    // Best-effort cleanup: if a previous run produced the contract, remove it to honor "none".
    if (fs.existsSync(outPath)) {
      try {
        fs.rmSync(outPath, { force: true });
        return { op: 'rm', path: outPath, mode: 'applied', reason: 'db.ssot=none' };
      } catch (e) {
        return { op: 'rm', path: outPath, mode: 'failed', reason: `db.ssot=none (cleanup failed: ${e.message})` };
      }
    }

    return { op: 'skip', path: outPath, mode: 'skipped', reason: 'db.ssot=none' };
  }

  const dbSsotCtl = path.join(repoRoot, '.ai', 'scripts', 'ctl-db-ssot.mjs');
  if (!fs.existsSync(dbSsotCtl)) {
    return {
      op: 'skip',
      path: outPath,
      mode: apply ? 'failed' : 'dry-run',
      reason: 'ctl-db-ssot.mjs not found'
    };
  }

  const run1 = runNodeScript(repoRoot, dbSsotCtl, ['sync-to-context', '--repo-root', repoRoot], apply);
  const actions = [run1];

  if (verifyFeatures && apply) {
    const contextCtl = path.join(repoRoot, '.ai', 'skills', 'features', 'context-awareness', 'scripts', 'ctl-context.mjs');
    if (fs.existsSync(contextCtl)) {
      actions.push(runNodeScriptWithRepoRootFallback(repoRoot, contextCtl, ['verify', '--repo-root', repoRoot], apply));
    }
  }

  return { op: 'db-context-refresh', path: outPath, mode: apply ? 'applied' : 'dry-run', actions };
}


// ============================================================================
// Feature Detection Functions
// ============================================================================

function isDatabaseEnabled(blueprint) {
  // Provider/SSOT-driven: enabled when db.ssot != "none".
  return dbSsotMode(blueprint) !== 'none';
}

function iacTool(blueprint) {
  const iac = blueprint && blueprint.iac && typeof blueprint.iac === 'object' ? blueprint.iac : {};
  const t = String(iac.tool || '').trim().toLowerCase();
  if (!t) return 'none';
  if (t === 'none' || t === 'ros' || t === 'terraform') return t;
  // Validation should catch invalid values; default to none for safety.
  return 'none';
}

function isIacEnabled(blueprint) {
  // Provider-driven: enabled when iac.tool != "none".
  return iacTool(blueprint) !== 'none';
}

function isUiEnabled(blueprint) {
  // Default-on; can be disabled via features.ui=false
  return defaultOnFeature(blueprint, 'ui');
}

function isEnvironmentEnabled(blueprint) {
  // Default-on; can be disabled via features.environment=false
  return defaultOnFeature(blueprint, 'environment');
}

function isPackagingEnabled(blueprint) {
  // Default-on; can be disabled via features.packaging=false
  return defaultOnFeature(blueprint, 'packaging');
}

function isDeploymentEnabled(blueprint) {
  // Default-on; can be disabled via features.deployment=false
  return defaultOnFeature(blueprint, 'deployment');
}

function isReleaseEnabled(blueprint) {
  // Default-on; can be disabled via features.release=false
  return defaultOnFeature(blueprint, 'release');
}

function isObservabilityEnabled(blueprint) {
  // Default-on; can be disabled via features.observability=false
  return defaultOnFeature(blueprint, 'observability');
}

function isCiEnabled(blueprint) {
  // Provider-driven: enabled when ci.provider != "none".
  const provider = ciProvider(blueprint);
  if (!provider) return false;
  return provider !== 'none';
}

// ============================================================================
// Feature Materialization (templates + ctl scripts)
// ============================================================================

function findFeatureCtlScript(repoRoot, featureId, ctlScriptName) {
  if (!ctlScriptName) return null;

  const dash = String(featureId || '').replace(/_/g, '-');
  return path.join(repoRoot, '.ai', 'skills', 'features', dash, 'scripts', ctlScriptName);
}

function ensureFeature(repoRoot, featureId, apply, ctlScriptName, options = {}) {
  const { force = false, verify = false, stateKey } = options;
  const result = { featureId, op: 'ensure', actions: [], warnings: [], errors: [] };

  const templatesDir = findFeatureTemplatesDir(repoRoot, featureId);
  if (!templatesDir) {
    const expectedHint =
      String(featureId) === 'database'
        ? '.ai/skills/features/database/sync-code-schema-from-db/templates/'
        : `.ai/skills/features/${featureId}/templates/`;
    result.errors.push(
      `Feature "${featureId}" is enabled but templates were not found. Expected: ${expectedHint}`
    );
    return result;
  }

  const copyRes = copyDirIfMissing(templatesDir, repoRoot, apply, force);
  if (!copyRes.ok) {
    result.errors.push(copyRes.error || `Failed to copy templates for feature "${featureId}".`);
    return result;
  }
  result.actions.push({
    op: force ? 'reinstall-feature' : 'install-feature',
    featureId,
    from: templatesDir,
    to: repoRoot,
    mode: apply ? 'applied' : 'dry-run'
  });
  result.actions.push(...copyRes.actions);

  // Mark feature enabled in project state (best-effort)
  const projectStatectl = path.join(repoRoot, '.ai', 'scripts', 'ctl-project-state.mjs');
  if (fs.existsSync(projectStatectl)) {
    const key = stateKey || featureId;
    const markRes = runNodeScriptWithRepoRootFallback(
      repoRoot,
      projectStatectl,
      ['set', `features.${key}`, 'true', '--repo-root', repoRoot],
      apply
    );
    result.actions.push(markRes);
      if (apply && markRes.mode === 'failed') {
        result.warnings.push(`ctl-project-state feature flag update failed for "${featureId}" (continuing).`);
      }
  } else {
    result.warnings.push('ctl-project-state.mjs not found; skipping .ai/project feature flag update.');
  }

  // Optional: run feature controller init/verify (best-effort)
  if (ctlScriptName) {
    const ctlPath = findFeatureCtlScript(repoRoot, featureId, ctlScriptName);
    if (fs.existsSync(ctlPath)) {
      const initRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlPath, ['init', '--repo-root', repoRoot], apply);
      result.actions.push(initRes);
      if (apply && initRes.mode === 'failed') {
        result.errors.push(`Feature "${featureId}" init failed (see logs above).`);
      }
      if (verify && apply) {
        const verifyRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlPath, ['verify', '--repo-root', repoRoot], apply);
        result.actions.push(verifyRes);
        if (verifyRes.mode === 'failed') {
          result.verifyFailed = true;
          result.verifyError = `Feature "${featureId}" verify failed`;
        }
      }
    } else if (apply) {
      const expected = path.relative(repoRoot, ctlPath);
      result.errors.push(`Feature "${featureId}" control script not found: ${expected}`);
    }
  }

  return result;
}

function markProjectFeature(repoRoot, featureKey, apply) {
  const projectStatectl = path.join(repoRoot, '.ai', 'scripts', 'ctl-project-state.mjs');
  if (!fs.existsSync(projectStatectl)) {
    return { op: 'skip', path: projectStatectl, mode: apply ? 'skipped' : 'dry-run', reason: 'ctl-project-state.mjs not found' };
  }
  return runNodeScriptWithRepoRootFallback(
    repoRoot,
    projectStatectl,
    ['set', `features.${featureKey}`, 'true', '--repo-root', repoRoot],
    apply
  );
}

function runPythonScript(repoRoot, scriptPath, args, apply) {
  const fullArgs = ['-B', '-S', scriptPath, ...args];
  const candidates = ['python3', 'python'];

  const printable = `${candidates[0]} ${fullArgs.join(' ')}`;
  if (!apply) return { op: 'run', cmd: printable, mode: 'dry-run', note: 'will try python3 then python' };

  for (const cmd of candidates) {
    const res = childProcess.spawnSync(cmd, fullArgs, { stdio: childProcessStdio(), cwd: repoRoot });
    if (res.error && res.error.code === 'ENOENT') continue; // try next candidate
    if (res.status !== 0) return { op: 'run', cmd: `${cmd} ${fullArgs.join(' ')}`, mode: 'failed', exitCode: res.status };
    return { op: 'run', cmd: `${cmd} ${fullArgs.join(' ')}`, mode: 'applied' };
  }

  return { op: 'run', cmd: printable, mode: 'failed', reason: 'python interpreter not found (tried python3, python)' };
}

function ensureDatabaseFeature(repoRoot, blueprint, apply, options = {}) {
  const { force = false, verify = false } = options;
  const mode = dbSsotMode(blueprint);

  const result = {
    enabled: true,
    featureId: 'database',
    op: 'ensure',
    actions: [],
    warnings: [],
    errors: []
  };

  // Always mark enabled in project state (best-effort)
  const markRes = markProjectFeature(repoRoot, 'database', apply);
  result.actions.push(markRes);
  if (apply && markRes.mode === 'failed') {
    result.warnings.push('ctl-project-state feature flag update failed for "database" (continuing).');
  }

  if (mode === 'database') {
    // In DB SSOT mode, materialize db/ mirrors and run the DB mirror controller (feature-local).
    const res = ensureFeature(repoRoot, 'database', apply, null, { force, verify, stateKey: 'database' });
    result.actions.push(res);
    if (res.errors && res.errors.length > 0) result.errors.push(...res.errors);
    if (res.warnings && res.warnings.length > 0) result.warnings.push(...res.warnings);

    const ctlDbPath = path.join(
      repoRoot,
      '.ai',
      'skills',
      'features',
      'database',
      'sync-code-schema-from-db',
      'scripts',
      'ctl-db.mjs'
    );

    if (fs.existsSync(ctlDbPath)) {
      const initRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlDbPath, ['init', '--repo-root', repoRoot], apply);
      result.actions.push(initRes);
      if (apply && initRes.mode === 'failed') {
        result.errors.push('Database feature init failed (see logs above).');
        return result;
      }
      if (verify && apply) {
        const verifyRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlDbPath, ['verify', '--repo-root', repoRoot], apply);
        result.actions.push(verifyRes);
        if (verifyRes.mode === 'failed') {
          result.verifyFailed = true;
          result.verifyError = 'Database feature verify failed';
        }
      }
    } else if (apply) {
      result.errors.push(`Feature "database" control script not found: ${path.relative(repoRoot, ctlDbPath)}`);
    }

    return result;
  }

  if (mode === 'repo-prisma') {
    // In repo-prisma mode, do not install db/ mirrors; ensure prisma/ exists as a convention anchor.
    result.actions.push(ensureDir(path.join(repoRoot, 'prisma'), apply));
    return result;
  }

  // mode === 'none' (should be rejected by validateBlueprint when feature is enabled)
  result.warnings.push('db.ssot=none: database feature has nothing to materialize.');
  return result;
}

function ensureUiFeature(repoRoot, blueprint, apply, options = {}) {
  const { force = false, verify = false } = options;
  const result = { enabled: true, featureId: 'ui', op: 'ensure', actions: [], warnings: [], errors: [] };

  const markRes = markProjectFeature(repoRoot, 'ui', apply);
  result.actions.push(markRes);
  if (apply && markRes.mode === 'failed') {
    result.warnings.push('ctl-project-state feature flag update failed for "ui" (continuing).');
  }

  const script = path.join(repoRoot, '.ai', 'skills', 'features', 'ui', 'ui-system-bootstrap', 'scripts', 'ui_specctl.py');
  if (!fs.existsSync(script)) {
    result.errors.push(`UI feature script not found: ${path.relative(repoRoot, script)}`);
    return result;
  }

  const initArgs = ['init'];
  if (force) initArgs.push('--force');
  const initRes = runPythonScript(repoRoot, script, initArgs, apply);
  result.actions.push(initRes);
  if (apply && initRes.mode === 'failed') {
    result.errors.push('UI feature init failed (python execution failed).');
    return result;
  }

  if (verify && apply) {
    const codegenRes = runPythonScript(repoRoot, script, ['codegen'], apply);
    result.actions.push(codegenRes);
    if (codegenRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'UI feature codegen failed';
      return result;
    }
    const v = runPythonScript(repoRoot, script, ['validate'], apply);
    result.actions.push(v);
    if (v.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'UI feature verify failed';
    }
  }

  return result;
}

function ensureEnvironmentFeature(repoRoot, blueprint, apply, options = {}) {
  const { force = false, verify = false } = options;
  const result = { enabled: true, featureId: 'environment', op: 'ensure', actions: [], warnings: [], errors: [] };

  const markRes = markProjectFeature(repoRoot, 'environment', apply);
  result.actions.push(markRes);
  if (apply && markRes.mode === 'failed') {
    result.warnings.push('ctl-project-state feature flag update failed for "environment" (continuing).');
  }

  const script = path.join(repoRoot, '.ai', 'skills', 'features', 'environment', 'env-contractctl', 'scripts', 'env_contractctl.py');
  if (!fs.existsSync(script)) {
    result.errors.push(`Environment feature script not found: ${path.relative(repoRoot, script)}`);
    return result;
  }

  // init is conservative: it won't overwrite unless --force is passed.
  const initArgs = ['init', '--root', repoRoot];
  if (force) initArgs.push('--force');
  const initRes = runPythonScript(repoRoot, script, initArgs, apply);
  result.actions.push(initRes);
  if (apply && initRes.mode === 'failed') {
    result.errors.push('Environment feature init failed (python execution failed).');
    return result;
  }

  if (verify && apply) {
    const validateRes = runPythonScript(repoRoot, script, ['validate', '--root', repoRoot], apply);
    result.actions.push(validateRes);
    if (validateRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'Environment feature validate failed';
      return result;
    }
    const genRes = runPythonScript(repoRoot, script, ['generate', '--root', repoRoot], apply);
    result.actions.push(genRes);
    if (genRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'Environment feature generate failed';
    }
  }

  return result;
}

function ensureIacFeature(repoRoot, blueprint, apply, options = {}) {
  const { force = false, verify = false } = options;
  const tool = iacTool(blueprint);
  const enabled = tool !== 'none';
  const result = { enabled, featureId: 'iac', op: enabled ? 'ensure' : 'skip', actions: [], warnings: [], errors: [] };

  if (!enabled) return result;

  const markRes = markProjectFeature(repoRoot, 'iac', apply);
  result.actions.push(markRes);
  if (apply && markRes.mode === 'failed') {
    result.warnings.push('ctl-project-state feature flag update failed for "iac" (continuing).');
  }

  const templatesRoot = findFeatureTemplatesDir(repoRoot, 'iac');
  if (!templatesRoot) {
    result.errors.push('IaC feature templates not found. Expected: .ai/skills/features/iac/templates/');
    return result;
  }

  const toolTemplatesDir = path.join(templatesRoot, tool);
  if (!fs.existsSync(toolTemplatesDir) || !fs.statSync(toolTemplatesDir).isDirectory()) {
    result.errors.push(`IaC templates not found for iac.tool="${tool}". Expected: ${path.relative(repoRoot, toolTemplatesDir)}`);
    return result;
  }

  const copyRes = copyDirIfMissing(toolTemplatesDir, repoRoot, apply, force);
  if (!copyRes.ok) {
    result.errors.push(copyRes.error || `Failed to copy IaC templates for tool "${tool}".`);
    return result;
  }
  result.actions.push({
    op: force ? 'reinstall-feature' : 'install-feature',
    featureId: 'iac',
    tool,
    from: toolTemplatesDir,
    to: repoRoot,
    mode: apply ? 'applied' : 'dry-run'
  });
  result.actions.push(...copyRes.actions);

  const ctlIac = path.join(repoRoot, '.ai', 'skills', 'features', 'iac', 'scripts', 'ctl-iac.mjs');
  if (!fs.existsSync(ctlIac)) {
    result.errors.push(`IaC control script not found: ${path.relative(repoRoot, ctlIac)}`);
    return result;
  }

  const initArgs = ['init', '--tool', tool, '--repo-root', repoRoot];
  if (force) initArgs.push('--force');
  const initRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlIac, initArgs, apply);
  result.actions.push(initRes);
  if (apply && initRes.mode === 'failed') {
    result.errors.push('IaC feature init failed (see logs above).');
    return result;
  }

  if (verify && apply) {
    const verifyRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlIac, ['verify', '--repo-root', repoRoot], apply);
    result.actions.push(verifyRes);
    if (verifyRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'IaC feature verify failed';
    }
  }

  return result;
}

function ensureCiFeature(repoRoot, blueprint, apply, options = {}) {
  const { verify = false } = options;
  const enabled = isCiEnabled(blueprint);
  const result = { enabled, featureId: 'ci', op: enabled ? 'ensure' : 'skip', actions: [], warnings: [], errors: [] };

  if (!enabled) return result;

  const markRes = markProjectFeature(repoRoot, 'ci', apply);
  result.actions.push(markRes);
  if (apply && markRes.mode === 'failed') {
    result.warnings.push('ctl-project-state feature flag update failed for "ci" (continuing).');
  }

  const provider = ciProvider(blueprint);
  if (!provider) {
    result.errors.push('CI feature is enabled but ci.provider is missing/invalid. Expected: "github" or "gitlab".');
    return result;
  }

  const cictl = path.join(repoRoot, '.ai', 'skills', 'features', 'ci', 'scripts', 'ctl-ci.mjs');
  if (!fs.existsSync(cictl)) {
    result.errors.push(`CI control script not found: ${path.relative(repoRoot, cictl)}`);
    return result;
  }

  const initRes = runNodeScriptWithRepoRootFallback(repoRoot, cictl, ['init', '--provider', provider, '--repo-root', repoRoot], apply);
  result.actions.push(initRes);
  if (apply && initRes.mode === 'failed') {
    result.errors.push('CI feature init failed (see logs above).');
    return result;
  }

  if (verify && apply) {
    const verifyRes = runNodeScriptWithRepoRootFallback(repoRoot, cictl, ['verify', '--repo-root', repoRoot], apply);
    result.actions.push(verifyRes);
    if (verifyRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'CI feature verify failed';
    }
  }

  return result;
}

function ensureContextAwarenessFeature(repoRoot, blueprint, apply, options = {}) {
  const { force = false, verify = false } = options;
  const enabled = isContextAwarenessEnabled(blueprint);
  const result = {
    enabled,
    featureId: 'context-awareness',
    op: enabled ? 'ensure' : 'skip',
    actions: [],
    warnings: [],
    errors: []
  };

  if (!enabled) return result;

  const templatesDir = findFeatureTemplatesDir(repoRoot, 'context-awareness');
  if (!templatesDir) {
    result.errors.push('Context awareness is enabled, but feature templates were not found.');
    return result;
  }

  const copyRes = copyDirIfMissing(templatesDir, repoRoot, apply, force);
  if (!copyRes.ok) {
    result.errors.push(copyRes.error || 'Failed to copy context-awareness templates.');
    return result;
  }

  result.actions.push({
    op: force ? 'reinstall-feature' : 'install-feature',
    featureId: 'context-awareness',
    from: templatesDir,
    to: repoRoot,
    mode: apply ? 'applied' : 'dry-run'
  });
  result.actions.push(...copyRes.actions);

  const ctlContext = path.join(repoRoot, '.ai', 'skills', 'features', 'context-awareness', 'scripts', 'ctl-context.mjs');
  const projectStatectl = path.join(repoRoot, '.ai', 'scripts', 'ctl-project-state.mjs');

  if (!fs.existsSync(ctlContext)) {
    result.errors.push('ctl-context.mjs not found under .ai/skills/features/context-awareness/scripts/.');
    return result;
  }

  // Ensure project state exists and mark flags
  if (fs.existsSync(projectStatectl)) {
    const initRes = runNodeScriptWithRepoRootFallback(repoRoot, projectStatectl, ['init', '--repo-root', repoRoot], apply);
    result.actions.push(initRes);
    if (apply && initRes.mode === 'failed') result.warnings.push('ctl-project-state init failed (continuing).');

    const featureFlagRes = runNodeScriptWithRepoRootFallback(
      repoRoot,
      projectStatectl,
      ['set', 'features.contextAwareness', 'true', '--repo-root', repoRoot],
      apply
    );
    result.actions.push(featureFlagRes);
    if (apply && featureFlagRes.mode === 'failed') result.warnings.push('ctl-project-state set features.contextAwareness failed (continuing).');

    const enabledRes = runNodeScriptWithRepoRootFallback(repoRoot, projectStatectl, ['set', 'context.enabled', 'true', '--repo-root', repoRoot], apply);
    result.actions.push(enabledRes);
    if (apply && enabledRes.mode === 'failed') result.warnings.push('ctl-project-state set context.enabled failed (continuing).');

    const mode = getContextMode(blueprint);
    const modeRes = runNodeScriptWithRepoRootFallback(repoRoot, projectStatectl, ['set-context-mode', mode, '--repo-root', repoRoot], apply);
    result.actions.push(modeRes);
    if (apply && modeRes.mode === 'failed') result.warnings.push('ctl-project-state set-context-mode failed (continuing).');
  } else {
    result.warnings.push('ctl-project-state.mjs not found; skipping project state initialization.');
  }

  // Initialize docs/context skeleton and registry (idempotent)
  const initRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlContext, ['init', '--repo-root', repoRoot], apply);
  result.actions.push(initRes);
  if (apply && initRes.mode === 'failed') {
    result.errors.push('Context awareness init failed (see logs above).');
    return result;
  }

  // Generate api-index from module/project OpenAPI files (ensures committed state matches CI-regenerated state)
  if (apply) {
    const apiIndexCtl = path.join(repoRoot, '.ai', 'scripts', 'ctl-api-index.mjs');
    if (fs.existsSync(apiIndexCtl)) {
      const genRes = runNodeScriptWithRepoRootFallback(repoRoot, apiIndexCtl, ['generate', '--touch'], true);
      result.actions.push(genRes);
      if (genRes.mode === 'failed') {
        result.warnings.push('ctl-api-index generate failed after init (api-index may be stale).');
      }
    }
  }

  // Compute checksums for any artifacts that lack them (template ships without checksums)
  if (apply) {
    const touchRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlContext, ['touch', '--repo-root', repoRoot], true);
    result.actions.push(touchRes);
    if (touchRes.mode === 'failed') {
      result.warnings.push('ctl-context touch failed after init (checksums may be stale).');
    }
  }

  // Optional verify
  if (verify && apply) {
    const verifyRes = runNodeScriptWithRepoRootFallback(repoRoot, ctlContext, ['verify', '--repo-root', repoRoot], apply);
    result.actions.push(verifyRes);
    if (verifyRes.mode === 'failed') {
      result.verifyFailed = true;
      result.verifyError = 'Context awareness verify failed';
    }
  }

  return result;
}


function planScaffold(repoRoot, blueprint, apply) {
  const results = [];
  const repo = blueprint.repo || {};
  const caps = blueprint.capabilities || {};
  const layout = repo.layout;
  const initPaths = resolveInitPaths(repoRoot);

  // Always ensure docs directory exists (for blueprint and optional archived docs)
  results.push(ensureDir(path.join(repoRoot, 'docs'), apply));
  results.push(ensureDir(path.join(repoRoot, 'docs', 'project'), apply));

  // Create init/_work/stage-a-docs/ and copy Stage A templates
  results.push(ensureDir(initPaths.docsRoot, apply));
  const stage_a_templates = [
    { src: 'requirements.template.md', dest: 'requirements.md' },
    { src: 'non-functional-requirements.template.md', dest: 'non-functional-requirements.md' },
    { src: 'domain-glossary.template.md', dest: 'domain-glossary.md' },
    { src: 'risk-open-questions.template.md', dest: 'risk-open-questions.md' }
  ];
  for (const t of stage_a_templates) {
    const srcPath = path.join(TEMPLATES_DIR, t.src);
    const destPath = path.join(initPaths.docsRoot, t.dest);
    results.push(copyFileIfMissing(srcPath, destPath, apply));
  }

  if (layout === 'monorepo') {
    results.push(ensureDir(path.join(repoRoot, 'apps'), apply));
    results.push(ensureDir(path.join(repoRoot, 'packages'), apply));

    if (caps.frontend && caps.frontend.enabled) {
      results.push(ensureDir(path.join(repoRoot, 'apps', 'frontend'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'apps', 'frontend', 'README.md'),
        '# Frontend app\n\nThis folder is a scaffold placeholder. Populate it based on your selected frontend stack.\n',
        apply
      ));
    }

    if (caps.backend && caps.backend.enabled) {
      results.push(ensureDir(path.join(repoRoot, 'apps', 'backend'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'apps', 'backend', 'README.md'),
        '# Backend app\n\nThis folder is a scaffold placeholder. Populate it based on your selected backend stack.\n',
        apply
      ));
    }

    // Shared packages are optional, but commonly needed
    results.push(ensureDir(path.join(repoRoot, 'packages', 'shared'), apply));
    results.push(writeFileIfMissing(
      path.join(repoRoot, 'packages', 'shared', 'README.md'),
      '# Shared package\n\nThis folder is a scaffold placeholder for shared types/utilities.\n',
      apply
    ));
  } else {
    results.push(ensureDir(path.join(repoRoot, 'src'), apply));

    if (caps.frontend && caps.frontend.enabled) {
      results.push(ensureDir(path.join(repoRoot, 'src', 'frontend'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'src', 'frontend', 'README.md'),
        '# Frontend\n\nThis folder is a scaffold placeholder. Populate it based on your selected frontend stack.\n',
        apply
      ));
    }

    if (caps.backend && caps.backend.enabled) {
      results.push(ensureDir(path.join(repoRoot, 'src', 'backend'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'src', 'backend', 'README.md'),
        '# Backend\n\nThis folder is a scaffold placeholder. Populate it based on your selected backend stack.\n',
        apply
      ));
    }
  }


  // Optional: Ops scaffolding (packaging/deploy conventions)
  // Notes:
  // - Feature templates can also materialize these paths (non-destructive copy-if-missing).
  // - CI alone should not create `ops/packaging` or `ops/deploy`.
  const wantsPackaging = isPackagingEnabled(blueprint);
  const wantsDeployment = isDeploymentEnabled(blueprint);
  const wantsIac = isIacEnabled(blueprint);

  if (wantsPackaging || wantsDeployment || wantsIac) {
    results.push(ensureDir(path.join(repoRoot, 'ops'), apply));
    results.push(writeFileIfMissing(
      path.join(repoRoot, 'ops', 'README.md'),
      `# Ops

This folder holds DevOps-oriented configuration and handbook material.

High-level split (created only when enabled):
- ops/packaging/  Build artifacts (often container images for services)
- ops/deploy/     Run artifacts in environments (deploy/rollback/runbooks)
- ops/iac/        Infrastructure as Code (provisioning, identity, and infra runbooks)

Guidelines:
- Keep definitions small and structured.
- Prefer a small number of scripts as execution entry points.
- Record decisions and history under ops/*/handbook/.
`,
      apply
    ));

    // Packaging (services, jobs, apps)
    if (wantsPackaging) {
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging', 'services'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging', 'jobs'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging', 'apps'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging', 'scripts'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'packaging', 'handbook'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'packaging', 'README.md'),
        `# Packaging

Goal: turn code into runnable artifacts.

Repository layout:
- ops/packaging/services/   Packaging definitions per HTTP service
- ops/packaging/jobs/       Packaging definitions per workload/job
- ops/packaging/apps/       Packaging definitions per client/distribution app
- ops/packaging/scripts/    Shared build scripts (preferred entry points)
- ops/packaging/handbook/   Plans, checklists, and build records

Guidelines:
- Keep definitions small and structured.
- For services, container images are a common packaging target.
- Treat artifact naming, versioning, and provenance as first-class.
`,
        apply
      ));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'packaging', 'handbook', 'README.md'),
        `# Packaging handbook

Use this folder for:
- Packaging plans (inputs, outputs, artifact naming)
- Build checklists
- Build logs (what was built, when, from which revision, by whom)
`,
        apply
      ));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'packaging', 'scripts', 'build.mjs'),
        `#!/usr/bin/env node
/**
 * build.mjs (placeholder)
 *
 * Provider-agnostic packaging entry.
 * Extend it to build artifacts for your services/jobs/apps.
 */

console.log("[todo] Implement packaging build pipeline for this repo.");
process.exit(0);
`,
        apply
      ));
    }

    // Deploy (http services, workloads, clients)
    if (wantsDeployment) {
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy', 'http_services'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy', 'workloads'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy', 'clients'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy', 'scripts'), apply));
      results.push(ensureDir(path.join(repoRoot, 'ops', 'deploy', 'handbook'), apply));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'deploy', 'README.md'),
        `# Deploy

Goal: take packaged artifacts and run them in target environments.

Repository layout:
- ops/deploy/http_services/  Deployment descriptors for long-running services
- ops/deploy/workloads/      Deployment descriptors for jobs/event-driven workloads
- ops/deploy/clients/        Deployment descriptors for client apps (web/mobile/desktop)
- ops/deploy/scripts/        Shared deploy/rollback scripts (preferred entry points)
- ops/deploy/handbook/       Runbooks and deployment history

Guidelines:
- Capture environment-specific parameters explicitly.
- Keep rollback paths documented and tested.
`,
        apply
      ));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'deploy', 'handbook', 'README.md'),
        `# Deploy handbook

Use this folder for:
- Environment definitions (dev/stage/prod)
- Runbooks (how to deploy, verify, rollback)
- Postmortems and deployment incident notes
`,
        apply
      ));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'deploy', 'scripts', 'deploy.mjs'),
        `#!/usr/bin/env node
/**
 * deploy.mjs (placeholder)
 *
 * Provider-agnostic deployment entry.
 * Extend it to apply your chosen deployment model and platform.
 */

console.log("[todo] Implement deployment automation for this repo.");
process.exit(0);
`,
        apply
      ));
      results.push(writeFileIfMissing(
        path.join(repoRoot, 'ops', 'deploy', 'scripts', 'rollback.mjs'),
        `#!/usr/bin/env node
/**
 * rollback.mjs (placeholder)
 *
 * Provider-agnostic rollback entry.
 */

console.log("[todo] Implement rollback procedure for this repo.");
process.exit(0);
`,
        apply
      ));
    }
  }


  return results;
}

function updateManifest(repoRoot, blueprint, apply) {
  // When ctl-skillpacks is available, pack switching should go through .ai/skills/_meta/ctl-skillpacks.mjs (scheme A).
  // When ctl-skillpacks is not available, fall back to a flat sync-manifest.json update (additive; never removes).
  const manifestPath = path.join(repoRoot, '.ai', 'skills', '_meta', 'sync-manifest.json');
  const ctlSkillpacksPath = path.join(repoRoot, '.ai', 'skills', '_meta', 'ctl-skillpacks.mjs');

  const warnings = [];
  const errors = [];

  const packsFromBlueprint = normalizePackList((blueprint.skills && blueprint.skills.packs) || []);
  const packs = new Set(packsFromBlueprint);

  // Note: packs are optional; features and packs are independent toggles.

  const packList = Array.from(packs);

  if (packList.length === 0) {
    return { op: 'skip', path: manifestPath, mode: apply ? 'applied' : 'dry-run', warnings, note: 'no packs requested' };
  }

  // Prefer ctl-skillpacks if available
  if (fs.existsSync(ctlSkillpacksPath)) {
    // Preflight: ensure pack files exist (more actionable than letting ctl-skillpacks fail mid-run).
    for (const p of packList) {
      const packFile = path.join(repoRoot, '.ai', 'skills', '_meta', 'packs', `${p}.json`);
      if (!fs.existsSync(packFile)) {
        errors.push(`Pack "${p}" is requested, but pack file is missing: ${path.relative(repoRoot, packFile)}`);
      }
    }

    if (errors.length > 0) {
      return { op: 'ctl-skillpacks', path: ctlSkillpacksPath, mode: 'failed', errors, warnings, packs: packList };
    }

    const actions = [];
    for (const p of packList) {
      const cmd = 'node';
      const args = [ctlSkillpacksPath, 'enable-pack', p, '--repo-root', repoRoot, '--no-sync'];
      const printable = `${cmd} ${args.join(' ')}`;

      if (!apply) {
        actions.push({ op: 'run', cmd: printable, mode: 'dry-run' });
        continue;
      }

      const res = childProcess.spawnSync(cmd, args, { stdio: childProcessStdio(), cwd: repoRoot });
      if (res.status !== 0) {
        return { op: 'ctl-skillpacks', path: ctlSkillpacksPath, mode: 'failed', exitCode: res.status, packs: packList, warnings };
      }
      actions.push({ op: 'run', cmd: printable, mode: 'applied' });
    }

    // Read effective manifest (if present) for reporting
    let effective = null;
    if (fs.existsSync(manifestPath)) {
      try { effective = readJson(manifestPath); } catch {}
    }

    return { op: 'ctl-skillpacks', path: manifestPath, mode: apply ? 'applied' : 'dry-run', warnings, packs: packList, actions, effectiveManifest: effective };
  }

  // Fallback: update flat manifest directly (additive; safe for basic repos)
  let manifest;
  if (fs.existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
  } else {
    manifest = { version: 1, includePrefixes: [], includeSkills: [], excludeSkills: [] };
  }

  if (!Array.isArray(manifest.includePrefixes)) manifest.includePrefixes = [];
  if (!Array.isArray(manifest.includeSkills)) manifest.includeSkills = [];
  if (!Array.isArray(manifest.excludeSkills)) manifest.excludeSkills = [];

  const prefixMap = packPrefixMap();
  const prefixesToAdd = [];
  for (const p of packList) {
    const prefix = prefixMap[p];
    if (!prefix) {
      warnings.push(`Pack "${p}" has no prefix mapping and ctl-skillpacks is not available; skipping.`);
      continue;
    }
    prefixesToAdd.push(prefix);
  }

  manifest.includePrefixes = uniq([...manifest.includePrefixes, ...prefixesToAdd]);

  if (!apply) {
    return { op: 'write', path: manifestPath, mode: 'dry-run', warnings, includePrefixes: manifest.includePrefixes, packs: packList };
  }

  writeJson(manifestPath, manifest);
  return { op: 'write', path: manifestPath, mode: 'applied', warnings, includePrefixes: manifest.includePrefixes, packs: packList };
}



function syncWrappers(repoRoot, providers, apply) {
  const scriptPath = path.join(repoRoot, '.ai', 'scripts', 'sync-skills.mjs');
  if (!fs.existsSync(scriptPath)) {
    return { op: 'skip', path: scriptPath, reason: 'sync-skills.mjs not found' };
  }
  const providersArg = providers || 'both';
  const cmd = 'node';
  const args = [scriptPath, '--scope', 'current', '--providers', providersArg, '--mode', 'reset', '--yes'];

  if (!apply) return { op: 'run', cmd: `${cmd} ${args.join(' ')}`, mode: 'dry-run' };

  const res = childProcess.spawnSync(cmd, args, { stdio: childProcessStdio(), cwd: repoRoot });
  if (res.status !== 0) {
    return { op: 'run', cmd: `${cmd} ${args.join(' ')}`, mode: 'failed', exitCode: res.status };
  }
  return { op: 'run', cmd: `${cmd} ${args.join(' ')}`, mode: 'applied' };
}

function runModularCoreBuild(repoRoot, apply) {
  const result = { op: 'modular-core-build', mode: apply ? 'applied' : 'dry-run', actions: [], warnings: [], errors: [] };

  const ctlFlow = path.join(repoRoot, '.ai', 'scripts', 'modules', 'ctl-flow.mjs');
  const ctlModule = path.join(repoRoot, '.ai', 'scripts', 'modules', 'ctl-module.mjs');
  const ctlIntegration = path.join(repoRoot, '.ai', 'scripts', 'modules', 'ctl-integration.mjs');
  const ctlContext = path.join(repoRoot, '.ai', 'skills', 'features', 'context-awareness', 'scripts', 'ctl-context.mjs');

  const steps = [
    { id: 'ctl-flow.init', scriptPath: ctlFlow, args: ['init', '--repo-root', repoRoot] },
    { id: 'ctl-integration.init', scriptPath: ctlIntegration, args: ['init', '--repo-root', repoRoot] },
    { id: 'ctl-module.registry-build', scriptPath: ctlModule, args: ['registry-build', '--repo-root', repoRoot] },
    { id: 'ctl-flow.update-from-manifests', scriptPath: ctlFlow, args: ['update-from-manifests', '--repo-root', repoRoot] },
    { id: 'ctl-flow.lint', scriptPath: ctlFlow, args: ['lint', '--repo-root', repoRoot] },
    { id: 'ctl-flow.graph', scriptPath: ctlFlow, args: ['graph', '--repo-root', repoRoot] },
    { id: 'ctl-integration.validate', scriptPath: ctlIntegration, args: ['validate', '--repo-root', repoRoot] },
    { id: 'ctl-context.build', scriptPath: ctlContext, args: ['build', '--repo-root', repoRoot] }
  ];

  for (const step of steps) {
    if (!fs.existsSync(step.scriptPath)) {
      result.errors.push(`Missing modular build script: ${path.relative(repoRoot, step.scriptPath)}`);
      result.actions.push({ op: 'skip', step: step.id, path: step.scriptPath, reason: 'script not found', mode: 'skipped' });
      continue;
    }

    const res = runNodeScriptWithRepoRootFallback(repoRoot, step.scriptPath, step.args, apply);
    res.step = step.id;
    result.actions.push(res);
    if (apply && res.mode === 'failed') {
      result.errors.push(`Modular build step failed: ${step.id}`);
    }
  }

  if (apply && result.errors.length > 0) result.mode = 'failed';
  return result;
}

function cleanupInit(repoRoot, apply) {
  const initDir = path.join(repoRoot, 'init');
  const marker = findInitKitMarker(repoRoot);

  if (!fs.existsSync(initDir)) return { op: 'skip', path: initDir, reason: 'init/ not present' };
  if (!marker) return { op: 'refuse', path: initDir, reason: 'missing init kit marker' };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(repoRoot, `.init-trash-${ts}`);

  if (!apply) {
    return { op: 'rm', path: initDir, mode: 'dry-run', note: `will move to ${path.basename(trashDir)} then delete` };
  }

  // Move first (reduces risk if delete fails on Windows due to open file handles)
  fs.renameSync(initDir, trashDir);

  try {
    fs.rmSync(trashDir, { recursive: true, force: true });
    return { op: 'rm', path: initDir, mode: 'applied' };
  } catch (e) {
    return {
      op: 'rm',
      path: initDir,
      mode: 'partial',
      note: `renamed to ${path.basename(trashDir)} but could not delete automatically: ${e.message}`
    };
  }
}


function main() {
  const { command, opts } = parseArgs(process.argv);
  const format = (opts['format'] || 'text').toLowerCase();
  setOutputFormat(format);

  const repoRoot = path.resolve(opts['repo-root'] || process.cwd());
  const initPaths = resolveInitPaths(repoRoot);
  const blueprintPath = resolvePath(repoRoot, opts['blueprint'] || initPaths.blueprintPath);
  const docsRoot = resolvePath(repoRoot, opts['docs-root'] || initPaths.docsRoot);
  if (blueprintPath) ensurePathWithinRepo(repoRoot, blueprintPath, 'blueprint');
  if (docsRoot) ensurePathWithinRepo(repoRoot, docsRoot, 'docs-root');

  // Auto-sync the init entry docs (write-if-changed):
  // - Creates `init/START-HERE.md` and `init/INIT-BOARD.md` only after `state.outputLanguage` is set.
  // - Updates the machine snapshot block inside `init/INIT-BOARD.md` after each pipeline command.
  process.on('exit', () => {
    try {
      syncInitBoard({ repoRoot, docsRoot, blueprintPath });
    } catch {
      // Never fail the command due to board rendering.
    }
  });

	  // ========== start ==========
	  if (command === 'start') {
    const existingState = loadState(repoRoot);
    if (existingState) {
      console.log('[info] Existing init state detected');
      printStatus(existingState, repoRoot);
      console.log(`[info] To restart, delete ${path.relative(repoRoot, getStatePath(repoRoot))} first`);
      process.exit(0);
    }

    const state = createInitialState();
    addHistoryEvent(state, 'init_started', 'Initialization started');
    saveState(repoRoot, state);

	    const initPaths = resolveInitPaths(repoRoot);

	    // Create workspace guide (copy-if-missing)
	    const workAgentsRes = ensureWorkAgents(repoRoot, true);
	    if (workAgentsRes.mode === 'applied') {
	      console.log(`[ok] Workspace guide created: ${path.relative(repoRoot, workAgentsRes.path)}`);
	    }

	    // Auto-create Stage A docs templates
	    const stage_a_docs_dir = initPaths.docsRoot;
	    fs.mkdirSync(stage_a_docs_dir, { recursive: true });
    const stage_a_templates = [
      { src: 'requirements.template.md', dest: 'requirements.md' },
      { src: 'non-functional-requirements.template.md', dest: 'non-functional-requirements.md' },
      { src: 'domain-glossary.template.md', dest: 'domain-glossary.md' },
      { src: 'risk-open-questions.template.md', dest: 'risk-open-questions.md' }
    ];
    const createdFiles = [];
    for (const t of stage_a_templates) {
      const srcPath = path.join(TEMPLATES_DIR, t.src);
      const destPath = path.join(stage_a_docs_dir, t.dest);
      if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        createdFiles.push(t.dest);
      }
    }

    // Auto-create blueprint template
    const blueprintTemplateSrc = path.join(TEMPLATES_DIR, 'project-blueprint.min.example.json');
    const blueprintDest = initPaths.blueprintPath;
    let blueprintCreated = false;
    if (fs.existsSync(blueprintTemplateSrc) && !fs.existsSync(blueprintDest)) {
      fs.copyFileSync(blueprintTemplateSrc, blueprintDest);
      blueprintCreated = true;
    }

    console.log(`[ok] Init state created: ${path.relative(repoRoot, getStatePath(repoRoot))}`);
    if (createdFiles.length > 0) {
      console.log(`[ok] Stage A doc templates created: ${path.relative(repoRoot, stage_a_docs_dir)}/`);
      for (const f of createdFiles) {
        console.log(`     - ${f}`);
      }
    }
    if (blueprintCreated) {
      console.log(`[ok] Blueprint template created: ${path.relative(repoRoot, blueprintDest)}`);
    }
	    printStatus(state, repoRoot);
	    process.exit(0);
	  }

  // ========== status ==========
  if (command === 'status') {
    const state = loadState(repoRoot);
    if (!state) {
      console.log('[info] No init state found');
      console.log('[info] Run the \"start\" command to begin initialization');
      process.exit(0);
    }

    if (format === 'json') {
      console.log(JSON.stringify(getStageProgress(state), null, 2));
    } else {
      printStatus(state, repoRoot);
    }
    process.exit(0);
  }

    // ========== advance ==========
  if (command === 'advance') {
    const state = loadState(repoRoot);
    if (!state) {
      die('[error] No init state found. Run the \"start\" command first.');
    }

    const progress = getStageProgress(state);
    const stage_a = progress['stage-a'] || {};
    const stage_b = progress['stage-b'] || {};
    const stage_c = progress['stage-c'] || {};
    const self = path.relative(repoRoot, __filename);
    const docsRel = path.relative(repoRoot, docsRoot);
    const bpRel = blueprintPath ? path.relative(repoRoot, blueprintPath) : 'init/_work/project-blueprint.json';
    const retentionRel = path.relative(repoRoot, resolveInitPaths(repoRoot).skillRetentionPath);

    if (progress.stage === 'A') {
      if (!stage_a.validated) {
        console.log('[info] Stage A docs have not passed structural validation.');
        console.log('Run first:');
        console.log(`  node ${self} check-docs --docs-root ${docsRel} --strict`);
        process.exit(1);
      }
      const missingMustAsk = getMissingMustAskKeys(state['stage-a']);
      if (missingMustAsk.length > 0) {
        console.log('[info] Stage A docs passed validation, but the must-ask checklist is not complete.');
        console.log(`Missing keys: ${missingMustAsk.join(', ')}`);
        console.log('');
        console.log('Fix: ask the missing questions, write conclusions into Stage A docs, then run mark-must-ask for each key.');
        console.log('Example:');
        console.log(`  node ${self} mark-must-ask --repo-root ${repoRoot} --key <key> --asked --answered --written-to <path>`);
        console.log('');
        console.log('Override (not recommended): approve Stage A with --skip-must-ask:');
        console.log(`  node ${self} approve --stage A --repo-root ${repoRoot} --skip-must-ask`);
        process.exit(1);
      }
      console.log('\n== Stage A -> B Checkpoint ==\n');
      console.log('Stage A docs passed validation. Next: the user must review and explicitly approve.');
      console.log('After approval, run:');
      console.log(`  node ${self} approve --stage A --repo-root ${repoRoot}`);
      process.exit(0);
    }

	    if (progress.stage === 'B') {
	      if (!stage_b.validated) {
	        console.log('[info] Stage B blueprint has not been validated.');
	        console.log('Run first:');
	        console.log(`  node ${self} validate --blueprint ${bpRel}`);
	        process.exit(1);
	      }
      console.log('\n== Stage B -> C Checkpoint ==\n');
      console.log('Stage B blueprint passed validation. Next: the user must review and explicitly approve.');
      console.log('After approval, run:');
      console.log(`  node ${self} approve --stage B --repo-root ${repoRoot}`);
      process.exit(0);
    }

	    if (progress.stage === 'C') {
	      if (!stage_c.wrappersSynced) {
	        console.log('[info] Stage C is not complete (wrappers not synced).');
	        console.log('Run first:');
	        console.log(`  node ${self} apply --blueprint ${bpRel}`);
	        process.exit(1);
	      }

      if (!stage_c.skillRetentionReviewed) {
        console.log('[info] Stage C is not complete (skill retention not reviewed).');
        console.log('Next (required):');
        console.log(`  - Fill: ${retentionRel}`);
        console.log('  - If deleting skills: node .ai/scripts/sync-skills.mjs --dry-run --delete-skills \"<csv>\"');
        console.log('    Then: node .ai/scripts/sync-skills.mjs --delete-skills \"<csv>\" --yes');
        console.log('    Then: node .ai/scripts/sync-skills.mjs --scope current --providers both --mode reset --yes');
        console.log('  - Record review:');
        console.log(`    node ${self} review-skill-retention --repo-root ${repoRoot}`);
        console.log('');
        console.log('After review, re-run:');
        console.log(`  node ${self} advance --repo-root ${repoRoot}`);
        process.exit(1);
      }

      console.log('\n== Stage C Completion Checkpoint ==\n');
      console.log('Stage C completed (scaffold + skills written + skill retention reviewed).');
      
      if (!stage_c.agentsUpdated) {
        console.log('\n** Required: Update AGENTS.md with project-specific info **');
        console.log('This ensures LLMs see your project context in future sessions.\n');
        console.log('Run:');
        console.log(`  node ${self} update-agents --blueprint ${bpRel} --repo-root ${repoRoot} --apply`);
        console.log('\nOr skip (not recommended):');
        console.log(`  node ${self} approve --stage C --repo-root ${repoRoot} --skip-agents-update`);
      } else {
        console.log('\nNext: user confirmation that scaffold and enabled capabilities match expectations.');
        console.log('After confirmation, run:');
        console.log(`  node ${self} approve --stage C --repo-root ${repoRoot}`);
      }
      console.log('\nOptional: later run cleanup-init --apply --i-understand to remove the init/ directory');
      process.exit(0);
    }

    console.log('[info] Initialization completed (state.stage = complete)');
    process.exit(0);
  }



    // ========== approve ==========
	  if (command === 'approve') {
	    const state = loadState(repoRoot);
	    if (!state) {
	      die('[error] No init state found. Run the \"start\" command first.');
	    }

    const current = String(state.stage || '').toUpperCase();
    const desired = String(opts['stage'] || current).toUpperCase();
    const note = opts['note'] ? String(opts['note']) : '';

    if (!['A', 'B', 'C', 'COMPLETE'].includes(desired)) {
      die('[error] --stage must be one of: A | B | C');
    }

    if (desired !== current) {
      die(`[error] Current stage=${state.stage}; cannot approve stage=${desired}. Run status to confirm, or omit --stage.`);
    }

    if (desired === 'A') {
      if (!state['stage-a']?.validated) {
        die('[error] Stage A is not validated. Run check-docs first.');
      }
      if (!opts['skip-must-ask']) {
        const missing = getMissingMustAskKeys(state['stage-a']);
        if (missing.length > 0) {
          die(
            '[error] Stage A approval requires the must-ask checklist to be complete (asked + answered + written-to).\n' +
              `Missing keys: ${missing.join(', ')}\n` +
              'Fix: ask the missing questions, write conclusions into Stage A docs, then run mark-must-ask for each key.\n' +
              'Override (not recommended): re-run approve with --skip-must-ask.'
          );
        }
      }
		      state['stage-a'].userApproved = true;
		      state.stage = 'B';
		      addHistoryEvent(state, 'stage_a_approved', note || 'Stage A approved by user');
		      saveState(repoRoot, state);
		      printStatus(state, repoRoot);
	      process.exit(0);
	    }

	    if (desired === 'B') {
	      if (!state['stage-b']?.validated) {
	        die('[error] Stage B is not validated. Run validate first.');
	      }
	      state['stage-b'].userApproved = true;
	      state.stage = 'C';
	      addHistoryEvent(state, 'stage_b_approved', note || 'Stage B approved by user');
	      saveState(repoRoot, state);
	      printStatus(state, repoRoot);
	      process.exit(0);
	    }

	    if (desired === 'C') {
	      if (!state['stage-c']?.wrappersSynced) {
	        die('[error] Stage C is not complete. Run apply first.');
	      }
	      if (!state['stage-c']?.skillRetentionReviewed) {
	        die('[error] Skill retention not reviewed. Run review-skill-retention first.');
	      }
	      if (!opts['skip-agents-update'] && !state['stage-c']?.agentsUpdated) {
	        die(
	          '[error] AGENTS.md has not been updated with project-specific info.\n' +
	          'This ensures LLMs see your project context, not just the generic template description.\n\n' +
	          'Option 1 (recommended): Run update-agents to update AGENTS.md:\n' +
	          `  node ${path.relative(repoRoot, __filename)} update-agents --repo-root ${repoRoot} --apply\n\n` +
	          'Option 2: Skip this step (not recommended):\n' +
	          `  node ${path.relative(repoRoot, __filename)} approve --stage C --repo-root ${repoRoot} --skip-agents-update`
	        );
	      }
	      state['stage-c'].userApproved = true;
	      state.stage = 'complete';
	      addHistoryEvent(state, 'init_completed', note || 'Initialization completed');
	      saveState(repoRoot, state);
	      printStatus(state, repoRoot);
        process.exit(0);
      }

    console.log('[info] Already complete; no need to approve again');
    process.exit(0);
  }

if (command === 'validate') {
    if (!blueprintPath) die('[error] --blueprint is required for validate');
    const blueprint = readJson(blueprintPath);
    const v = validateBlueprint(blueprint);

    // Auto-update state if validation passes (only when it would change state)
    if (v.ok) {
      const state = loadState(repoRoot);
      const canonical = path.resolve(blueprintPath) === path.resolve(resolveInitPaths(repoRoot).blueprintPath);
      if (state && state.stage === 'B' && canonical) {
        let changed = false;
        if (!state['stage-b']) state['stage-b'] = {};
        if (state['stage-b'].drafted !== true) {
          state['stage-b'].drafted = true;
          changed = true;
        }
        if (state['stage-b'].validated !== true) {
          state['stage-b'].validated = true;
          changed = true;
        }
        if (changed) {
          addHistoryEvent(state, 'stage_b_validated', 'Stage B blueprint validated');
          saveState(repoRoot, state);
          console.log('[auto] State updated: stage-b.validated = true');
        } else {
          console.log('[auto] State unchanged: stage-b already validated');
        }
      } else if (state && state.stage === 'B' && !canonical) {
        console.log('[warn] Blueprint validated, but state was not updated because --blueprint overrides the canonical init blueprint path.');
      }
    }

    const result = {
      ok: v.ok,
      packs: v.packs,
      errors: v.errors,
      warnings: v.warnings,
      summary: v.ok
        ? `[ok] Blueprint is valid: ${path.relative(repoRoot, blueprintPath)}`
        : `[error] Blueprint validation failed: ${path.relative(repoRoot, blueprintPath)}`
    };
    printResult(result, format);
    process.exit(v.ok ? 0 : 1);
  }

  if (command === 'check-docs') {
    const strict = !!opts['strict'];
    const res = checkDocs(docsRoot);

    const ok = res.ok && (!strict || res.warnings.length === 0);
    const summary = ok
      ? `[ok] Stage A docs check passed: ${path.relative(repoRoot, docsRoot)}`
      : `[error] Stage A docs check failed: ${path.relative(repoRoot, docsRoot)}`;

    // Auto-update state if validation passes (only when it would change state)
    if (ok) {
      const state = loadState(repoRoot);
      const canonical = path.resolve(docsRoot) === path.resolve(resolveInitPaths(repoRoot).docsRoot);
      if (state && state.stage === 'A' && canonical) {
        let changed = false;
        if (!state['stage-a']) state['stage-a'] = {};

        if (state['stage-a'].validated !== true) {
          state['stage-a'].validated = true;
          changed = true;
        }

        const nextDocsWritten = {
          requirements: fs.existsSync(path.join(docsRoot, 'requirements.md')),
          nfr: fs.existsSync(path.join(docsRoot, 'non-functional-requirements.md')),
          glossary: fs.existsSync(path.join(docsRoot, 'domain-glossary.md')),
          riskQuestions: fs.existsSync(path.join(docsRoot, 'risk-open-questions.md'))
        };

        const prevDocsWritten = state['stage-a'].docsWritten || {};
        for (const k of Object.keys(nextDocsWritten)) {
          if (prevDocsWritten[k] !== nextDocsWritten[k]) {
            changed = true;
            break;
          }
        }
        if (changed) state['stage-a'].docsWritten = nextDocsWritten;

        if (changed) {
          addHistoryEvent(state, 'stage_a_validated', 'Stage A docs validated');
          saveState(repoRoot, state);
          console.log('[auto] State updated: stage-a.validated = true');
        } else {
          console.log('[auto] State unchanged: stage-a already validated');
        }
      } else if (state && state.stage === 'A' && !canonical) {
        console.log('[warn] Docs validated, but state was not updated because --docs-root overrides the canonical init Stage A docs path.');
      }
    }

    printResult({ ok, errors: res.errors, warnings: res.warnings, summary }, format);
    process.exit(ok ? 0 : 1);
  }

  if (command === 'mark-must-ask') {
    const key = opts['key'];
    const asked = !!opts['asked'];
    const answered = !!opts['answered'];
    const writtenTo = opts['written-to'];

    if (!key) die('[error] --key is required for mark-must-ask');
    if (!asked && !answered && !writtenTo) {
      die('[error] mark-must-ask requires --asked and/or --answered or --written-to');
    }

    const state = loadState(repoRoot);
    if (!state) die('[error] No init state found. Run the \"start\" command first.');

	    const mustAsk = state['stage-a'] && state['stage-a'].mustAsk;
	    if (!mustAsk || !mustAsk[key]) {
	      const available = mustAsk ? Object.keys(mustAsk).join(', ') : '';
	      die(`[error] Unknown must-ask key "${key}". Available keys: ${available}`);
	    }

    if (asked) mustAsk[key].asked = true;
    if (answered) mustAsk[key].answered = true;
    if (writtenTo) mustAsk[key].writtenTo = writtenTo;

    addHistoryEvent(state, 'must_ask_updated', `mustAsk.${key} updated`);
    saveState(repoRoot, state);
    console.log(`[ok] mustAsk.${key} updated`);
    process.exit(0);
  }

 	  if (command === 'review-packs') {
    const note = opts['note'];
    const state = loadState(repoRoot);
    if (!state) die('[error] No init state found. Run the \"start\" command first.');

	    if (!state['stage-b']) state['stage-b'] = {};
	    state['stage-b'].packsReviewed = true;
	    addHistoryEvent(state, 'packs_reviewed', note || 'Packs reviewed');
	    saveState(repoRoot, state);
 	    console.log('[ok] stage-b.packsReviewed = true');
 	    process.exit(0);
 	  }

    if (command === 'review-skill-retention') {
      const note = opts['note'];
      const state = loadState(repoRoot);
      if (!state) die('[error] No init state found. Run the \"start\" command first.');
      if (state.stage !== 'C') {
        die(`[error] Current stage=${state.stage}; cannot review skill retention until Stage C.`);
      }
      if (!state['stage-c']?.wrappersSynced) {
        die('[error] Stage C apply has not completed (wrappers not synced). Run apply first.');
      }

      if (!state['stage-c']) state['stage-c'] = {};
      state['stage-c'].skillRetentionReviewed = true;
      addHistoryEvent(state, 'skill_retention_reviewed', note || 'Skill retention reviewed');
      saveState(repoRoot, state);
      console.log('[ok] stage-c.skillRetentionReviewed = true');
      process.exit(0);
    }

  if (command === 'suggest-packs') {
    if (!blueprintPath) die('[error] --blueprint is required for suggest-packs');
    const blueprint = readJson(blueprintPath);

    const v = validateBlueprint(blueprint);
    const rec = recommendedPacksFromBlueprint(blueprint);
    const current = normalizePackList((blueprint.skills && blueprint.skills.packs) || []);
    const missing = rec.filter((p) => !current.includes(p));
    const extra = current.filter((p) => !rec.includes(p));

    const installChecks = rec.map((p) => checkPackInstall(repoRoot, p)).filter((x) => !x.installed);
    const warnings = [];
    for (const c of installChecks) warnings.push(`Recommended pack "${c.pack}" is not installed (${c.reason}).`);

    const result = {
      ok: v.ok,
      recommended: rec,
      current,
      missing,
      extra,
      warnings,
      errors: v.errors,
      summary: `[info] Packs: current=${current.join(', ') || '(none)'} | recommended=${rec.join(', ')}`
    };

    if (opts['write']) {
      if (!v.ok) die('[error] Cannot write packs: blueprint validation failed.');
      const next = normalizePackList([...current, ...missing]);
      blueprint.skills = blueprint.skills || {};
      blueprint.skills.packs = next;
      writeJson(blueprintPath, blueprint);
      result.wrote = { path: path.relative(repoRoot, blueprintPath), packs: next };
      result.summary += `\n[write] Added missing recommended packs into blueprint.skills.packs`;
    }

    printResult(result, format);
    process.exit(v.ok ? 0 : 1);
  }

  if (command === 'suggest-features') {
    if (!blueprintPath) die('[error] --blueprint is required for suggest-features');
    const blueprint = readJson(blueprintPath);

    const v = validateBlueprint(blueprint);
    const rec = recommendedFeaturesFromBlueprint(blueprint);
    const current = getEnabledFeatures(blueprint);
    const missing = rec.filter((a) => !current.includes(a));
    const extra = current.filter((a) => !rec.includes(a));

    const result = {
      ok: v.ok,
      recommended: rec,
      current,
      missing,
      extra,
      errors: v.errors,
      warnings: v.warnings,
      summary: `[info] Features: current=${current.join(', ') || '(none)'} | recommended=${rec.join(', ') || '(none)'}`
    };

    if (opts['write']) {
      if (!v.ok) die('[error] Cannot write features: blueprint validation failed.');
      blueprint.features = blueprint.features || {};
      for (const featureKey of missing) {
        blueprint.features[featureKey] = true;
      }
      writeJson(blueprintPath, blueprint);
      result.wrote = { path: path.relative(repoRoot, blueprintPath), features: [...current, ...missing] };
      result.summary += `\n[write] Added missing recommended features into blueprint.features`;
    }

    printResult(result, format);
    process.exit(v.ok ? 0 : 1);
  }

  if (command === 'scaffold') {
    if (!blueprintPath) die('[error] --blueprint is required for scaffold');
    const apply = !!opts['apply'];
    const blueprint = readJson(blueprintPath);

    const v = validateBlueprint(blueprint);
    if (!v.ok) die('[error] Blueprint is not valid; refusing to scaffold.');

    const plan = planScaffold(repoRoot, blueprint, apply);
    const summary = apply
      ? `[ok] Scaffold applied under repo root: ${repoRoot}`
      : `[plan] Scaffold dry-run under repo root: ${repoRoot}`;

    if (format === 'json') {
      console.log(JSON.stringify({ ok: true, summary, plan }, null, 2));
    } else {
      console.log(summary);
      for (const item of plan) {
        const mode = item.mode ? ` (${item.mode})` : '';
        const reason = item.reason ? ` [${item.reason}]` : '';
        console.log(`- ${item.op}: ${path.relative(repoRoot, item.path || '')}${mode}${reason}`);
      }
    }
    process.exit(0);
  }

  if (command === 'update-agents') {
    if (!blueprintPath) die('[error] --blueprint is required for update-agents');
    const apply = !!opts['apply'];
    const blueprint = readJson(blueprintPath);

    const v = validateBlueprint(blueprint);
    if (!v.ok) die('[error] Blueprint validation failed. Fix errors and re-run.');

    const result = patchRootAgentsProjectInfo(repoRoot, blueprint, apply);
    if (result.mode === 'failed') die(`[error] update-agents failed: ${result.reason || 'unknown error'}`);

    // Auto-update state (best-effort)
    if (apply) {
      const state = loadState(repoRoot);
      if (state && (state.stage === 'C' || state.stage === 'complete')) {
        if (!state['stage-c']) state['stage-c'] = {};
        state['stage-c'].agentsUpdated = true;
        addHistoryEvent(state, 'agents_updated', 'Root AGENTS.md updated from blueprint');
        saveState(repoRoot, state);
        console.log('[auto] State updated: stage-c.agentsUpdated = true');
      }
    }

    if (format === 'json') {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    } else {
      const status = apply ? '[ok]' : '[plan]';
      const mode = apply ? 'applied' : 'dry-run';
      const rel = path.relative(repoRoot, result.path);
      console.log(`${status} update-agents: ${rel} (${mode})`);
      if (Array.isArray(result.changes) && result.changes.length > 0) {
        console.log(`- Changes: ${result.changes.join(', ')}`);
      }
      if (result.summary) console.log(`- Summary: ${result.summary}`);
      if (!apply) console.log('[hint] Re-run with --apply to write changes.');
    }

    process.exit(0);
  }

	 	  if (command === 'apply') {
	 	    if (!blueprintPath) die('[error] --blueprint is required for apply');
		    if (format === 'json') redirectConsoleToStderr();
	 	    const providers = opts['providers'] || 'both';
		    const force = !!opts['force'];
	 	    const requireStageA = !!opts['require-stage-a'];
		    const skipConfigs = !!opts['skip-configs'];
		    const forceFeatures = !!opts['force-features'];
		    const verifyFeatures = !!opts['verify-features'];
		    const blockingFeatures = !!opts['blocking-features'];
		    const skipModular = !!opts['skip-modular'];
 		    const blockingModular = !!opts['blocking-modular'];
 		    const nonBlockingFeatures = !blockingFeatures;
 		    const iUnderstand = !!opts['i-understand'];

		    // Stage gating: apply is a Stage C command and should not run earlier by default.
		    const stateForGate = loadState(repoRoot);
		    if (!stateForGate) {
		      if (!force) {
		        die('[error] No init state found. Run "start" first, then complete Stage A/B approvals before running "apply".');
		      }
		      if (!iUnderstand) {
		        die('[error] --force requires --i-understand for apply.');
		      }
		    } else {
		      const stage = String(stateForGate.stage || '').toLowerCase();
		      if (stage !== 'c') {
		        if (!force) {
		          die(
		            `[error] Current stage=${stateForGate.stage}; "apply" is a Stage C command.\n` +
		              'Run: status (confirm stage), then approve Stage B to enter Stage C.\n' +
		              'If you must run apply outside Stage C, re-run with --force --i-understand.'
		          );
		        }
		        if (!iUnderstand) {
		          die('[error] --force requires --i-understand for apply.');
		        }
		      }
		    }

	    const blueprint = readJson(blueprintPath);

    // Validate blueprint
    const v = validateBlueprint(blueprint);
    if (!v.ok) die('[error] Blueprint validation failed. Fix errors and re-run.');

    // Stage A docs check (strict only when explicitly required)
    const stage_a_res = checkDocs(docsRoot);
    if (requireStageA) {
      const strictOk = stage_a_res.ok && stage_a_res.warnings.length === 0;
      if (!strictOk) die('[error] Stage A docs check failed in strict mode. Fix docs and re-run.');
    }

    // Suggest packs (warn-only)
    const rec = recommendedPacksFromBlueprint(blueprint);
    const current = normalizePackList((blueprint.skills && blueprint.skills.packs) || []);
    const missing = rec.filter((p) => !current.includes(p));
    if (missing.length > 0) {
      console.warn(`[warn] Blueprint.skills.packs is missing recommended packs: ${missing.join(', ')}`);
      console.warn(`[warn] Run: suggest-packs --blueprint ${path.relative(repoRoot, blueprintPath)} --write  (or edit blueprint.skills.packs manually)`);
    }

    // Scaffold directories
    const scaffoldPlan = planScaffold(repoRoot, blueprint, true);

    // Generate config files (default: enabled)
    let configResults = [];
    if (!skipConfigs) {
      configResults = generateConfigFiles(repoRoot, blueprint, true);
      console.log('[ok] Config files generated.');
      for (const r of configResults) {
        const mode = r.mode ? ` (${r.mode})` : '';
        const reason = r.reason ? ` [${r.reason}]` : '';
        console.log(`  - ${r.action}: ${r.file}${mode}${reason}`);
      }
    }

    // Generate project-specific README.md
    const readmeResult = generateProjectReadme(repoRoot, blueprint, true);
    if (readmeResult.op === 'write' && readmeResult.mode === 'applied') {
      console.log('[ok] README.md generated from blueprint.');
    } else if (readmeResult.reason) {
      console.log(`[info] README.md: ${readmeResult.reason}`);
    }

    const featureOptions = { force: forceFeatures, verify: verifyFeatures };
    const verifyFailures = [];

    // Ensure project state exists (records enabled features for LLMs and tooling)
    const projectStatectlPath = path.join(repoRoot, '.ai', 'scripts', 'ctl-project-state.mjs');
    if (fs.existsSync(projectStatectlPath)) {
      const initRes = runNodeScriptWithRepoRootFallback(repoRoot, projectStatectlPath, ['init', '--repo-root', repoRoot], true);
      if (initRes.mode === 'failed') {
        console.warn('[warn] ctl-project-state init failed; feature flags may not be recorded.');
      }
    }

    // Ensure project governance hub exists (project-level progress tracking)
    const projectGovctlPath = path.join(repoRoot, '.ai', 'scripts', 'ctl-project-governance.mjs');
    if (fs.existsSync(projectGovctlPath)) {
      const initRes = runNodeScriptWithRepoRootFallback(
        repoRoot,
        projectGovctlPath,
        ['init', '--project', 'main', '--repo-root', repoRoot],
        true
      );
      if (initRes.mode === 'failed') {
        console.warn('[warn] project governance init failed; project hub may be missing.');
      }
    }

    // Mandatory: Context Awareness feature (LLM-stable contracts for modular workflow)
    console.log('[info] Enabling Context Awareness feature...');
    const contextFeature = ensureContextAwarenessFeature(repoRoot, blueprint, true, featureOptions);
    if (contextFeature.errors && contextFeature.errors.length > 0) {
      for (const e of contextFeature.errors) console.error(`[error] ${e}`);
      if (!nonBlockingFeatures) {
        die('[error] Context awareness feature setup failed. Re-run without --blocking-features to continue despite errors.');
      }
    }
    if (contextFeature.verifyFailed) {
      const msg = contextFeature.verifyError || 'Context awareness verify failed';
      console.error(`[error] ${msg}`);
      verifyFailures.push('context-awareness');
      if (!nonBlockingFeatures) {
        die('[error] Context awareness verify failed. Re-run without --blocking-features to continue despite errors.');
      }
    }
    if (contextFeature.warnings && contextFeature.warnings.length > 0) {
      for (const w of contextFeature.warnings) console.warn(`[warn] ${w}`);
    }

    // Optional feature materialization
    const featureResults = [];

    // Helper function to handle feature installation with fail-fast support
    function handleFeatureResult(res, featureId) {
      featureResults.push(res);
      if (res.errors.length > 0) {
        for (const e of res.errors) console.error(`[error] ${e}`);
        if (!nonBlockingFeatures) {
          die(`[error] Feature "${featureId}" installation failed. Re-run without --blocking-features to continue despite errors.`);
        }
      }
      if (res.verifyFailed) {
        const msg = res.verifyError || `Feature "${featureId}" verify failed`;
        console.error(`[error] ${msg}`);
        verifyFailures.push(featureId);
        if (!nonBlockingFeatures) {
          die(`[error] Feature "${featureId}" verify failed. Re-run without --blocking-features to continue despite errors.`);
        }
      }
      if (res.warnings.length > 0) {
        for (const w of res.warnings) console.warn(`[warn] ${w}`);
      }
    }

    // Database feature (SSOT-aware)
    if (isDatabaseEnabled(blueprint)) {
      console.log('[info] Enabling Database feature...');
      const res = ensureDatabaseFeature(repoRoot, blueprint, true, featureOptions);
      handleFeatureResult(res, 'database');
    }

    // UI feature
    if (isUiEnabled(blueprint)) {
      console.log('[info] Enabling UI feature...');
      const res = ensureUiFeature(repoRoot, blueprint, true, featureOptions);
      handleFeatureResult(res, 'ui');
    }

    // Environment feature
    if (isEnvironmentEnabled(blueprint)) {
      console.log('[info] Enabling Environment feature...');
      const res = ensureEnvironmentFeature(repoRoot, blueprint, true, featureOptions);
      handleFeatureResult(res, 'environment');
    }

    // IaC feature
    if (isIacEnabled(blueprint)) {
      console.log('[info] Enabling IaC feature...');
      const res = ensureIacFeature(repoRoot, blueprint, true, featureOptions);
      handleFeatureResult(res, 'iac');
    }

    // CI feature
    if (isCiEnabled(blueprint)) {
      console.log('[info] Enabling CI feature...');
      const res = ensureCiFeature(repoRoot, blueprint, true, featureOptions);
      handleFeatureResult(res, 'ci');
    }

    // Packaging feature
    if (isPackagingEnabled(blueprint)) {
      console.log('[info] Enabling Packaging feature...');
      const res = ensureFeature(repoRoot, 'packaging', true, 'ctl-pack.mjs', featureOptions);
      handleFeatureResult(res, 'packaging');
    }

    // Deployment feature
    if (isDeploymentEnabled(blueprint)) {
      console.log('[info] Enabling Deployment feature...');
      const res = ensureFeature(repoRoot, 'deployment', true, 'ctl-deploy.mjs', featureOptions);
      handleFeatureResult(res, 'deployment');
    }

    // Release feature
    if (isReleaseEnabled(blueprint)) {
      console.log('[info] Enabling Release feature...');
      const res = ensureFeature(repoRoot, 'release', true, 'ctl-release.mjs', featureOptions);
      handleFeatureResult(res, 'release');
    }

    // Observability feature
    if (isObservabilityEnabled(blueprint)) {
      console.log('[info] Enabling Observability feature...');
      const res = ensureFeature(repoRoot, 'observability', true, 'ctl-obs.mjs', featureOptions);
      handleFeatureResult(res, 'observability');
    }

    // DB SSOT bootstrap (docs/project + AGENTS + LLM db context)
    const dbSsotConfigResult = ensureDbSsotConfig(repoRoot, blueprint, true);
    if (dbSsotConfigResult.mode === 'applied') {
      console.log(`[ok] DB SSOT config written: ${path.relative(repoRoot, dbSsotConfigResult.path)}`);
    } else if (dbSsotConfigResult.reason) {
      console.log(`[info] DB SSOT config skipped: ${dbSsotConfigResult.reason}`);
    }
    const agentsDbSsotResult = patchRootAgentsDbSsotSection(repoRoot, blueprint, true);
    if (agentsDbSsotResult.mode === 'applied') {
      console.log(`[ok] AGENTS.md updated (DB SSOT section)`);
    }
    const dbContextRefreshResult = refreshDbContextContract(repoRoot, blueprint, true, verifyFeatures);
    if (dbContextRefreshResult.mode === 'applied' && dbContextRefreshResult.op === 'db-context-refresh') {
      console.log(`[ok] DB context refreshed: ${path.relative(repoRoot, dbContextRefreshResult.path)}`);
    } else if (dbContextRefreshResult.mode === 'applied' && dbContextRefreshResult.op === 'rm') {
      console.log(`[ok] DB context contract removed: ${path.relative(repoRoot, dbContextRefreshResult.path)}`);
    } else if (dbContextRefreshResult.reason) {
      console.log(`[info] DB context refresh skipped: ${dbContextRefreshResult.reason}`);
    }

    // CI cleanup (provider=none): ensure we don't leave behind CI config files from previous runs.
    const ciCleanupResult = cleanupCiProviderArtifacts(repoRoot, blueprint, true);
    if (ciCleanupResult.mode === 'applied') {
      console.log('[ok] CI artifacts cleaned (ci.provider=none)');
    } else if (ciCleanupResult.mode === 'partial') {
      console.warn('[warn] CI artifacts cleanup partially completed (ci.provider=none)');
    }

    // Manifest update
    const manifestResult = updateManifest(repoRoot, blueprint, true);
    if (manifestResult.mode === 'failed') {
      if (manifestResult.errors && manifestResult.errors.length > 0) {
        for (const e of manifestResult.errors) console.error(`[error] ${e}`);
      }
      console.warn('[warn] Skill pack / manifest update failed; continuing (non-blocking).');
    }
    if (manifestResult.warnings && manifestResult.warnings.length > 0) {
      for (const w of manifestResult.warnings) console.warn(`[warn] ${w}`);
    }

    // DB SSOT skill mutual exclusion (sync-manifest excludeSkills)
    const ssotSkillExclusionsResult = applyDbSsotSkillExclusions(repoRoot, blueprint, true);
    if (ssotSkillExclusionsResult.mode === 'applied') {
      console.log('[ok] Skill exclusions updated for DB SSOT');
    }

    // CI provider mutual exclusion (sync-manifest excludeSkills)
    const ciSkillExclusionsResult = applyCiProviderSkillExclusions(repoRoot, blueprint, true);
    if (ciSkillExclusionsResult.mode === 'applied') {
      console.log('[ok] Skill exclusions updated for CI provider');
    }

    // Sync wrappers
	    const syncResult = syncWrappers(repoRoot, providers, true);
	    if (syncResult.mode === 'failed') {
	      console.warn(`[warn] sync-skills.mjs failed with exit code ${syncResult.exitCode}; continuing (non-blocking)`);
	    }

	    const retentionTemplateResult = ensureSkillRetentionTemplate(repoRoot, true);
	    if (retentionTemplateResult.mode === 'applied') {
	      console.log(`[ok] Skill retention template created: ${path.relative(repoRoot, retentionTemplateResult.path)}`);
	    } else if (retentionTemplateResult.reason) {
	      console.log(`[info] Skill retention template: ${retentionTemplateResult.reason}`);
	    }

	    let modularResult = { op: 'modular-core-build', mode: 'skipped', reason: '--skip-modular', actions: [], warnings: [], errors: [] };
	    if (!skipModular) {
	      console.log('[info] Running modular core build...');
	      modularResult = runModularCoreBuild(repoRoot, true);
	      if (modularResult.errors.length > 0) {
	        for (const e of modularResult.errors) console.error(`[error] ${e}`);
	        if (blockingModular) {
	          die('[error] Modular core build failed. Re-run without --blocking-modular to continue despite errors.');
	        }
	      }
	      if (modularResult.warnings.length > 0) {
	        for (const w of modularResult.warnings) console.warn(`[warn] ${w}`);
	      }
	    }

		    // Auto-update state
			    const state = loadState(repoRoot);
			    const canonicalBlueprint = path.resolve(blueprintPath) === path.resolve(resolveInitPaths(repoRoot).blueprintPath);
			    const canonicalDocs = path.resolve(docsRoot) === path.resolve(resolveInitPaths(repoRoot).docsRoot);
			    if (state && String(state.stage || '').toLowerCase() === 'c' && canonicalBlueprint && canonicalDocs) {
			      if (!state['stage-c']) state['stage-c'] = {};
			      state['stage-c'].scaffoldApplied = true;
			      state['stage-c'].configsGenerated = !skipConfigs;
			      state['stage-c'].manifestUpdated = manifestResult.mode !== 'failed';
			      state['stage-c'].wrappersSynced = syncResult.mode === 'applied';
			      state['stage-c'].modularBuilt = modularResult.mode === 'applied';
			      state['stage-c'].skillRetentionReviewed = false;
			      state['stage-c'].agentsUpdated = false;
			      addHistoryEvent(state, 'stage_c_applied', 'Stage C apply completed');
			      saveState(repoRoot, state);
			      console.log('[auto] State updated: stage-c progress recorded');
			    } else if (state && String(state.stage || '').toLowerCase() === 'c' && (!canonicalBlueprint || !canonicalDocs)) {
			      console.warn('[warn] Apply completed, but state was not updated because --blueprint/--docs-root override the canonical init paths.');
			    }
	    const cleanupResult = null

		    if (format === 'json') {
		      process.stdout.write(JSON.stringify({
	        ok: true,
	        blueprint: path.relative(repoRoot, blueprintPath),
	        docsRoot: path.relative(repoRoot, docsRoot),
	        'stage-a': stage_a_res,
	        contextFeature,
        features: featureResults,
        scaffold: scaffoldPlan,
        configs: configResults,
        dbSsotConfig: dbSsotConfigResult,
        agentsDbSsot: agentsDbSsotResult,
        dbContextContract: dbContextRefreshResult,
	        ciCleanup: ciCleanupResult,
	        dbSsotSkillExclusions: ssotSkillExclusionsResult,
	        readme: readmeResult,
	        skillRetentionTemplate: retentionTemplateResult,
	        manifest: manifestResult,
	        sync: syncResult,
	        modular: modularResult,
		        cleanup: cleanupResult
		      }, null, 2) + '\n');
		    } else {
	      console.log('[ok] Apply completed.')
	      console.log(`- Blueprint: ${path.relative(repoRoot, blueprintPath)}`)
	      console.log(`- Docs root: ${path.relative(repoRoot, docsRoot)}`)
	      console.log(`- DB SSOT: ${blueprint.db && blueprint.db.ssot ? blueprint.db.ssot : 'unknown'}`)

      const installed = []
      if (contextFeature && contextFeature.enabled) installed.push('context-awareness')
      for (const r of featureResults) {
        if (r && r.featureId && r.op === 'ensure') installed.push(r.featureId)
      }
      if (installed.length > 0) {
        console.log(`- Features installed: ${installed.join(', ')}`)
      }

      if (verifyFeatures) {
        if (verifyFailures.length > 0) {
          console.log(`- Features verified: failed (${verifyFailures.join(', ')})`)
        } else {
          console.log(`- Features verified: yes`)
        }
      }

      if (!stage_a_res.ok) console.log('[warn] Stage A docs check had errors; consider re-running with --require-stage-a.')
      if (stage_a_res.warnings.length > 0) console.log('[warn] Stage A docs check has warnings; ensure TODO/FIXME items are tracked.')
      if (retentionTemplateResult.path) {
        const status = retentionTemplateResult.mode || retentionTemplateResult.reason || 'unknown'
        console.log(`- Skill retention template: ${path.relative(repoRoot, retentionTemplateResult.path)} (${status})`)
      }
	      const manifestStatus = manifestResult.mode || manifestResult.reason || 'unknown'
	      console.log(`- Manifest: ${path.relative(repoRoot, manifestResult.path)} (${manifestStatus})`)
	      const syncStatus = syncResult.mode || syncResult.reason || 'unknown'
	      console.log(`- Wrappers sync: ${syncResult.cmd || '(skipped)'} (${syncStatus})`)
	      const modularStatus = modularResult.mode || modularResult.reason || 'unknown'
	      console.log(`- Modular core build: ${modularStatus}`)
	      if (cleanupResult) console.log(`- init/ cleanup: ${cleanupResult.mode}`)
	    }

	    process.exit(0)
	  }

 	  if (command === 'cleanup-init') {
    if (!opts['i-understand']) die('[error] cleanup-init requires --i-understand');
    const apply = !!opts['apply'];
    const force = !!opts['force'];
    const archiveAll = !!opts['archive'];
    const archiveDocs = archiveAll || !!opts['archive-docs'];
    const archiveBlueprint = archiveAll || !!opts['archive-blueprint'];
    const state = loadState(repoRoot);
    const initPaths = resolveInitPaths(repoRoot);

    if (apply) {
      const stage = state ? String(state.stage || '').toLowerCase() : null;
      const hasWorkArtifacts = [
        initPaths.statePath,
        initPaths.docsRoot,
        initPaths.blueprintPath,
        initPaths.skillRetentionPath,
        path.join(repoRoot, 'init', 'START-HERE.md'),
        path.join(repoRoot, 'init', 'INIT-BOARD.md')
      ].some((p) => fs.existsSync(p));

      if (state && stage !== 'complete') {
        if (!force) {
          die(
            `[error] Current stage=${state.stage}; cleanup-init is only allowed after init completion.\n` +
              'Complete Stage C approval first, or re-run with --force to override.'
          );
        }
      } else if (!state && hasWorkArtifacts) {
        if (!force) {
          die(
            '[error] Init work artifacts exist, but the init state file is missing; refusing cleanup.\n' +
              'Restore the state file or re-run with --force to remove init/ anyway.'
          );
        }
      }
    }

    const results = { init: null, archivedDocs: null, archivedBlueprint: null };
    const destProjectDir = path.join(repoRoot, 'docs', 'project');
    const destOverviewDir = path.join(destProjectDir, 'overview');

    // Archive Stage A docs if requested
    const stage_a_docs_dir = initPaths.docsRoot;
    if (fs.existsSync(stage_a_docs_dir)) {
      if (archiveDocs) {
        if (!apply) {
          results.archivedDocs = { from: stage_a_docs_dir, to: destOverviewDir, mode: 'dry-run' };
        } else {
          fs.mkdirSync(destOverviewDir, { recursive: true });
          const files = fs.readdirSync(stage_a_docs_dir);
          for (const file of files) {
            const srcFile = path.join(stage_a_docs_dir, file);
            const destFile = path.join(destOverviewDir, file);
            if (fs.statSync(srcFile).isFile()) {
              fs.copyFileSync(srcFile, destFile);
            }
          }
          results.archivedDocs = { from: stage_a_docs_dir, to: destOverviewDir, mode: 'applied', files };
        }
      } else if (apply) {
        console.log('[info] Stage A docs will be deleted with init/');
        console.log('[hint] Use --archive or --archive-docs to preserve them in docs/project/overview/');
      }
    }

    // Archive blueprint if requested
    const blueprintSrc = initPaths.blueprintPath;
    if (fs.existsSync(blueprintSrc)) {
      if (archiveBlueprint) {
        const blueprintDest = path.join(destOverviewDir, 'project-blueprint.json');
        if (!apply) {
          results.archivedBlueprint = { from: blueprintSrc, to: blueprintDest, mode: 'dry-run' };
        } else {
          fs.mkdirSync(destOverviewDir, { recursive: true });
          fs.copyFileSync(blueprintSrc, blueprintDest);
          results.archivedBlueprint = { from: blueprintSrc, to: blueprintDest, mode: 'applied' };
        }
      } else if (apply) {
        console.log('[info] Blueprint will be deleted with init/');
        console.log('[hint] Use --archive or --archive-blueprint to preserve it in docs/project/overview/');
      }
    }

    // Cleanup init/ directory
    results.init = cleanupInit(repoRoot, apply);

    if (format === 'json') {
      console.log(JSON.stringify({ ok: true, results }, null, 2));
    } else {
      // Print archive results
      if (results.archivedDocs) {
        const arc = results.archivedDocs;
        if (arc.mode === 'dry-run') {
          console.log(`[plan] archive: Stage A docs -> ${path.relative(repoRoot, arc.to)} (dry-run)`);
        } else {
          console.log(`[ok] archive: Stage A docs -> ${path.relative(repoRoot, arc.to)}`);
          if (arc.files) console.log(`  Files: ${arc.files.join(', ')}`);
        }
      }
      if (results.archivedBlueprint) {
        const arc = results.archivedBlueprint;
        if (arc.mode === 'dry-run') {
          console.log(`[plan] archive: Blueprint -> ${path.relative(repoRoot, arc.to)} (dry-run)`);
        } else {
          console.log(`[ok] archive: Blueprint -> ${path.relative(repoRoot, arc.to)}`);
        }
      }

      // Print init cleanup result
      if (results.init) {
        const res = results.init;
        if (!apply) {
          console.log(`[plan] ${res.op}: ${path.relative(repoRoot, res.path || '')} (${res.mode})`);
          if (res.note) console.log(`Note: ${res.note}`);
        } else {
          console.log(`[ok] ${res.op}: ${path.relative(repoRoot, res.path || '')} (${res.mode})`);
          if (res.note) console.log(`Note: ${res.note}`);
        }
      }
    }
    process.exit(0);
  }

  usage(1);
}

main();
