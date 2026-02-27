#!/usr/bin/env node
/**
 * ctl-project-governance.mjs
 *
 * Project governance control tool (init/lint/sync).
 *
 * @reference .ai/project/CONTRACT.md
 * @reference .ai/skills/standards/naming-conventions/SKILL.md
 *
 * Design notes:
 * - Dependency-free (Node built-ins only).
 * - Task progress SoT remains in the dev-docs task bundle (`00-overview.md`).
 * - Task identity SoT is anchored by `.ai-task.yaml` (`task_id`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { colors, die, header, info, ok } from './lib/colors.mjs';
import { parseSimpleList, parseSimpleMap, parseTopLevelVersion } from './lib/yaml-lite.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PROJECT = 'main';

const TASK_ID_RE = /^T-\d{3}$/;
const FEATURE_ID_RE = /^F-\d{3}$/;
const MILESTONE_ID_RE = /^M-\d{3}$/;
const REQUIREMENT_ID_RE = /^R-\d{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TASK_STATUS = new Set(['planned', 'in-progress', 'blocked', 'done', 'archived']);
const BUNDLE_STATUS = new Set(['planned', 'in-progress', 'blocked', 'done']);

const IGNORE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.ai',
  '.codex',
  '.claude',
  '.cursor',
  '.next',
  'dist',
  'build',
  'coverage',
]);

// Template substitution variables
function today() {
  // Always use YYYY-MM-DD in local time.
  const d = new Date();
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function usage(exitCode = 0) {
  const msg = `
Usage:
  node .ai/scripts/ctl-project-governance.mjs <command> [options]

Commands:
  init
    --repo-root <path>        Repo root (default: auto-detect; fallback: cwd)
    --project <slug>          Project slug (default: ${DEFAULT_PROJECT})
    --dry-run                 Show what would be created
    --force                   Overwrite existing hub files (dangerous)
    Initialize the project hub at .ai/project/<project>/ (idempotent by default).

  lint
    --repo-root <path>        Repo root (default: auto-detect; fallback: cwd)
    --project <slug>          Project slug (default: ${DEFAULT_PROJECT})
    --check                   Exit non-zero only on errors (warnings do not fail)
    --strict                  Treat warnings as errors (except "human verification" warnings)
    Validate repo project governance state against the Project Contract.

  sync
    --repo-root <path>        Repo root (default: auto-detect; fallback: cwd)
    --project <slug>          Project slug (default: ${DEFAULT_PROJECT})
    --dry-run                 Print planned changes without writing
    --apply                   Apply changes (writes files)
    --init-if-missing         Create missing hub files from templates before syncing
    --changelog               Append sync-detected events to hub changelog (apply-mode only)
    Generate missing task meta IDs, upsert registry tasks, and regenerate derived views.

  query
    --repo-root <path>        Repo root (default: auto-detect; fallback: cwd)
    --project <slug>          Project slug (default: ${DEFAULT_PROJECT})
    --id <T-###>              Filter by a specific task id
    --status <status>         Filter by status (planned|in-progress|blocked|done|archived)
    --text <substring>        Substring match against common task fields
    --json                    Output a single JSON array instead of JSON lines
    Locate tasks quickly for dedupe/triage (LLM-friendly output).

  map
    --repo-root <path>        Repo root (default: auto-detect; fallback: cwd)
    --project <slug>          Project slug (default: ${DEFAULT_PROJECT})
    --task <T-###>            Task ID to map (required)
    --feature <F-###>         Feature ID to map the task to
    --milestone <M-###>       Milestone ID to map the task to
    --requirement <R-###>     Requirement ID to map the task to (creates if needed)
    --dry-run                 Show what would change without writing
    --apply                   Apply the mapping change
    Map a task to Feature/Milestone/Requirement in the registry.

Examples:
  node .ai/scripts/ctl-project-governance.mjs init --project main
  node .ai/scripts/ctl-project-governance.mjs lint --check --project main
  node .ai/scripts/ctl-project-governance.mjs sync --dry-run --project main
  node .ai/scripts/ctl-project-governance.mjs sync --apply --project main
  node .ai/scripts/ctl-project-governance.mjs map --task T-001 --feature F-002 --apply
`.trim();

  console.log(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage(0);

  const command = args.shift();
  const opts = {};

  while (args.length > 0) {
    const token = args.shift();
    if (token === '-h' || token === '--help') usage(0);
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    if (args.length > 0 && !args[0].startsWith('--')) {
      opts[key] = args.shift();
    } else {
      opts[key] = true;
    }
  }

  return { command, opts };
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeTextIfChanged(filePath, content) {
  const prev = readText(filePath);
  if (prev !== null && normalizeEol(prev) === normalizeEol(content)) return false;
  writeText(filePath, content);
  return true;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const contractPath = path.join(dir, '.ai', 'project', 'CONTRACT.md');
    if (exists(contractPath)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function templateVars(projectSlug) {
  return {
    project_slug: projectSlug,
    project_name: projectSlug === 'main' ? 'Main' : projectSlug,
    today: today(),
  };
}

function renderTemplate(raw, vars) {
  let out = String(raw || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

function getHubDir(repoRoot, projectSlug) {
  return path.join(repoRoot, '.ai', 'project', projectSlug);
}

function getRegistryPath(repoRoot, projectSlug) {
  return path.join(getHubDir(repoRoot, projectSlug), 'registry.yaml');
}

function getTemplatesDir(repoRoot) {
  return path.join(
    repoRoot,
    '.ai',
    'skills',
    'workflows',
    'planning',
    'project-sync-lint',
    'templates'
  );
}

function listImmediateChildDirs(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
}

function replaceAutoBlock(raw, blockId, content) {
  const start = `<!-- AUTO-GENERATED:START ${blockId} -->`;
  const end = `<!-- AUTO-GENERATED:END ${blockId} -->`;
  const sIdx = raw.indexOf(start);
  const eIdx = raw.indexOf(end);
  if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
    // If missing markers, replace entire file (safe fallback for templates).
    return content.endsWith('\n') ? content : `${content}\n`;
  }

  const before = raw.slice(0, sIdx + start.length);
  const after = raw.slice(eIdx);

  const mid = `\n${content.trimEnd()}\n`;
  return `${before}${mid}${after}`.replace(/\r\n/g, '\n');
}

function normalizeEol(s) {
  return String(s || '').replace(/\r\n/g, '\n');
}

function stripInlineComment(line) {
  // Minimal: treat '#' as comment delimiter only when not inside quotes.
  const s = String(line || '');
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      return s.slice(0, i);
    }
  }
  return s;
}

function countIndent(line) {
  const m = String(line).match(/^( *)/);
  return m ? m[1].length : 0;
}

function unquoteScalar(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function parseScalar(raw) {
  const t = unquoteScalar(String(raw || '').trim());
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^[0-9]+$/.test(t)) return Number(t);
  return t;
}

function parseYamlDoc(raw) {
  // Minimal YAML parser for this repo's registry format.
  // Supports:
  // - indentation-based maps/lists
  // - scalar values
  // - inline empty list: []
  // - list of maps (with "- key: value" lines)
  const lines = normalizeEol(raw)
    .split('\n')
    .map((l) => stripInlineComment(l).trimEnd());

  function skip(i) {
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t) {
        i++;
        continue;
      }
      if (t.startsWith('#')) {
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  function parseBlock(i, indent) {
    i = skip(i);
    if (i >= lines.length) return { value: null, next: i };

    const line = lines[i];
    const ind = countIndent(line);
    if (ind < indent) return { value: null, next: i };

    const atIndent = line.slice(indent);
    if (atIndent.trimStart().startsWith('- ')) return parseList(i, indent);
    return parseMap(i, indent);
  }

  function parseMap(i, indent) {
    const obj = {};
    while (true) {
      i = skip(i);
      if (i >= lines.length) break;
      const line = lines[i];
      const ind = countIndent(line);
      if (ind < indent) break;
      if (ind > indent) {
        throw new Error(`Invalid indentation at line ${i + 1}`);
      }

      const t = line.slice(indent);
      if (t.trimStart().startsWith('- ')) {
        // List at same indent means map ended
        break;
      }

      const m = t.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) {
        throw new Error(`Invalid mapping at line ${i + 1}: ${t}`);
      }

      const key = m[1];
      const rest = (m[2] ?? '').trim();
      if (rest === '') {
        const child = parseBlock(i + 1, indent + 2);
        obj[key] = child.value === null ? {} : child.value;
        i = child.next;
        continue;
      }

      obj[key] = parseScalar(rest);
      i++;
    }

    return { value: obj, next: i };
  }

  function parseMapInto(obj, i, indent) {
    while (true) {
      i = skip(i);
      if (i >= lines.length) break;
      const line = lines[i];
      const ind = countIndent(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`Invalid indentation at line ${i + 1}`);

      const t = line.slice(indent);
      if (t.trimStart().startsWith('- ')) break;

      const m = t.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) throw new Error(`Invalid mapping at line ${i + 1}: ${t}`);
      const key = m[1];
      const rest = (m[2] ?? '').trim();
      if (rest === '') {
        const child = parseBlock(i + 1, indent + 2);
        obj[key] = child.value === null ? {} : child.value;
        i = child.next;
        continue;
      }
      obj[key] = parseScalar(rest);
      i++;
    }
    return i;
  }

  function parseList(i, indent) {
    const out = [];
    while (true) {
      i = skip(i);
      if (i >= lines.length) break;
      const line = lines[i];
      const ind = countIndent(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`Invalid indentation at line ${i + 1}`);

      const t = line.slice(indent);
      if (!t.trimStart().startsWith('- ')) break;

      const after = t.replace(/^\-\s*/, '');
      if (!after.trim()) {
        const child = parseBlock(i + 1, indent + 2);
        out.push(child.value);
        i = child.next;
        continue;
      }

      const m = after.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) {
        const obj = {};
        const key = m[1];
        const rest = (m[2] ?? '').trim();
        if (rest === '') {
          const child = parseBlock(i + 1, indent + 4);
          obj[key] = child.value;
          i = child.next;
        } else {
          obj[key] = parseScalar(rest);
          i++;
        }
        i = parseMapInto(obj, i, indent + 2);
        out.push(obj);
        continue;
      }

      out.push(parseScalar(after));
      i++;
    }

    return { value: out, next: i };
  }

  const root = parseBlock(0, 0);
  return root.value || {};
}

