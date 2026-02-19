/**
 * YAML parsing and serialization utilities (dependency-free)
 *
 * Provides basic YAML parsing and serialization for the modular system.
 * Handles nested objects, arrays, and common YAML patterns.
 *
 * Usage:
 *   import { loadYamlFile, saveYamlFile, dumpYaml, parseYaml } from './lib/yaml.mjs';
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a YAML string into a JavaScript object.
 * Supports: scalars, objects, arrays, multi-line strings, quoted strings.
 * Rejects: anchors (&), aliases (*), tags (!!), merge keys (<<).
 *
 * @param {string} raw - YAML content
 * @returns {any}
 */
export function parseYaml(raw) {
  _detectUnsupportedSyntax(raw);
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const result = parseBlock(lines, 0, 0).value;
  return result;
}

/**
 * Scan for YAML features this parser does not support and fail fast.
 * Detected: anchors (&name), aliases (*name), tags (!!type), merge keys (<<).
 * Only checks positions that are outside quoted strings to avoid false positives
 * on Markdown emphasis (*bold*) or HTML entities (&amp;).
 */
function _detectUnsupportedSyntax(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = _stripQuotedContent(line);
    if (/(?::\s+|^[\s-]*)\*\w/.test(stripped)) {
      throw new Error(`YAML aliases (*) are not supported (line ${i + 1})`);
    }
    if (/(?::\s+|^[\s-]*|,\s*)&\w/.test(stripped)) {
      throw new Error(`YAML anchors (&) are not supported (line ${i + 1})`);
    }
    if (/(?:^|\s)!!/.test(stripped)) {
      throw new Error(`YAML tags (!!) are not supported (line ${i + 1})`);
    }
    if (/(?:^|\s)<<\s*:/.test(stripped)) {
      throw new Error(`YAML merge keys (<<) are not supported (line ${i + 1})`);
    }
  }
}

/**
 * Replace quoted string contents with spaces, preserving positions.
 * Used by _detectUnsupportedSyntax to avoid false positives.
 */
function _stripQuotedContent(line) {
  let result = '';
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      result += ' ';
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      result += ' ';
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Strip inline YAML comments while respecting quoted strings.
 * A '#' is only a comment if preceded by whitespace and outside quotes.
 */
function _stripCommentSafe(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Find the key-value separator colon, skipping colons inside quoted strings.
 * Returns the index of the separator colon, or -1 if not found.
 */
function _findKeyColon(str) {
  let inQuote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 >= str.length || str[i + 1] === ' ' || str[i + 1] === '\t')) {
      return i;
    }
  }
  return -1;
}

/**
 * Unquote a YAML key (strip surrounding single or double quotes).
 */
