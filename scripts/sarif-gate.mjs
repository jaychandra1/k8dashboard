#!/usr/bin/env node
// Fail CI on security findings in SARIF files (CodeQL), without needing GitHub
// code scanning to be enabled on the repository (audit BLD-01).
//
//   node scripts/sarif-gate.mjs <file-or-dir>... [--min-severity 7.0]
//
// A finding blocks when its rule's `security-severity` is at least the
// threshold (7.0 = High; 9.0 = Critical). Lower-severity security findings
// are printed as warnings; quality findings (no security-severity) are
// ignored. Prints GitHub annotations and exits 1 when anything blocks.
//
// A reviewed false positive is suppressed in the source: a comment line
// `// codeql[<rule-id>]` (with the reason above it) directly above the flagged
// line, as CodeQL itself reads them. The gate reads those comments from the
// checkout (the current directory), so it doesn't depend on the CodeQL run
// including its suppression query; SARIF `suppressions` are honoured too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/paths.mjs';

export const DEFAULT_MIN_SEVERITY = 7.0;

/** Rule metadata by id, from the driver and every extension (CodeQL puts query packs in extensions). */
function rulesOf(run) {
  const byId = new Map();
  const components = [run?.tool?.driver, ...(run?.tool?.extensions || [])];
  for (const component of components) {
    for (const rule of component?.rules || []) if (rule?.id) byId.set(rule.id, rule);
  }
  return { byId, components };
}

function ruleFor(result, { byId, components }) {
  const ref = result?.rule;
  if (ref && Number.isInteger(ref.index)) {
    const component = components[Number.isInteger(ref.toolComponent?.index) ? ref.toolComponent.index + 1 : 0];
    const rule = component?.rules?.[ref.index];
    if (rule) return rule;
  }
  return byId.get(result?.ruleId || ref?.id) || null;
}

/** Every security finding in a SARIF log: { ruleId, severity, message, file, line, suppressed }. */
export function securityFindings(sarif) {
  const out = [];
  for (const run of sarif?.runs || []) {
    const rules = rulesOf(run);
    for (const result of run?.results || []) {
      const rule = ruleFor(result, rules);
      const severity = Number.parseFloat(rule?.properties?.['security-severity'] ?? result?.properties?.['security-severity']);
      if (!Number.isFinite(severity)) continue;
      const loc = result?.locations?.[0]?.physicalLocation;
      out.push({
        ruleId: result?.ruleId || rule?.id || 'unknown',
        severity,
        message: String(result?.message?.text || rule?.shortDescription?.text || '').split('\n')[0],
        file: loc?.artifactLocation?.uri || '',
        line: loc?.region?.startLine || 0,
        suppressed: Array.isArray(result?.suppressions) && result.suppressions.length > 0,
      });
    }
  }
  return out;
}

const SUPPRESSION = /\bcodeql\s*\[([^\]]*)\]/gi;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * Whether the line above `line` (1-based) of `lines` is a comment naming
 * `ruleId` in `codeql[...]` (several ids may be listed, comma-separated).
 */
export function suppressedByComment(lines, line, ruleId) {
  const above = lines?.[line - 2];
  if (typeof above !== 'string' || !COMMENT_LINE.test(above)) return false;
  const want = String(ruleId).toLowerCase();
  for (const m of above.matchAll(SUPPRESSION)) {
    if (m[1].split(',').some((id) => id.trim().toLowerCase() === want)) return true;
  }
  return false;
}

/** Reads a finding's source file under `root` (lines cached per file); null if unreadable. */
export function sourceReader(root = process.cwd()) {
  const cache = new Map();
  return (uri) => {
    if (!uri) return null;
    if (!cache.has(uri)) {
      let lines = null;
      try {
        const file = uri.startsWith('file:') ? fileURLToPath(uri) : path.resolve(root, decodeURIComponent(uri));
        lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      } catch { /* not in this checkout */ }
      cache.set(uri, lines);
    }
    return cache.get(uri);
  };
}

/**
 * { blocking, warnings } for the given SARIF logs. With `readSource`
 * (uri → lines), `// codeql[<rule-id>]` comments suppress findings too.
 */
export function evaluate(logs, minSeverity = DEFAULT_MIN_SEVERITY, { readSource } = {}) {
  const inSource = (f) => !!readSource && suppressedByComment(readSource(f.file), f.line, f.ruleId);
  const all = logs.flatMap(securityFindings).filter((f) => !f.suppressed && !inSource(f));
  return {
    blocking: all.filter((f) => f.severity >= minSeverity),
    warnings: all.filter((f) => f.severity < minSeverity),
  };
}

const sarifFiles = (target) => {
  const st = fs.statSync(target);
  if (!st.isDirectory()) return [target];
  return fs.readdirSync(target).filter((n) => n.endsWith('.sarif')).map((n) => path.join(target, n));
};

/** Every finding, one line each, blocking first: `BLOCK 7.5 js/path-injection lib/x.mjs:12 message`. */
export function listing(blocking, warnings) {
  const line = (tag, f) => `${tag} ${f.severity.toFixed(1)} ${f.ruleId} ${f.file || '?'}:${f.line} ${f.message}`;
  const bySpot = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
  return [...[...blocking].sort(bySpot).map((f) => line('BLOCK', f)), ...[...warnings].sort(bySpot).map((f) => line('warn ', f))].join('\n');
}

const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const annotate = (level, f) =>
  `::${level} file=${escape(f.file)},line=${f.line}::${escape(`${f.ruleId} (security-severity ${f.severity}): ${f.message}`)}`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  let minSeverity = DEFAULT_MIN_SEVERITY;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-severity') minSeverity = Number.parseFloat(args[++i]);
    else targets.push(args[i]);
  }
  if (!targets.length || !Number.isFinite(minSeverity)) {
    console.error('usage: node scripts/sarif-gate.mjs <file-or-dir>... [--min-severity 7.0]');
    process.exit(2);
  }
  const files = targets.flatMap(sarifFiles);
  if (!files.length) {
    console.error(`::error::no SARIF files in ${targets.join(', ')}`);
    process.exit(2);
  }
  const logs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const { blocking, warnings } = evaluate(logs, minSeverity, { readSource: sourceReader() });
  for (const f of warnings) console.log(annotate('warning', f));
  for (const f of blocking) console.log(annotate('error', f));
  // GitHub shows only the first 10 annotations of each kind per step, so the
  // full list (with locations) also goes to the log.
  if (blocking.length || warnings.length) console.log(`\n${listing(blocking, warnings)}\n`);
  console.log(`${files.length} SARIF file(s): ${blocking.length} finding(s) at security-severity >= ${minSeverity}, ${warnings.length} below.`);
  process.exit(blocking.length ? 1 : 0);
}