function needsQuote(s) {
  const t = String(s);
  if (t === '') return true;
  if (/[\s:#\[\]{}]/.test(t)) return true;
  if (t.startsWith('-')) return true;
  return false;
}

function dumpScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (!needsQuote(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dumpYamlDoc(doc) {
  // Stable YAML serializer for the subset produced by this tool.
  const out = [];

  function pushLine(indent, text) {
    out.push(`${' '.repeat(indent)}${text}`.trimEnd());
  }

  function dumpAny(value, indent, keyHint = '') {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        pushLine(indent, `${keyHint}: []`);
        return;
      }
      pushLine(indent, `${keyHint}:`);
      for (const item of value) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const keys = Object.keys(item);
          if (keys.length === 0) {
            pushLine(indent + 2, '- {}');
            continue;
          }
          const orderedKeys = orderKeysForObject(item);
          const firstKey = orderedKeys[0];
          const firstVal = item[firstKey];
          if (firstVal && typeof firstVal === 'object') {
            pushLine(indent + 2, `- ${firstKey}:`);
            dumpObject(firstVal, indent + 6);
          } else {
            pushLine(indent + 2, `- ${firstKey}: ${dumpScalar(firstVal)}`);
          }
          for (const k of orderedKeys.slice(1)) {
            const v = item[k];
            if (Array.isArray(v)) {
              if (v.length === 0) {
                pushLine(indent + 4, `${k}: []`);
              } else {
                pushLine(indent + 4, `${k}:`);
                for (const li of v) {
                  pushLine(indent + 6, `- ${dumpScalar(li)}`);
                }
              }
            } else if (v && typeof v === 'object') {
              pushLine(indent + 4, `${k}:`);
              dumpObject(v, indent + 6);
            } else {
              pushLine(indent + 4, `${k}: ${dumpScalar(v)}`);
            }
          }
          continue;
        }
        pushLine(indent + 2, `- ${dumpScalar(item)}`);
      }
      return;
    }

    if (value && typeof value === 'object') {
      pushLine(indent, `${keyHint}:`);
      dumpObject(value, indent + 2);
      return;
    }

    pushLine(indent, `${keyHint}: ${dumpScalar(value)}`);
  }

  function orderKeysForObject(obj) {
    const keys = Object.keys(obj);

    const preferred = [
      'id',
      'slug',
      'title',
      'name',
      'status',
      'description',
      'milestone_id',
      'feature_id',
      'requirement_id',
      'requirement_ids',
      'dev_docs_path',
      'task_doc_roots',
      'updated',
      'keywords',
    ];

    const set = new Set(keys);
    const ordered = [];
    for (const k of preferred) if (set.has(k)) ordered.push(k);
    const rest = keys.filter((k) => !ordered.includes(k)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...rest];
  }

  function dumpObject(obj, indent) {
    const keys = orderKeysForObject(obj);
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) {
        if (v.length === 0) {
          pushLine(indent, `${k}: []`);
        } else if (v.every((x) => typeof x !== 'object' || x === null)) {
          pushLine(indent, `${k}:`);
          for (const li of v) pushLine(indent + 2, `- ${dumpScalar(li)}`);
        } else {
          // list of objects
          dumpAny(v, indent, k);
        }
      } else if (v && typeof v === 'object') {
        pushLine(indent, `${k}:`);
        dumpObject(v, indent + 2);
      } else {
        pushLine(indent, `${k}: ${dumpScalar(v)}`);
      }
    }
  }

  // Root ordering
  const rootOrder = ['version', 'project', 'milestones', 'features', 'requirements', 'tasks'];
  for (const k of rootOrder) {
    if (!(k in doc)) continue;
    const v = doc[k];
    if (k === 'version') {
      pushLine(0, `version: ${dumpScalar(v)}`);
      pushLine(0, '');
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        pushLine(0, `${k}: []`);
        pushLine(0, '');
        continue;
      }
      dumpAny(v, 0, k);
      pushLine(0, '');
      continue;
    }
    if (v && typeof v === 'object') {
      pushLine(0, `${k}:`);
      dumpObject(v, 2);
      pushLine(0, '');
      continue;
    }
    pushLine(0, `${k}: ${dumpScalar(v)}`);
    pushLine(0, '');
  }

  // Any extra keys
  const extra = Object.keys(doc)
    .filter((k) => !rootOrder.includes(k))
    .sort((a, b) => a.localeCompare(b));
  for (const k of extra) {
    dumpAny(doc[k], 0, k);
    pushLine(0, '');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function getBundleStatusFromOverview(overviewRaw) {
  const raw = normalizeEol(overviewRaw);
  const lines = raw.split('\n');

  let inStatus = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#')) {
      if (/^##\s+Status\s*$/i.test(t)) {
        inStatus = true;
        continue;
      }
      if (inStatus && /^##\s+/.test(t)) {
        // next section
        break;
      }
    }

    if (!inStatus) continue;

    const m = t.match(/^\-\s*State\s*:\s*(.+)\s*$/i);
    if (!m) continue;

    const value = String(m[1] || '').trim();
    if (value.includes('|')) {
      return { status: null, error: 'State must be a single value (not an enum hint).' };
    }

    if (!BUNDLE_STATUS.has(value)) {
      return { status: null, error: `Invalid State value: "${value}". Allowed: ${[...BUNDLE_STATUS].join(', ')}` };
    }

    return { status: value, error: null };
  }

  return { status: null, error: 'Missing "## Status" / "- State: <status>" in 00-overview.md.' };
}

