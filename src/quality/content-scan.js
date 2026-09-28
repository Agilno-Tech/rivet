import { types } from 'node:util';
import { containsSecretMaterial } from '../clients/contract.js';
const RULES = ['private-key', 'github-token', 'npm-token', 'aws-access-key', 'unicode-bidi', 'unicode-mixed-identifier', 'type-suppression'];
const DEFAULTS = { secrets: true, unicode: 'warn', maxFiles: 1000, maxBytes: 2097152, allowlist: [], shortcutRules: [] };
function fail(code) { const error = new Error('Content scan input, policy or resource limit is invalid.'); error.code = code; throw error; }
// Capture data properties only. Do not evaluate accessors or custom objects.
function capture(input, code) {
  const active = new WeakSet(); let nodes = 0, bytes = 0;
  function clone(value, depth = 0) {
    if (++nodes > 16000 || depth > 8) fail(code);
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      if (value.length > 3 * 1024 * 1024) fail(code);
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > 3 * 1024 * 1024) fail(code);
      return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) fail(code);
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail(code);
    active.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;
      if (keys.length > 1001 || (array && (!Number.isInteger(length) || length > 1000 || keys.length !== length + 1))) fail(code);
      const output = array ? [] : Object.create(null);
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail(code);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        output[key] = clone(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    } finally { active.delete(value); }
  }
  try { return clone(input); } catch { fail(code); }
}
function object(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function pathValid(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\*?\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..') && !/^[A-Za-z]:/.test(value); }
function reasonValid(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(value) && !containsSecretMaterial(value) && !/npm_[A-Za-z0-9]{36}|-----BEGIN .*PRIVATE KEY-----/.test(value); }
export function validateContentScanPolicy(input = {}) {
  input = capture(input, 'ERR_CONTENT_SCAN_POLICY');
  const bad = () => fail('ERR_CONTENT_SCAN_POLICY');
  if (!object(input, Object.keys(DEFAULTS))) bad();
  const policy = { ...DEFAULTS, ...input };
  if (typeof policy.secrets !== 'boolean' || !['warn', 'required', 'off'].includes(policy.unicode)) bad();
  if (!Number.isInteger(policy.maxFiles) || policy.maxFiles < 1 || policy.maxFiles > 1000 || !Number.isInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > 2097152) bad();
  if (!Array.isArray(policy.allowlist) || policy.allowlist.length > 100 || !Array.isArray(policy.shortcutRules) || policy.shortcutRules.length > 100) bad();
  const seen = new Set();
  for (const entry of policy.allowlist) {
    if (!object(entry, ['ruleId', 'path', 'reason']) || !RULES.includes(entry.ruleId) || !pathValid(entry.path) || !reasonValid(entry.reason)) bad();
    const key = `${entry.ruleId}:${entry.path}`; if (seen.has(key)) bad(); seen.add(key);
  }
  for (const entry of policy.shortcutRules) {
    if (!object(entry, ['ruleId', 'paths', 'reason', 'required']) || entry.ruleId !== 'type-suppression' || !reasonValid(entry.reason) || (entry.required !== undefined && typeof entry.required !== 'boolean') || !Array.isArray(entry.paths) || !entry.paths.length || entry.paths.length > 100 || !entry.paths.every(pathValid) || new Set(entry.paths).size !== entry.paths.length) bad();
  }
  return capture(policy, 'ERR_CONTENT_SCAN_POLICY');
}

// Mask ordinary strings and comments before examining code identifiers. This is a
// conservative lexical heuristic, not a parser or a substitute for a compiler.
function codeOnly(text) {
  return text.replace(/"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|`(?:\\[\s\S]|[^`\\])*(?:`|$)/g, match => match.replace(/[^\n]/g, ' '));
}
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|c|h|cpp|hpp|cc|cs|swift|rb|php|scala)$/i;
const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, 'Private key material detected.'],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g, 'GitHub token pattern detected.'],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g, 'npm token pattern detected.'],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS access key identifier detected.'],
];
export function scanChangedContent(input = {}) {
  const captured = capture(input, 'ERR_CONTENT_SCAN_INPUT');
  if (!object(captured, ['files', 'policy'])) fail('ERR_CONTENT_SCAN_INPUT');
  const { files } = captured;
  const policy = validateContentScanPolicy(captured.policy);
  if (!Array.isArray(files)) fail('ERR_CONTENT_SCAN_INPUT');
  if (files.length > policy.maxFiles) fail('ERR_CONTENT_SCAN_LIMIT');
  let bytes = 0;
  const paths = new Set();
  for (const file of files) {
    if (!object(file, ['path', 'content']) || !pathValid(file.path) || typeof file.content !== 'string' || paths.has(file.path)) fail('ERR_CONTENT_SCAN_INPUT');
    paths.add(file.path); bytes += Buffer.byteLength(file.content, 'utf8');
    if (bytes > policy.maxBytes) fail('ERR_CONTENT_SCAN_LIMIT');
  }
  const findings = [];
  for (const file of files) {
    const lineStarts = [0];
    for (let index = 0; index < file.content.length; index += 1) if (file.content[index] === '\n') lineStarts.push(index + 1);
    const lineAt = index => {
      let low = 0, high = lineStarts.length;
      while (low < high) { const middle = (low + high) >>> 1; if (lineStarts[middle] <= index) low = middle + 1; else high = middle; }
      return low;
    };
    const add = (ruleId, index, severity, message) => {
      if (policy.allowlist.some(entry => entry.path === file.path && entry.ruleId === ruleId)) return;
      // Paths are the only source-derived string; suppress terminal control bytes.
      const path = file.path.replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
      findings.push({ path, line: lineAt(index), ruleId, severity, message });
      if (findings.length > 1000) fail('ERR_CONTENT_SCAN_LIMIT');
    };
    if (policy.secrets) for (const [rule, pattern, message] of SECRET_RULES) {
      for (const match of file.content.matchAll(new RegExp(pattern.source, pattern.flags))) add(rule, match.index, 'error', message);
    }
    if (policy.unicode !== 'off') {
      const severity = policy.unicode === 'required' ? 'error' : 'warning';
      for (const match of file.content.matchAll(/[\u202a-\u202e\u2066-\u2069]/g)) add('unicode-bidi', match.index, severity, 'Bidirectional text control requires review.');
      if (CODE.test(file.path)) for (const match of codeOnly(file.content).matchAll(/[\p{L}_$][\p{L}\p{M}\p{N}_$]*/gu)) {
        const scripts = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u].filter(pattern => pattern.test(match[0]));
        if (scripts.length > 1) add('unicode-mixed-identifier', match.index, severity, 'Identifier mixes Latin, Cyrillic or Greek scripts; review for confusables.');
      }
    }
    for (const rule of policy.shortcutRules) if (rule.paths.includes(file.path)) {
      for (const match of file.content.matchAll(/@ts-(?:ignore|nocheck)\b/g)) add('type-suppression', match.index, rule.required ? 'error' : 'warning', 'Configured TypeScript suppression rule requires review.');
    }
  }
  return capture({ status: findings.some(finding => finding.severity === 'error') ? 'failed' : 'passed', findings, scannedFiles: files.length, bytes }, 'ERR_CONTENT_SCAN_INPUT');
}
