// scripts/sarif-gate.mjs: CodeQL findings at High or Critical security
// severity fail CI; lower ones are warnings; suppressed and quality-only
// findings never block (audit BLD-01).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, listing, securityFindings, suppressedByComment } from '../scripts/sarif-gate.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sarif-gate.mjs');

// The shape CodeQL writes: query-pack rules live in tool.extensions.
const sarif = (results) => ({
  version: '2.1.0',
  runs: [{
    tool: {
      driver: { name: 'CodeQL', rules: [] },
      extensions: [{
        name: 'codeql/javascript-queries',
        rules: [
          { id: 'js/command-line-injection', properties: { 'security-severity': '9.8' } },
          { id: 'js/clear-text-logging', properties: { 'security-severity': '7.5' } },
          { id: 'js/missing-rate-limiting', properties: { 'security-severity': '5.3' } },
          { id: 'js/unused-local-variable', properties: {} },
        ],
      }],
    },
    results,
  }],
});
const result = (ruleId, index, extra = {}) => ({
  ruleId, rule: { id: ruleId, index, toolComponent: { index: 0 } },
  message: { text: `${ruleId} here` },
  locations: [{ physicalLocation: { artifactLocation: { uri: 'server.js' }, region: { startLine: 10 + index } } }],
  ...extra,
});

describe('sarif-gate', () => {
  test('High and Critical block, Medium warns, quality and suppressed findings are ignored', () => {
    const log = sarif([
      result('js/command-line-injection', 0),
      result('js/clear-text-logging', 1),
      result('js/missing-rate-limiting', 2),
      result('js/unused-local-variable', 3),
      result('js/command-line-injection', 0, { suppressions: [{ kind: 'inSource' }] }),
    ]);
    const { blocking, warnings } = evaluate([log]);
    assert.deepEqual(blocking.map((f) => [f.ruleId, f.severity, f.line]), [['js/command-line-injection', 9.8, 10], ['js/clear-text-logging', 7.5, 11]]);
    assert.deepEqual(warnings.map((f) => f.ruleId), ['js/missing-rate-limiting']);
    assert.equal(securityFindings(log).length, 4, 'the suppressed one is listed but never blocks');
    assert.equal(evaluate([log], 9.0).blocking.length, 1, 'the threshold is adjustable');
  });

  test('rules are found by id when a result has no rule index', () => {
    const log = sarif([{ ruleId: 'js/clear-text-logging', message: { text: 'x' } }]);
    assert.equal(evaluate([log]).blocking.length, 1);
    assert.deepEqual(evaluate([{ runs: [] }, {}]), { blocking: [], warnings: [] });
  });

  test('a `// codeql[<rule-id>]` comment line just above the finding suppresses it', () => {
    const src = [
      'const a = 1;',
      '// Reviewed: the URL is the one the user configured.',
      '// codeql[js/command-line-injection]',
      'run(a);', // line 4
      '// codeql[js/other-rule, js/clear-text-logging]',
      'log(a);', // line 6
      'x(); // codeql[js/command-line-injection]',
      'run(a);', // line 8: a trailing comment on code doesn't count
      '// codeql[js/command-line-injection]',
      '',
      'run(a);', // line 11: not directly below
    ];
    assert.equal(suppressedByComment(src, 4, 'js/command-line-injection'), true);
    assert.equal(suppressedByComment(src, 4, 'js/clear-text-logging'), false, 'only the rule it names');
    assert.equal(suppressedByComment(src, 6, 'js/clear-text-logging'), true, 'one of a list');
    assert.equal(suppressedByComment(src, 8, 'js/command-line-injection'), false);
    assert.equal(suppressedByComment(src, 11, 'js/command-line-injection'), false);
    assert.equal(suppressedByComment(null, 4, 'js/command-line-injection'), false, 'unreadable file');

    const log = sarif([result('js/command-line-injection', 0), result('js/clear-text-logging', 1)]); // server.js:10 and :11
    const lines = Array.from({ length: 12 }, () => 'code();');
    lines[8] = '  // codeql[js/command-line-injection]';
    const { blocking } = evaluate([log], 7, { readSource: (uri) => (uri === 'server.js' ? lines : null) });
    assert.deepEqual(blocking.map((f) => f.ruleId), ['js/clear-text-logging']);
    assert.equal(evaluate([log]).blocking.length, 2, 'without a source reader, comments are not consulted');
  });

  test('the listing has every finding with its location, blocking ones first', () => {
    const { blocking, warnings } = evaluate([sarif([
      result('js/missing-rate-limiting', 2), result('js/clear-text-logging', 1), result('js/command-line-injection', 0),
    ])]);
    assert.deepEqual(listing(blocking, warnings).split('\n'), [
      'BLOCK 9.8 js/command-line-injection server.js:10 js/command-line-injection here',
      'BLOCK 7.5 js/clear-text-logging server.js:11 js/clear-text-logging here',
      'warn  5.3 js/missing-rate-limiting server.js:12 js/missing-rate-limiting here',
    ]);
  });

  test('the CLI exits 1 with annotations on blocking findings, 0 when clean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-sarif-'));
    try {
      fs.writeFileSync(path.join(dir, 'clean.sarif'), JSON.stringify(sarif([result('js/missing-rate-limiting', 2)])));
      const clean = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', cwd: dir });
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      assert.match(clean.stdout, /::warning file=server.js,line=12::js\/missing-rate-limiting/);

      fs.writeFileSync(path.join(dir, 'bad.sarif'), JSON.stringify(sarif([result('js/command-line-injection', 0)])));
      const bad = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', cwd: dir });
      assert.equal(bad.status, 1);
      assert.match(bad.stdout, /::error file=server.js,line=10::js\/command-line-injection \(security-severity 9.8\)/);
      assert.match(bad.stdout, /^BLOCK 9\.8 js\/command-line-injection server\.js:10 /m, 'the log lists every finding with its location');

      const empty = spawnSync(process.execPath, [SCRIPT, fs.mkdtempSync(path.join(dir, 'e-'))], { encoding: 'utf8', cwd: dir });
      assert.equal(empty.status, 2, 'no SARIF at all is an error, not a pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