function getAcceptanceCriteriaStats(overviewRaw) {
  const raw = normalizeEol(overviewRaw);
  const lines = raw.split('\n');

  let inAc = false;
  let total = 0;
  let checked = 0;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#')) {
      if (/^##\s+Acceptance criteria\b/i.test(t)) {
        inAc = true;
        continue;
      }
      if (inAc && /^##\s+/.test(t)) break;
    }
    if (!inAc) continue;

    const m = t.match(/^\-\s*\[(x|X|\s)\]\s+(.+)$/);
    if (!m) continue;
    total += 1;
    if (String(m[1]).toLowerCase() === 'x') checked += 1;
  }

  return { total, checked };
}

function statusRank(status) {
  switch (status) {
    case 'planned':
      return 10;
    case 'in-progress':
      return 20;
    case 'blocked':
      return 20;
    case 'done':
      return 30;
    case 'archived':
      return 40;
    default:
      return 0;
  }
}

function formatTaskRef(task) {
  const rel = toPosix(task.relPath);
  return `${task.taskId || '(no-id)'} ${task.slug} (${task.lifecycle}) @ ${rel}`;
}

function discoverDevDocsRoots(repoRoot) {
  // Config-first is handled elsewhere; this is the fallback auto-discovery.
  const roots = [];
  const stack = [repoRoot];

  while (stack.length > 0) {
    const dir = stack.pop();

    const base = path.basename(dir);
    if (IGNORE_DIRS.has(base)) continue;
    if (base.startsWith('.') && dir !== repoRoot) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);

      if (e.name === 'dev-docs') {
        const active = path.join(full, 'active');
        const archive = path.join(full, 'archive');
        if (exists(active) || exists(archive)) {
          roots.push(full);
          continue;
        }
      }

      if (IGNORE_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      stack.push(full);
    }
  }

  const uniq = Array.from(new Set(roots.map((p) => path.resolve(p))));
  return uniq.sort((a, b) => a.localeCompare(b));
}

function loadRegistry(repoRoot, projectSlug) {
  const registryPath = getRegistryPath(repoRoot, projectSlug);
  const raw = readText(registryPath);
  if (!raw) return { path: registryPath, registry: null, error: null };

  try {
    const parsed = parseYamlDoc(raw);
    return { path: registryPath, registry: parsed, error: null };
  } catch (e) {
    return { path: registryPath, registry: null, error: e.message || String(e) };
  }
}

function getConfiguredRootsFromRegistry(registry) {
  const roots = registry?.project?.task_doc_roots;
  if (!Array.isArray(roots)) return [];
  return roots.map((r) => String(r)).filter(Boolean);
}

/**
 * Unified roots resolution used by lint, sync, and query.
 * Always merges configured roots with auto-discovered roots so that newly
 * added module dev-docs directories are never silently ignored.
 *
 * @param {object|null} registry  Parsed registry (may be null if hub not initialized)
 * @param {string}      repoRoot  Absolute repo root path
 * @returns {{ roots: string[], newRoots: string[] }}
 *   roots    – deduplicated, sorted absolute paths
 *   newRoots – roots found by discovery but NOT in configured list (drift signal)
 */
function resolveDevDocsRoots(registry, repoRoot) {
  const configured = getConfiguredRootsFromRegistry(registry).map((p) => path.resolve(repoRoot, p));
  const discovered = discoverDevDocsRoots(repoRoot);
  const configuredSet = new Set(configured.map((p) => path.resolve(p)));
  const merged = new Set([...configured, ...discovered].map((p) => path.resolve(p)));
  const roots = Array.from(merged).sort((a, b) => a.localeCompare(b));
  const newRoots = discovered
    .map((p) => path.resolve(p))
    .filter((p) => !configuredSet.has(p));
  return { roots, newRoots };
}