function _unquoteKey(key) {
  const t = key.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a block of YAML lines starting at a given index and indentation level.
 */
function parseBlock(lines, startIdx, baseIndent) {
  let idx = startIdx;
  let result = null;
  let isArray = false;
  let isObject = false;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = _stripCommentSafe(line).trimEnd();
    
    if (trimmed === '' || trimmed.match(/^\s*#/)) {
      idx++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent === -1) {
      idx++;
      continue;
    }

    if (indent < baseIndent) {
      break;
    }

    // Array item
    if (trimmed.match(/^\s*-\s*/)) {
      if (!isArray && result === null) {
        result = [];
        isArray = true;
      }
      
      const afterDash = trimmed.replace(/^\s*-\s*/, '');
      const dashIndent = line.indexOf('-');
      
      if (afterDash === '') {
        const nested = parseBlock(lines, idx + 1, dashIndent + 2);
        result.push(nested.value);
        idx = nested.nextIdx;
      } else if (_findKeyColon(afterDash) !== -1) {
        const colonIdx = _findKeyColon(afterDash);
        const key = _unquoteKey(afterDash.slice(0, colonIdx));
        const valueStr = afterDash.slice(colonIdx + 1).trim();
        
        if (valueStr === '' || valueStr === '|' || valueStr === '>') {
          const nested = parseBlock(lines, idx + 1, dashIndent + 2);
          const obj = { [key]: nested.value };
          
          let siblingIdx = nested.nextIdx;
          while (siblingIdx < lines.length) {
            const sibLine = lines[siblingIdx];
            const sibTrimmed = _stripCommentSafe(sibLine).trimEnd();
            if (sibTrimmed === '') {
              siblingIdx++;
              continue;
            }
            const sibIndent = sibLine.search(/\S/);
            if (sibIndent <= dashIndent || sibTrimmed.trimStart().startsWith('-')) {
              break;
            }
            const sibColonIdx = _findKeyColon(sibTrimmed);
            if (sibIndent === dashIndent + 2 && sibColonIdx !== -1) {
              const sibKey = _unquoteKey(sibTrimmed.slice(0, sibColonIdx));
              const sibValue = sibTrimmed.slice(sibColonIdx + 1).trim();
              if (sibValue === '' || sibValue === '|' || sibValue === '>') {
                const sibNested = parseBlock(lines, siblingIdx + 1, sibIndent + 2);
                obj[sibKey] = sibNested.value;
                siblingIdx = sibNested.nextIdx;
              } else {
                obj[sibKey] = parseScalar(sibValue);
                siblingIdx++;
              }
            } else {
              break;
            }
          }
          result.push(obj);
          idx = siblingIdx;
        } else {
          const obj = { [key]: parseScalar(valueStr) };
          idx++;
          
          while (idx < lines.length) {
            const nextLine = lines[idx];
            const nextTrimmed = _stripCommentSafe(nextLine).trimEnd();
            if (nextTrimmed === '') {
              idx++;
              continue;
            }
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent <= dashIndent || nextTrimmed.trimStart().startsWith('-')) {
              break;
            }
            const nextColonIdx = _findKeyColon(nextTrimmed);
            if (nextColonIdx !== -1) {
              const nextKey = _unquoteKey(nextTrimmed.slice(0, nextColonIdx));
              const nextValue = nextTrimmed.slice(nextColonIdx + 1).trim();
              if (nextValue === '' || nextValue === '|' || nextValue === '>') {
                const nested = parseBlock(lines, idx + 1, nextIndent + 2);
                obj[nextKey] = nested.value;
                idx = nested.nextIdx;
              } else {
                obj[nextKey] = parseScalar(nextValue);
                idx++;
              }
            } else {
              break;
            }
          }
          result.push(obj);
        }
      } else {
        result.push(parseScalar(afterDash));
        idx++;
      }
      continue;
    }

    // Key-value pair
    const colonIdx = _findKeyColon(trimmed);
    if (colonIdx !== -1) {
      if (!isObject && result === null) {
        result = {};
        isObject = true;
      }
      
      const key = _unquoteKey(trimmed.slice(0, colonIdx));
      const valueStr = trimmed.slice(colonIdx + 1).trim();
      
      if (valueStr === '' || valueStr === '|' || valueStr === '>') {
        const nested = parseBlock(lines, idx + 1, indent + 2);
        result[key] = nested.value;
        idx = nested.nextIdx;
      } else if (valueStr === '[]') {
        result[key] = [];
        idx++;
      } else if (valueStr === '{}') {
        result[key] = {};
        idx++;
      } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
        result[key] = parseInlineArray(valueStr);
        idx++;
      } else if (valueStr.startsWith('{') && valueStr.endsWith('}')) {
        result[key] = parseInlineObject(valueStr);
        idx++;
      } else {
        result[key] = parseScalar(valueStr);
        idx++;
      }
      continue;
    }

    idx++;
  }

  return { value: result, nextIdx: idx };
}

/**
 * Parse a scalar value (string, number, boolean, null).
 * Also handles inline flow collections ([], {}).
 */
function parseScalar(str) {
  const trimmed = str.trim();
  
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') {
    return null;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseInlineArray(trimmed);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseInlineObject(trimmed);
  }
  
  // Quoted string (single-pass unescape to avoid \\n → \n → newline regression)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\nrt0a])/g, (_m, ch) => {
      switch (ch) {
        case '"': return '"';
        case '\\': return '\\';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case '0': return '\0';
        case 'a': return '\x07';
        default: return ch;
      }
    });
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  
  // Number
  if (/^-?\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return parseFloat(trimmed);
  }
  
  return trimmed;
}

/**
 * Parse an inline array like [a, b, c].
 */
function parseInlineArray(str) {
  const inner = str.slice(1, -1).trim();
  if (inner === '') return [];
  
  const items = [];
  let current = '';
  let depth = 0;
  let inQuote = null;
  
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    
    if (ch === '[' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    
    if (ch === ']' || ch === '}') {
      depth--;
      current += ch;
      continue;
    }
    
    if (ch === ',' && depth === 0) {
      items.push(parseScalar(current.trim()));
      current = '';
      continue;
    }
    
    current += ch;
  }
  
  if (current.trim()) {
    items.push(parseScalar(current.trim()));
  }
  
  return items;
}