function scanTasks(repoRoot, devDocsRoots) {
  const tasks = [];

  for (const root of devDocsRoots) {
    for (const lifecycle of ['active', 'archive']) {
      const lifecycleDir = path.join(root, lifecycle);
      const slugs = listImmediateChildDirs(lifecycleDir);
      for (const slug of slugs) {
        const taskDir = path.join(lifecycleDir, slug);
        const overviewPath = path.join(taskDir, '00-overview.md');
        const metaPath = path.join(taskDir, '.ai-task.yaml');
        tasks.push({
          root,
          lifecycle,
          slug,
          absPath: taskDir,
          relPath: path.relative(repoRoot, taskDir),
          overviewPath,
          metaPath,
        });
      }
    }
  }

  return tasks.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function parseTaskMeta(metaRaw) {
  const raw = normalizeEol(metaRaw);
  const version = parseTopLevelVersion(raw);
  const map = parseSimpleMap(raw);
  const keywords = parseSimpleList(raw, 'keywords');

  return {
    version,
    task_id: map.task_id || map.taskId || '',
    project: map.project || '',
    slug: map.slug || '',
    status: map.status || '',
    updated: map.updated || '',
    keywords,
  };
}

function renderTaskMetaYaml(meta) {
  const lines = [];
  lines.push('version: 1');
  lines.push(`task_id: ${meta.task_id}`);
  lines.push(`project: ${meta.project}`);
  lines.push(`slug: ${meta.slug}`);
  if (meta.status) lines.push(`status: ${meta.status}`);
  lines.push(`updated: "${meta.updated}"`);
  if (Array.isArray(meta.keywords) && meta.keywords.length > 0) {
    lines.push('keywords:');
    for (const k of meta.keywords) lines.push(`  - ${k}`);
  }
  lines.push('');
  return lines.join('\n');
}

function cmdInit({ repoRoot, projectSlug, dryRun, force }) {
  const hubDir = getHubDir(repoRoot, projectSlug);
  const templatesDir = getTemplatesDir(repoRoot);
  const vars = templateVars(projectSlug);

  if (!exists(templatesDir)) {
    die(`[error] Missing templates directory: ${toPosix(path.relative(repoRoot, templatesDir))}`);
  }

  const templateFiles = ['registry.yaml', 'dashboard.md', 'feature-map.md', 'task-index.md', 'changelog.md'];
  const actions = [];

  if (dryRun) {
    actions.push({ op: 'mkdir', path: hubDir, mode: 'dry-run' });
  } else {
    ensureDir(hubDir);
    actions.push({ op: 'mkdir', path: hubDir });
  }

  for (const file of templateFiles) {
    const src = path.join(templatesDir, file);
    const dst = path.join(hubDir, file);
    const existed = exists(dst);

    if (!exists(src)) {
      actions.push({ op: 'skip', path: dst, reason: `template missing: ${src}` });
      continue;
    }

    if (existed && !force) {
      actions.push({ op: 'skip', path: dst, reason: 'exists' });
      continue;
    }

    const raw = readText(src) || '';
    const rendered = renderTemplate(raw, vars);

    if (dryRun) {
      actions.push({ op: existed ? 'overwrite' : 'write', path: dst, from: src, mode: 'dry-run' });
      continue;
    }

    if (force) {
      writeText(dst, rendered);
      actions.push({ op: existed ? 'overwrite' : 'write', path: dst, from: src });
      continue;
    }

    // Non-force path already filtered existed files above.
    writeText(dst, rendered);
    actions.push({ op: 'write', path: dst, from: src });
  }

  ok('[ok] Project hub initialized.');
  for (const a of actions) {
    const mode = a.mode ? ` (${a.mode})` : '';
    const reason = a.reason ? ` [${a.reason}]` : '';
    const from = a.from ? ` <- ${toPosix(path.relative(repoRoot, a.from))}` : '';
    console.log(`  ${a.op}: ${toPosix(path.relative(repoRoot, a.path))}${from}${mode}${reason}`);
  }
}

function cmdLint({ repoRoot, projectSlug, strict }) {
  const errors = [];
  const warnings = [];
  const infos = [];

  const contractPath = path.join(repoRoot, '.ai', 'project', 'CONTRACT.md');
  if (!exists(contractPath)) {
    errors.push('Missing .ai/project/CONTRACT.md (required).');
  }

  const { registry, error: registryParseError } = loadRegistry(repoRoot, projectSlug);

  let devDocsRoots = [];
  if (registryParseError) {
    errors.push(`Failed to parse registry.yaml: ${registryParseError}`);
  }

  const resolved = resolveDevDocsRoots(registry, repoRoot);
  devDocsRoots = resolved.roots;

  if (!registry) {
    const msg =
      `Project hub is not initialized for project "${projectSlug}". ` +
      `Run when needed: node .ai/scripts/ctl-project-governance.mjs init --project ${projectSlug}`;
    if (devDocsRoots.length === 0) infos.push(msg);
    else warnings.push(msg);
  }

  if (devDocsRoots.length === 0) {
    if (registry) warnings.push('No dev-docs roots discovered.');
    else infos.push('No dev-docs roots discovered (template repository state).');
  }

  // Detect root drift: newly discovered roots not yet registered in task_doc_roots
  if (registry && resolved.newRoots.length > 0) {
    for (const r of resolved.newRoots) {
      warnings.push(
        `Root drift: "${toPosix(path.relative(repoRoot, r))}" exists on disk but is not in registry task_doc_roots. ` +
        `Run: node .ai/scripts/ctl-project-governance.mjs sync --apply --project ${projectSlug}`
      );
    }
  }

  const tasks = scanTasks(repoRoot, devDocsRoots);

  // Collect IDs and slug-to-ids mapping for cross-root checks
  const taskIdToTask = new Map();
  const slugToIds = new Map();

  const registryTaskById = new Map();
  if (registry && Array.isArray(registry.tasks)) {
    for (const t of registry.tasks) {
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id || '').trim();
      if (id) registryTaskById.set(id, t);
    }
  }

  for (const task of tasks) {
    const metaRaw = readText(task.metaPath);
    const overviewRaw = readText(task.overviewPath);

    task.taskId = null;
    task.bundleStatus = null;
    task.effectiveStatus = task.lifecycle === 'archive' ? 'archived' : null;

    if (!overviewRaw && task.lifecycle === 'active') {
      warnings.push(`${formatTaskRef(task)}: Missing 00-overview.md (task progress SoT file).`);
    }

    if (task.lifecycle === 'active' && overviewRaw) {
      const { status, error: stateError } = getBundleStatusFromOverview(overviewRaw);
      if (stateError) warnings.push(`${formatTaskRef(task)}: ${stateError}`);
      task.bundleStatus = status;
      if (status) task.effectiveStatus = status;
    }

    if (!metaRaw) {
      warnings.push(`${formatTaskRef(task)}: Missing .ai-task.yaml (migration warning).`);
      continue;
    }

    const meta = parseTaskMeta(metaRaw);

    if (meta.version !== 1) {
      errors.push(`${formatTaskRef(task)}: Invalid meta version (expected 1).`);
    }

    if (!TASK_ID_RE.test(meta.task_id)) {
      errors.push(`${formatTaskRef(task)}: Invalid task_id "${meta.task_id}" (expected T-###).`);
    } else {
      task.taskId = meta.task_id;
      if (taskIdToTask.has(meta.task_id)) {
        const other = taskIdToTask.get(meta.task_id);
        errors.push(
          `Duplicate task_id "${meta.task_id}" across repo:\n  - ${toPosix(other.relPath)}\n  - ${toPosix(task.relPath)}`
        );
      } else {
        taskIdToTask.set(meta.task_id, task);
      }

      const ids = slugToIds.get(task.slug) || new Set();
      ids.add(meta.task_id);
      slugToIds.set(task.slug, ids);
    }

    if (meta.project !== projectSlug) {
      errors.push(`${formatTaskRef(task)}: meta.project="${meta.project}" does not match --project "${projectSlug}".`);
    }

    if (meta.slug && meta.slug !== task.slug) {
      errors.push(`${formatTaskRef(task)}: meta.slug="${meta.slug}" does not match directory slug "${task.slug}".`);
    }

    if (meta.status && !TASK_STATUS.has(meta.status)) {
      errors.push(`${formatTaskRef(task)}: Invalid meta.status "${meta.status}".`);
    }

    if (meta.updated && !DATE_RE.test(meta.updated)) {
      errors.push(`${formatTaskRef(task)}: Invalid meta.updated "${meta.updated}" (expected YYYY-MM-DD).`);
    }

    // Special drift warning: meta status ahead of bundle status (not authoritative)
    if (meta.status && task.effectiveStatus) {
      if (statusRank(meta.status) > statusRank(task.effectiveStatus)) {
        warnings.push(
          `${formatTaskRef(task)}: meta.status="${meta.status}" is ahead of bundle status "${task.effectiveStatus}".`
        );
      }
    }

    // Human verification warnings
    if (task.effectiveStatus === 'done' && overviewRaw) {
      const ac = getAcceptanceCriteriaStats(overviewRaw);
      if (ac.total === 0) {
        warnings.push(`${formatTaskRef(task)}: State is done but no Acceptance criteria checkboxes were found.`);
      } else if (ac.checked < ac.total) {
        warnings.push(
          `${formatTaskRef(task)}: State is done but Acceptance criteria is not fully checked (${ac.checked}/${ac.total}).`
        );
      }
    }

    // Registry consistency checks (strict for tasks with meta)
    if (registry) {
      if (!registryTaskById.has(meta.task_id)) {
        errors.push(`${formatTaskRef(task)}: Missing registry entry for task_id "${meta.task_id}".`);
      } else {
        const entry = registryTaskById.get(meta.task_id);
        const expectedPath = toPosix(task.relPath);
        const actualPath = toPosix(String(entry.dev_docs_path || ''));
        if (actualPath !== expectedPath) {
          errors.push(
            `${formatTaskRef(task)}: registry dev_docs_path mismatch (registry="${actualPath}", expected="${expectedPath}").`
          );
        }
        const expectedStatus = task.effectiveStatus;
        const actualStatus = String(entry.status || '');
        if (expectedStatus && actualStatus && expectedStatus !== actualStatus) {
          errors.push(
            `${formatTaskRef(task)}: registry status mismatch (registry="${actualStatus}", expected="${expectedStatus}").`
          );
        }
      }
    }
  }

  // Slug conflicts across roots (error only when multiple distinct IDs exist)
  for (const [slug, ids] of slugToIds.entries()) {
    if (ids.size <= 1) continue;
    errors.push(`Slug "${slug}" appears with multiple task_ids: ${[...ids].sort().join(', ')}`);
  }

  // Reverse consistency check: registry -> file system (detect stale/orphaned entries)
  if (registry && Array.isArray(registry.tasks)) {
    const scannedPaths = new Set(tasks.map((t) => toPosix(t.relPath)));
    for (const entry of registry.tasks) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || '').trim();
      const devDocsPath = String(entry.dev_docs_path || '').trim();
      if (!id || !devDocsPath) continue;
      const absPath = path.resolve(repoRoot, devDocsPath);
      if (!scannedPaths.has(toPosix(devDocsPath)) && !exists(absPath)) {
        warnings.push(
          `Registry entry ${id} (${devDocsPath}): dev_docs directory no longer exists (stale entry). ` +
          `Run: node .ai/scripts/ctl-project-governance.mjs sync --apply --project ${projectSlug}`
        );
      }
    }
  }

  const humanWarnings = warnings.filter((w) => w.includes('Acceptance criteria') || w.includes('meta.status'));
  const otherWarnings = warnings.filter((w) => !humanWarnings.includes(w));

  if (strict && otherWarnings.length > 0) {
    // Promote non-human-verification warnings to errors, but still print them as warnings for clarity.
    for (const w of otherWarnings) errors.push(`[strict] ${w}`);
  }

  if (errors.length > 0) {
    header('Errors:');
    for (const e of errors) console.log(colors.red(`- ${e}`));
  }

  if (warnings.length > 0) {
    header('Warnings:');
    for (const w of warnings) console.log(colors.yellow(`- ${w}`));
  }

  if (infos.length > 0) {
    header('Info:');
    for (const i of infos) console.log(colors.gray(`- ${i}`));
  }

  const okExit = errors.length === 0;
  console.log(okExit ? colors.green('[ok] Lint passed.') : colors.red('[error] Lint failed.'));
  return { ok: okExit, errors, warnings, infos };
}

function formatJsonLines(rows) {
  for (const r of rows) console.log(JSON.stringify(r));
}

function cmdQuery({ repoRoot, projectSlug, id, status, text, json }) {
  // Query is designed for LLM consumption: default is JSONL (one object per line).
  // It should work even when the hub is not initialized (fallback scanning).
  const loaded = loadRegistry(repoRoot, projectSlug);
  const registry = loaded.registry;
  if (!registry && loaded.error) {
    // Keep stdout clean (JSONL/JSON), but surface the issue for operators.
    console.error(colors.yellow(`[warning] Failed to parse registry.yaml; falling back to dev-docs scan: ${loaded.error}`));
  }

  function includesText(value, needle) {
    if (!needle) return true;
    const n = String(needle).toLowerCase();
    const v = String(value || '').toLowerCase();
    return v.includes(n);
  }

  function taskMatches(t) {
    if (id && String(t.id || '') !== id) return false;
    if (status && String(t.status || '').trim() !== status) return false;
    if (text) {
      const blobParts = [];
      for (const k of ['id', 'slug', 'title', 'description', 'status', 'dev_docs_path', 'feature_id', 'milestone_id']) {
        blobParts.push(String(t[k] || ''));
      }
      if (Array.isArray(t.keywords)) blobParts.push(t.keywords.join(' '));
      const blob = blobParts.join('\n');
      if (!includesText(blob, text)) return false;
    }
    return true;
  }

  // If the hub exists, query registry tasks directly.
  if (registry && Array.isArray(registry.tasks)) {
    const rows = registry.tasks
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: String(t.id || ''),
        status: String(t.status || ''),
        slug: String(t.slug || ''),
        dev_docs_path: String(t.dev_docs_path || ''),
        feature_id: String(t.feature_id || ''),
        milestone_id: String(t.milestone_id || ''),
        title: String(t.title || ''),
        updated: String(t.updated || ''),
        keywords: Array.isArray(t.keywords) ? t.keywords.map((k) => String(k)) : [],
      }))
      .filter(taskMatches)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    if (json) console.log(JSON.stringify(rows));
    else formatJsonLines(rows);
    return { ok: true, rows };
  }

  // Fallback: scan dev-docs roots (no hub required).
  const { roots } = resolveDevDocsRoots(registry, repoRoot);
  const tasks = scanTasks(repoRoot, roots);
  const rows = [];

  for (const task of tasks) {
    const overviewRaw = readText(task.overviewPath);
    const metaRaw = readText(task.metaPath);

    const effectiveStatus =
      task.lifecycle === 'archive'
        ? 'archived'
        : (() => {
            if (!overviewRaw) return '';
            const { status } = getBundleStatusFromOverview(overviewRaw);
            return status || '';
          })();

    let taskId = '';
    let keywords = [];
    if (metaRaw) {
      const meta = parseTaskMeta(metaRaw);
      if (TASK_ID_RE.test(meta.task_id)) taskId = meta.task_id;
      keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
    }

    const row = {
      id: taskId,
      status: effectiveStatus,
      slug: task.slug,
      dev_docs_path: toPosix(task.relPath),
      updated: '',
      keywords: keywords.map((k) => String(k)),
      meta_missing: !metaRaw,
      overview_missing: !overviewRaw,
    };

    if (taskMatches(row)) rows.push(row);
  }

  rows.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  if (json) console.log(JSON.stringify(rows));
  else formatJsonLines(rows);
  return { ok: true, rows };
}

function computeChangelogEntries({ prevById, nextById, todayStr }) {
  const lines = [];

  for (const [id, next] of nextById.entries()) {
    const prev = prevById.get(id);
    if (!prev) {
      lines.push(
        `- ${todayStr} task_id=${id} slug=${next.slug || ''} event=registered dev_docs_path=${next.dev_docs_path || ''}`.trimEnd()
      );
      continue;
    }
    const prevStatus = String(prev.status || '');
    const nextStatus = String(next.status || '');
    if (prevStatus && nextStatus && prevStatus !== nextStatus) {
      lines.push(
        `- ${todayStr} task_id=${id} slug=${next.slug || ''} event=status from=${prevStatus} to=${nextStatus}`.trimEnd()
      );
    }
  }

  return lines;
}

function appendChangelog({ repoRoot, changelogPath, entries, dryRun, apply, initIfMissing, projectSlug }) {
  if (!entries || entries.length === 0) return;

  let base = readText(changelogPath);
  if (!base && initIfMissing) {
    const templatesDir = getTemplatesDir(repoRoot);
    const tpl = path.join(templatesDir, 'changelog.md');
    const tplRaw = readText(tpl);
    if (tplRaw) base = renderTemplate(tplRaw, templateVars(projectSlug));
  }

  if (!base) {
    // Do not fail sync for changelog issues.
    return { ok: false, error: `Missing changelog file: ${toPosix(path.relative(repoRoot, changelogPath))}` };
  }

  const normalized = normalizeEol(base).trimEnd() + '\n';
  const hasEntries = /(^|\n)## Entries\n/.test(normalized);
  const toAppend = entries.join('\n') + '\n';
  const next = hasEntries ? normalized + toAppend : normalized + '\n## Entries\n' + toAppend;

  if (dryRun || !apply) {
    return { ok: true, planned: true, next };
  }

  const changed = writeTextIfChanged(changelogPath, next);
  return { ok: true, changed };
}