/**
 * Parse an inline object like {a: 1, b: 2}.
 */
function parseInlineObject(str) {
  const inner = str.slice(1, -1).trim();
  if (inner === '') return {};
  
  const obj = {};
  let current = '';
  let depth = 0;
  let inQuote = null;
  
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    
    if (ch === '[' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    
    if (ch === ']' || ch === '}') {
      depth--;
      current += ch;
      continue;
    }
    
    if (ch === ',' && depth === 0) {
      const colonIdx = current.indexOf(':');
      if (colonIdx !== -1) {
        const key = current.slice(0, colonIdx).trim();
        const value = current.slice(colonIdx + 1).trim();
        obj[key] = parseScalar(value);
      }
      current = '';
      continue;
    }
    
    current += ch;
  }
  
  if (current.trim()) {
    const colonIdx = current.indexOf(':');
    if (colonIdx !== -1) {
      const key = current.slice(0, colonIdx).trim();
      const value = current.slice(colonIdx + 1).trim();
      obj[key] = parseScalar(value);
    }
  }
  
  return obj;
}

/**
 * Serialize a JavaScript value to YAML string.
 *
 * @param {any} data - Value to serialize
 * @param {number} indent - Current indentation level
 * @returns {string}
 */
export function dumpYaml(data, indent = 0) {
  const spaces = '  '.repeat(indent);
  
  if (data === null || data === undefined) {
    return 'null';
  }
  
  if (typeof data === 'boolean') {
    return data ? 'true' : 'false';
  }
  
  if (typeof data === 'number') {
    return String(data);
  }
  
  if (typeof data === 'string') {
    // Check if string needs quoting
    if (data === '' ||
        data === 'null' || data === 'true' || data === 'false' ||
        data.includes(':') || data.includes('#') ||
        data.includes('\n') || data.includes('"') ||
        data.startsWith(' ') || data.endsWith(' ') ||
        /^[\[\]{}>|*&!%@`]/.test(data)) {
      // Use double quotes and escape
      return '"' + data.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    return data;
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return '[]';
    }
    
    const lines = [];
    for (const item of data) {
      if (item === null || typeof item !== 'object') {
        lines.push(`${spaces}- ${dumpYaml(item, 0)}`);
      } else if (Array.isArray(item)) {
        lines.push(`${spaces}-`);
        lines.push(dumpYaml(item, indent + 2).split('\n').map(l => spaces + '  ' + l.trimStart()).join('\n'));
      } else {
        // Object item
        const entries = Object.entries(item);
        if (entries.length === 0) {
          lines.push(`${spaces}- {}`);
        } else {
          const [firstKey, firstValue] = entries[0];
          if (firstValue === null || typeof firstValue !== 'object') {
            lines.push(`${spaces}- ${firstKey}: ${dumpYaml(firstValue, 0)}`);
          } else {
            lines.push(`${spaces}- ${firstKey}:`);
            lines.push(dumpYaml(firstValue, indent + 2).split('\n').map(l => spaces + '    ' + l.trimStart()).join('\n'));
          }
          for (let i = 1; i < entries.length; i++) {
            const [key, value] = entries[i];
            if (value === null || typeof value !== 'object') {
              lines.push(`${spaces}  ${key}: ${dumpYaml(value, 0)}`);
            } else {
              lines.push(`${spaces}  ${key}:`);
              lines.push(dumpYaml(value, indent + 2).split('\n').map(l => spaces + '    ' + l.trimStart()).join('\n'));
            }
          }
        }
      }
    }
    return lines.join('\n');
  }
  
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return '{}';
    }
    
    const lines = [];
    for (const [key, value] of entries) {
      if (value === null || typeof value !== 'object') {
        lines.push(`${spaces}${key}: ${dumpYaml(value, 0)}`);
      } else if (Array.isArray(value) && value.length === 0) {
        lines.push(`${spaces}${key}: []`);
      } else if (!Array.isArray(value) && Object.keys(value).length === 0) {
        lines.push(`${spaces}${key}: {}`);
      } else {
        lines.push(`${spaces}${key}:`);
        lines.push(dumpYaml(value, indent + 1));
      }
    }
    return lines.join('\n');
  }
  
  return String(data);
}

/**
 * Load and parse a YAML file.
 *
 * @param {string} filePath - Path to YAML file
 * @returns {any}
 */
export function loadYamlFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseYaml(raw);
}

/**
 * Serialize data and save to a YAML file.
 *
 * @param {string} filePath - Path to YAML file
 * @param {any} data - Data to serialize
 */
export function saveYamlFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const yaml = dumpYaml(data);
  fs.writeFileSync(filePath, yaml + '\n', 'utf8');
}

// =============================================================================
// Lightweight utilities (merged from yaml-lite.mjs)
// =============================================================================

/**
 * Strip inline YAML comments (everything after #).
 * @param {string} line - YAML line
 * @returns {string}
 */
export function stripInlineComment(line) {
  const idx = line.indexOf('#');
  if (idx === -1) return line;
  return line.slice(0, idx);
}

/**
 * Unquote a YAML value (removes surrounding single or double quotes).
 * @param {string} s - Quoted or unquoted value
 * @returns {string}
 */
export function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a top-level version field.
 * Looks for: version: <int>
 *
 * @param {string} raw - YAML content
 * @returns {number | null}
 */
export function parseTopLevelVersion(raw) {
  const m = raw.match(/^\s*version\s*:\s*([0-9]+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/**
 * Parse values from list items with a specific key.
 * Looks for: - <listItemKey>: value
 *
 * @param {string} raw - YAML content
 * @param {string} listItemKey - Key to extract (e.g., 'provider_id')
 * @returns {string[]}
 */
export function parseListFieldValues(raw, listItemKey) {
  const values = [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp(`^\\s*\\-\\s*${listItemKey}\\s*:\\s*(.+)\\s*$`);

  for (const originalLine of lines) {
    const line = stripInlineComment(originalLine).trimEnd();
    const m = line.match(re);
    if (!m) continue;
    const v = unquote(m[1]);
    if (v) values.push(v);
  }

  return values;
}

/**
 * Parse scalar assignments across the document.
 * Looks for: keyName: value
 *
 * @param {string} raw - YAML content
 * @param {string} keyName - Key to extract
 * @returns {string[]}
 */
export function parseAllScalarValues(raw, keyName) {
  const values = [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp(`^\\s*${keyName}\\s*:\\s*(.+)\\s*$`);

  for (const originalLine of lines) {
    const line = stripInlineComment(originalLine).trimEnd();
    const m = line.match(re);
    if (!m) continue;
    const v = unquote(m[1]);
    if (v) values.push(v);
  }

  return values;
}

/**
 * Parse simple list items (- value).
 *
 * @param {string} raw - YAML content
 * @param {string} sectionKey - Section key to start parsing after (e.g., 'keys')
 * @returns {string[]}
 */
export function parseSimpleList(raw, sectionKey) {
  const values = [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  let inSection = false;
  const sectionRe = new RegExp(`^${sectionKey}\\s*:\\s*$`);

  for (const originalLine of lines) {
    const line = stripInlineComment(originalLine).trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for section start
    if (sectionRe.test(trimmed)) {
      inSection = true;
      continue;
    }

    // Check for new section (key:)
    if (inSection && /^[a-z_]+\s*:\s*$/.test(trimmed)) {
      inSection = false;
      continue;
    }

    if (inSection) {
      const m = trimmed.match(/^\-\s*(.+)\s*$/);
      if (m) {
        const value = unquote(m[1]);
        if (value) values.push(value);
      }
    }
  }

  return values;
}

/**
 * Parse a simple key-value map from YAML content.
 * Only handles top-level flat key: value pairs.
 *
 * @param {string} raw - YAML content
 * @returns {Record<string, string>}
 */
export function parseSimpleMap(raw) {
  const result = {};
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  for (const originalLine of lines) {
    const line = stripInlineComment(originalLine).trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip list items
    if (trimmed.startsWith('-')) continue;

    const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (m) {
      const key = m[1];
      const value = unquote(m[2]);
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check if a file header contains a template marker.
 * @param {string} raw - File content
 * @returns {boolean}
 */
export function hasTemplateHeader(raw) {
  const head = raw.split(/\r?\n/).slice(0, 5).join('\n');
  return head.toLowerCase().includes('(template)');
}