function cmdSync({ repoRoot, projectSlug, dryRun, apply, initIfMissing, changelog }) {
  const actions = [];
  const errors = [];
  const warnings = [];

  const registryPath = getRegistryPath(repoRoot, projectSlug);
  let reg = null;
  let hubMissing = !exists(registryPath);

  if (!hubMissing) {
    const loaded = loadRegistry(repoRoot, projectSlug);
    if (!loaded.registry) {
      errors.push(`Failed to parse registry.yaml: ${loaded.error || '(unknown error)'}`);
      return { ok: false, errors, warnings, actions };
    }
    reg = loaded.registry;
  } else {
    if (!initIfMissing) {
      errors.push(
        `Project hub missing for "${projectSlug}". Run: node .ai/scripts/ctl-project-governance.mjs init --project ${projectSlug}`
      );
      return { ok: false, errors, warnings, actions };
    }

    const templatesDir = getTemplatesDir(repoRoot);
    const tplRegistryPath = path.join(templatesDir, 'registry.yaml');
    const tplRaw = readText(tplRegistryPath);
    if (!tplRaw) {
      errors.push(`Missing registry template: ${toPosix(path.relative(repoRoot, tplRegistryPath))}`);
      return { ok: false, errors, warnings, actions };
    }

    try {
      reg = parseYamlDoc(renderTemplate(tplRaw, templateVars(projectSlug)));
    } catch (e) {
      errors.push(`Failed to parse registry template: ${e.message || String(e)}`);
      return { ok: false, errors, warnings, actions };
    }

    // Plan/init hub files if missing
    const hubDir = getHubDir(repoRoot, projectSlug);
    const templateFiles = ['registry.yaml', 'dashboard.md', 'feature-map.md', 'task-index.md', 'changelog.md'];
    if (dryRun || !apply) {
      actions.push({ op: 'mkdir', path: hubDir, note: 'init hub', mode: 'dry-run' });
      for (const file of templateFiles) {
        actions.push({
          op: 'write',
          path: path.join(hubDir, file),
          note: 'init hub',
          mode: 'dry-run',
        });
      }
    } else {
      cmdInit({ repoRoot, projectSlug, dryRun: false, force: false });
      hubMissing = false;
      const loaded = loadRegistry(repoRoot, projectSlug);
      if (!loaded.registry) {
        errors.push(`Cannot load registry after init: ${toPosix(path.relative(repoRoot, registryPath))}`);
        return { ok: false, errors, warnings, actions };
      }
      reg = loaded.registry;
    }
  }

  // Snapshot previous registry tasks for optional changelog append.
  const prevById = new Map();
  if (reg && Array.isArray(reg.tasks)) {
    for (const t of reg.tasks) {
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id || '').trim();
      if (!id) continue;
      prevById.set(id, {
        status: String(t.status || ''),
        slug: String(t.slug || ''),
        dev_docs_path: String(t.dev_docs_path || ''),
      });
    }
  }

  // Unified roots resolution (configured + discovered, merged & deduplicated).
  const resolved = resolveDevDocsRoots(reg, repoRoot);
  let roots = resolved.roots;

  const tasks = scanTasks(repoRoot, roots);

  // Allocate IDs for missing meta
  const existingIds = new Set();
  for (const task of tasks) {
    const raw = readText(task.metaPath);
    if (!raw) continue;
    const meta = parseTaskMeta(raw);
    if (TASK_ID_RE.test(meta.task_id)) existingIds.add(meta.task_id);
  }

  // Also include any IDs already present in the registry to avoid reusing historical IDs.
  if (Array.isArray(reg.tasks)) {
    for (const t of reg.tasks) {
      if (!t || typeof t !== 'object') continue;
      const id = String(t.id || '').trim();
      if (TASK_ID_RE.test(id)) existingIds.add(id);
    }
  }

  function nextId() {
    // Allocate monotonically increasing IDs (best-effort) to avoid reusing historical task IDs.
    let max = 0;
    for (const id of existingIds) {
      const n = Number(String(id).slice(2));
      if (Number.isFinite(n) && n > max) max = n;
    }

    let candidate = max + 1;
    while (candidate <= 999) {
      const id = `T-${String(candidate).padStart(3, '0')}`;
      if (!existingIds.has(id)) {
        existingIds.add(id);
        return id;
      }
      candidate++;
    }
    throw new Error('Exhausted task IDs (T-000..T-999).');
  }

  const todayStr = today();

  // Build/refresh registry tasks
  if (!Array.isArray(reg.tasks)) reg.tasks = [];
  const tasksById = new Map();
  for (const t of reg.tasks) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').trim();
    if (id) tasksById.set(id, t);
  }

  for (const task of tasks) {
    const overviewRaw = readText(task.overviewPath);
    const metaRaw = readText(task.metaPath);

    const effectiveStatus = task.lifecycle === 'archive' ? 'archived' : (() => {
      if (!overviewRaw) return null;
      const { status } = getBundleStatusFromOverview(overviewRaw);
      return status;
    })();

    if (!metaRaw) {
      const id = nextId();
      const meta = {
        task_id: id,
        project: projectSlug,
        slug: task.slug,
        status: effectiveStatus || 'planned',
        updated: todayStr,
        keywords: [],
      };
      const rendered = renderTaskMetaYaml(meta);
      if (dryRun || !apply) {
        actions.push({ op: 'write', path: task.metaPath, note: `allocate ${id}`, mode: 'dry-run' });
      } else {
        writeText(task.metaPath, rendered);
        actions.push({ op: 'write', path: task.metaPath, note: `allocate ${id}` });
      }
      task.taskId = id;
    } else {
      const meta = parseTaskMeta(metaRaw);
      if (!TASK_ID_RE.test(meta.task_id)) {
        warnings.push(`${toPosix(task.relPath)}: Invalid task_id; sync will not auto-repair without manual fix.`);
        continue;
      }
      task.taskId = meta.task_id;

      const desiredStatus = effectiveStatus || meta.status || 'planned';
      const shouldUpdate = desiredStatus !== meta.status || meta.slug !== task.slug || meta.project !== projectSlug;

      if (shouldUpdate) {
        const nextMeta = {
          task_id: meta.task_id,
          project: projectSlug,
          slug: task.slug,
          status: desiredStatus,
          updated: todayStr,
          keywords: meta.keywords || [],
        };
        const rendered = renderTaskMetaYaml(nextMeta);
        if (dryRun || !apply) {
          actions.push({ op: 'update', path: task.metaPath, note: 'refresh derived fields', mode: 'dry-run' });
        } else {
          const changed = writeTextIfChanged(task.metaPath, rendered);
          if (changed) actions.push({ op: 'update', path: task.metaPath, note: 'refresh derived fields' });
        }
      }
    }

    if (!task.taskId) continue;

    const entry = tasksById.get(task.taskId) || { id: task.taskId };
    const prevStatus = entry.status;
    entry.slug = task.slug;
    entry.status = effectiveStatus || entry.status || 'planned';
    entry.dev_docs_path = toPosix(task.relPath);
    if (!entry.updated || entry.status !== prevStatus) entry.updated = todayStr;
    if (!entry.feature_id) entry.feature_id = 'F-000';
    if (!entry.milestone_id) entry.milestone_id = 'M-000';

    tasksById.set(task.taskId, entry);
  }

  // Detect stale registry entries (dev_docs directory no longer exists)
  const scannedTaskIds = new Set(tasks.filter((t) => t.taskId).map((t) => t.taskId));
  for (const [id, entry] of tasksById.entries()) {
    if (scannedTaskIds.has(id)) continue;
    const devDocsPath = String(entry.dev_docs_path || '');
    if (!devDocsPath) continue;
    const absPath = path.resolve(repoRoot, devDocsPath);
    if (!exists(absPath)) {
      if (entry.status !== 'archived') {
        const prevStatus = entry.status;
        entry.status = 'archived';
        entry.updated = todayStr;
        actions.push({
          op: 'update',
          target: 'registry',
          id,
          path: registryPath,
          note: `stale entry: dev_docs removed, status ${prevStatus} -> archived`,
        });
        warnings.push(
          `Registry entry ${id} (${devDocsPath}): dev_docs directory no longer exists; marking as archived.`
        );
      }
    }
  }

  reg.tasks = [...tasksById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Optional changelog entries are derived from prev->next registry drift.
  const nextById = new Map();
  for (const t of reg.tasks) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').trim();
    if (!id) continue;
    nextById.set(id, {
      status: String(t.status || ''),
      slug: String(t.slug || ''),
      dev_docs_path: String(t.dev_docs_path || ''),
    });
  }

  // Ensure system nodes exist
  if (!Array.isArray(reg.milestones)) reg.milestones = [];
  if (!reg.milestones.some((m) => m && m.id === 'M-000')) {
    reg.milestones.unshift({
      id: 'M-000',
      title: 'Inbox / Triage',
      status: 'in-progress',
      description: 'Triage queue for new or unplanned work.',
    });
  }
  if (!Array.isArray(reg.features)) reg.features = [];
  if (!reg.features.some((f) => f && f.id === 'F-000')) {
    reg.features.unshift({
      id: 'F-000',
      title: 'Inbox / Untriaged',
      milestone_id: 'M-000',
      status: 'in-progress',
      description: 'Untriaged tasks live here until mapped to a real feature.',
    });
  }
  if (!Array.isArray(reg.requirements)) reg.requirements = [];
  if (!reg.project || typeof reg.project !== 'object') reg.project = {};
  // Always refresh task_doc_roots to include newly discovered roots (prevents silent omission).
  reg.project.task_doc_roots = roots.map((r) => toPosix(path.relative(repoRoot, r)));
  if (!reg.project.slug) reg.project.slug = projectSlug;
  if (!reg.project.id) reg.project.id = 'P-001';
  if (!reg.project.name) reg.project.name = projectSlug === 'main' ? 'Main' : projectSlug;

  // Write registry
  const registryOut = dumpYamlDoc(reg);
  if (dryRun || !apply) {
    actions.push({ op: 'update', path: registryPath, note: 'update registry', mode: 'dry-run' });
  } else {
    const changed = writeTextIfChanged(registryPath, registryOut);
    if (changed) actions.push({ op: 'update', path: registryPath, note: 'update registry' });
  }

  // Optional: append changelog events (apply-mode only; append-only).
  if (changelog) {
    const hubDir = getHubDir(repoRoot, projectSlug);
    const changelogPath = path.join(hubDir, 'changelog.md');
    const entries = computeChangelogEntries({ prevById, nextById, todayStr });
    const res = appendChangelog({
      repoRoot,
      changelogPath,
      entries,
      dryRun,
      apply,
      initIfMissing,
      projectSlug,
    });
    if (res?.ok === false) {
      warnings.push(String(res.error || 'Failed to append changelog.'));
    } else if (entries.length > 0) {
      actions.push({
        op: 'append',
        path: changelogPath,
        note: `changelog (${entries.length} entries)`,
        mode: dryRun || !apply ? 'dry-run' : undefined,
      });
    }
  }

  // Derived views
  const templatesDir = getTemplatesDir(repoRoot);
  const vars = templateVars(projectSlug);

  const hubDir = getHubDir(repoRoot, projectSlug);
  const dashboardPath = path.join(hubDir, 'dashboard.md');
  const featureMapPath = path.join(hubDir, 'feature-map.md');
  const taskIndexPath = path.join(hubDir, 'task-index.md');

  const regTasks = Array.isArray(reg.tasks) ? reg.tasks : [];
  const counts = { total: regTasks.length, planned: 0, inProgress: 0, blocked: 0, done: 0, archived: 0 };
  for (const t of regTasks) {
    const st = String(t.status || '');
    if (st === 'planned') counts.planned++;
    else if (st === 'in-progress') counts.inProgress++;
    else if (st === 'blocked') counts.blocked++;
    else if (st === 'done') counts.done++;
    else if (st === 'archived') counts.archived++;
  }

  const dashAuto = [
    '## Summary',
    '',
    `- Tasks: ${counts.total} (planned: ${counts.planned}, in-progress: ${counts.inProgress}, blocked: ${counts.blocked}, done: ${counts.done}, archived: ${counts.archived})`,
    '',
    '## Recent tasks',
    '',
    '| Task | Status | Feature | Dev Docs |',
    '| --- | --- | --- | --- |',
    ...regTasks
      .slice()
      .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
      .slice(0, 20)
      .map((t) => {
        const taskLabel = `${t.id} ${t.slug || ''}`.trim();
        const feature = String(t.feature_id || '');
        const dev = String(t.dev_docs_path || '');
        return `| ${taskLabel} | ${t.status || ''} | ${feature} | ${dev} |`;
      }),
    '',
  ].join('\n');

  const featureAutoLines = [];
  featureAutoLines.push('## Features');
  featureAutoLines.push('');
  const features = Array.isArray(reg.features) ? reg.features : [];
  const byFeature = new Map();
  for (const t of regTasks) {
    const fid = String(t.feature_id || 'F-000');
    const list = byFeature.get(fid) || [];
    list.push(t);
    byFeature.set(fid, list);
  }
  for (const f of features.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!f || typeof f !== 'object') continue;
    const fid = String(f.id || '');
    const title = String(f.title || '');
    const list = (byFeature.get(fid) || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    featureAutoLines.push(`### ${fid} ${title}`.trim());
    featureAutoLines.push('');
    if (list.length === 0) {
      featureAutoLines.push('- (no tasks)');
      featureAutoLines.push('');
      continue;
    }
    featureAutoLines.push('| Task | Status | Dev Docs |');
    featureAutoLines.push('| --- | --- | --- |');
    for (const t of list) {
      const label = `${t.id} ${t.slug || ''}`.trim();
      featureAutoLines.push(`| ${label} | ${t.status || ''} | ${t.dev_docs_path || ''} |`);
    }
    featureAutoLines.push('');
  }
  const featureAuto = featureAutoLines.join('\n').trimEnd() + '\n';

  const taskIndexAutoLines = [];
  taskIndexAutoLines.push('## Tasks');
  taskIndexAutoLines.push('');
  taskIndexAutoLines.push('| Task | Status | Feature | Dev Docs |');
  taskIndexAutoLines.push('| --- | --- | --- | --- |');
  for (const t of regTasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const label = `${t.id} ${t.slug || ''}`.trim();
    taskIndexAutoLines.push(`| ${label} | ${t.status || ''} | ${t.feature_id || ''} | ${t.dev_docs_path || ''} |`);
  }
  taskIndexAutoLines.push('');
  const taskIndexAuto = taskIndexAutoLines.join('\n');

  function updateDerived(filePath, blockId, content) {
    let base = readText(filePath);
    if (!base && initIfMissing) {
      // In init-if-missing mode, use the rendered template as the base for dry-run planning.
      const tplName = path.basename(filePath);
      const tplPath = path.join(templatesDir, tplName);
      const tplRaw = readText(tplPath);
      if (tplRaw) base = renderTemplate(tplRaw, vars);
    }

    if (!base) {
      warnings.push(`Missing derived view file: ${toPosix(path.relative(repoRoot, filePath))} (run init).`);
      return;
    }

    const next = replaceAutoBlock(base, blockId, content);
    if (dryRun || !apply) {
      actions.push({ op: 'update', path: filePath, note: `regen ${blockId}`, mode: 'dry-run' });
      return;
    }

    const changed = writeTextIfChanged(filePath, next);
    if (changed) actions.push({ op: 'update', path: filePath, note: `regen ${blockId}` });
  }

  updateDerived(dashboardPath, 'dashboard', dashAuto);
  updateDerived(featureMapPath, 'feature-map', featureAuto);
  updateDerived(taskIndexPath, 'task-index', taskIndexAuto);

  // Summary
  const okExit = errors.length === 0;
  if (!okExit) {
    header('Errors:');
    for (const e of errors) console.log(colors.red(`- ${e}`));
  }
  if (warnings.length > 0) {
    header('Warnings:');
    for (const w of warnings) console.log(colors.yellow(`- ${w}`));
  }

  if (okExit) ok('[ok] Sync complete.');
  else console.log(colors.red('[error] Sync failed.'));

  for (const a of actions) {
    const mode = a.mode ? ` (${a.mode})` : '';
    const note = a.note ? ` (${a.note})` : '';
    const label = a.target === 'registry'
      ? `registry[${a.id}]`
      : toPosix(path.relative(repoRoot, a.path));
    console.log(`  ${a.op}: ${label}${note}${mode}`);
  }

  return { ok: okExit, errors, warnings, actions, _printed: true };
}

function cmdMap({ repoRoot, projectSlug, taskId, featureId, milestoneId, requirementId, dryRun, apply }) {
  const errors = [];
  const actions = [];

  if (!taskId || !TASK_ID_RE.test(taskId)) {
    errors.push(`Invalid or missing --task (expected T-###, got "${taskId || ''}").`);
    return { ok: false, errors, actions };
  }

  if (!featureId && !milestoneId && !requirementId) {
    errors.push('At least one of --feature, --milestone, or --requirement is required.');
    return { ok: false, errors, actions };
  }

  // Validate ID formats (strong SSOT constraint)
  if (featureId && !FEATURE_ID_RE.test(featureId)) {
    errors.push(`Invalid --feature format (expected F-###, got "${featureId}").`);
    return { ok: false, errors, actions };
  }
  if (milestoneId && !MILESTONE_ID_RE.test(milestoneId)) {
    errors.push(`Invalid --milestone format (expected M-###, got "${milestoneId}").`);
    return { ok: false, errors, actions };
  }
  if (requirementId && !REQUIREMENT_ID_RE.test(requirementId)) {
    errors.push(`Invalid --requirement format (expected R-###, got "${requirementId}").`);
    return { ok: false, errors, actions };
  }

  const loaded = loadRegistry(repoRoot, projectSlug);
  if (!loaded.registry) {
    errors.push(`Failed to load registry: ${loaded.error || 'registry not found'}`);
    return { ok: false, errors, actions };
  }

  const reg = loaded.registry;
  const registryPath = loaded.path;

  // Find the task in registry
  if (!Array.isArray(reg.tasks)) reg.tasks = [];
  const taskEntry = reg.tasks.find((t) => t && t.id === taskId);
  if (!taskEntry) {
    errors.push(`Task "${taskId}" not found in registry. Run sync first.`);
    return { ok: false, errors, actions };
  }

  // Validate feature exists
  if (featureId) {
    const featureExists = Array.isArray(reg.features) && reg.features.some((f) => f && f.id === featureId);
    if (!featureExists) {
      errors.push(`Feature "${featureId}" not found in registry.`);
      return { ok: false, errors, actions };
    }
  }

  // Validate milestone exists
  if (milestoneId) {
    const milestoneExists = Array.isArray(reg.milestones) && reg.milestones.some((m) => m && m.id === milestoneId);
    if (!milestoneExists) {
      errors.push(`Milestone "${milestoneId}" not found in registry.`);
      return { ok: false, errors, actions };
    }
  }

  // Validate/create requirement
  if (requirementId) {
    if (!Array.isArray(reg.requirements)) reg.requirements = [];
    const reqExists = reg.requirements.some((r) => r && r.id === requirementId);
    if (!reqExists) {
      // Auto-create the requirement entry
      reg.requirements.push({
        id: requirementId,
        title: `(auto-created for ${taskId})`,
        feature_id: featureId || taskEntry.feature_id || 'F-000',
        status: 'planned',
      });
      actions.push({ op: 'create', target: 'requirement', id: requirementId, note: 'auto-created' });
    }
  }

  // Apply mappings
  const changes = [];
  if (featureId && taskEntry.feature_id !== featureId) {
    changes.push(`feature_id: ${taskEntry.feature_id || '(none)'} -> ${featureId}`);
    taskEntry.feature_id = featureId;
  }
  if (milestoneId && taskEntry.milestone_id !== milestoneId) {
    changes.push(`milestone_id: ${taskEntry.milestone_id || '(none)'} -> ${milestoneId}`);
    taskEntry.milestone_id = milestoneId;
  }
  if (requirementId) {
    const reqIds = Array.isArray(taskEntry.requirement_ids) ? taskEntry.requirement_ids : [];
    if (!reqIds.includes(requirementId)) {
      reqIds.push(requirementId);
      taskEntry.requirement_ids = reqIds;
      changes.push(`requirement_ids: added ${requirementId}`);
    }
  }

  if (changes.length === 0) {
    ok(`[ok] Task ${taskId} already has the specified mapping. No changes needed.`);
    return { ok: true, errors, actions };
  }

  taskEntry.updated = today();
  actions.push({ op: 'update', target: 'task', id: taskId, changes });

  if (dryRun || !apply) {
    header('Planned changes:');
    for (const a of actions) {
      const changesStr = a.changes ? `: ${a.changes.join(', ')}` : '';
      const noteStr = a.note ? ` (${a.note})` : '';
      console.log(`  ${a.op} ${a.target} ${a.id}${changesStr}${noteStr}`);
    }
    info('(dry-run mode; use --apply to write changes)');
    return { ok: true, errors, actions };
  }

  // Write registry
  const registryOut = dumpYamlDoc(reg);
  const changed = writeTextIfChanged(registryPath, registryOut);
  if (changed) {
    actions.push({ op: 'write', path: registryPath });
  }

  ok(`[ok] Mapped ${taskId}:`);
  for (const c of changes) console.log(`  - ${c}`);

  return { ok: true, errors, actions };
}

function main() {
  const { command, opts } = parseArgs(process.argv);
  const repoRoot =
    opts['repo-root'] ? path.resolve(opts['repo-root']) : findRepoRoot(process.cwd()) || path.resolve(process.cwd());
  const projectSlug = String(opts.project || DEFAULT_PROJECT).trim() || DEFAULT_PROJECT;

  switch (command) {
    case 'init':
      cmdInit({ repoRoot, projectSlug, dryRun: !!opts['dry-run'], force: !!opts.force });
      break;
    case 'lint': {
      const strict = !!opts.strict;
      const { ok: okLint } = cmdLint({ repoRoot, projectSlug, strict });
      process.exit(okLint ? 0 : 1);
      break;
    }
    case 'sync': {
      const dryRun = !!opts['dry-run'];
      const apply = !!opts.apply;
      if (!dryRun && !apply) {
        info('No mode specified; defaulting to --dry-run.');
      }
      const res = cmdSync({
        repoRoot,
        projectSlug,
        dryRun: dryRun || !apply,
        apply: apply && !dryRun,
        initIfMissing: !!opts['init-if-missing'],
        changelog: !!opts.changelog,
      });
      // Ensure errors/warnings from early-return paths are always printed
      // (the normal path sets res._printed = true and handles its own output)
      if (!res._printed) {
        if (!res.ok && Array.isArray(res.errors) && res.errors.length > 0) {
          header('Sync errors:');
          for (const e of res.errors) console.log(colors.red(`- ${e}`));
        }
        if (Array.isArray(res.warnings) && res.warnings.length > 0) {
          header('Sync warnings:');
          for (const w of res.warnings) console.log(colors.yellow(`- ${w}`));
        }
      }
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'query': {
      const id = opts.id ? String(opts.id).trim() : '';
      const status = opts.status ? String(opts.status).trim() : '';
      const text = opts.text ? String(opts.text) : '';
      const json = !!opts.json;
      const res = cmdQuery({
        repoRoot,
        projectSlug,
        id: id || null,
        status: status || null,
        text: text || null,
        json,
      });
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'map': {
      const taskId = opts.task ? String(opts.task).trim() : '';
      const featureId = opts.feature ? String(opts.feature).trim() : '';
      const milestoneId = opts.milestone ? String(opts.milestone).trim() : '';
      const requirementId = opts.requirement ? String(opts.requirement).trim() : '';
      const dryRun = !!opts['dry-run'];
      const apply = !!opts.apply;
      if (!dryRun && !apply) {
        info('No mode specified; defaulting to --dry-run.');
      }
      const res = cmdMap({
        repoRoot,
        projectSlug,
        taskId,
        featureId: featureId || null,
        milestoneId: milestoneId || null,
        requirementId: requirementId || null,
        dryRun: dryRun || !apply,
        apply: apply && !dryRun,
      });
      if (!res.ok) {
        header('Errors:');
        for (const e of res.errors) console.log(colors.red(`- ${e}`));
      }
      process.exit(res.ok ? 0 : 1);
      break;
    }
    default:
      console.error(colors.red(`[error] Unknown command: ${command}`));
      usage(1);
  }
}

main();
