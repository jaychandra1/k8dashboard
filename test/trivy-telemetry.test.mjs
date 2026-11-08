// K8Board promises no telemetry (website/privacy.html, the Store listing), so
// the Trivy it runs for image scans must not send Aqua usage data or ask for
// update notices: trivy-scan.js sets both off for every child it starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trivyEnv, TRIVY_NO_TELEMETRY_ENV } from '../trivy-scan.js';
import { ROOT_DIR } from '../lib/paths.mjs';

test("Trivy's usage data and update checks are off, whatever the user's environment says", () => {
  const env = trivyEnv({ PATH: '/usr/bin', TRIVY_DISABLE_TELEMETRY: 'false', TRIVY_SKIP_VERSION_CHECK: 'false' });
  assert.equal(env.TRIVY_DISABLE_TELEMETRY, 'true');
  assert.equal(env.TRIVY_SKIP_VERSION_CHECK, 'true');
  assert.equal(env.PATH, '/usr/bin', "the rest of the user's environment is kept");
});

test("the variables are Trivy's own names for --disable-telemetry and --skip-version-check", () => {
  // Trivy reads every flag from TRIVY_<FLAG> (upper case, - → _).
  const asEnv = (flag) => `TRIVY_${flag.replace(/^--/, '').toUpperCase().replace(/-/g, '_')}`;
  assert.deepEqual(Object.keys(TRIVY_NO_TELEMETRY_ENV).sort(), ['--disable-telemetry', '--skip-version-check'].map(asEnv).sort());
});

test("K8Board's own secrets still never reach Trivy", () => {
  const env = trivyEnv({ K8BOARD_TOKEN: 'api-token', LLM_API_KEY: 'llm-key', HOME: '/home/me' });
  assert.equal(env.K8BOARD_TOKEN, undefined);
  assert.equal(env.LLM_API_KEY, undefined);
  assert.equal(env.HOME, '/home/me');
});

test('every child trivy-scan.js starts gets that environment', () => {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'trivy-scan.js'), 'utf8');
  const spawns = src.match(/\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(/g) || [];
  assert.deepEqual(spawns, ['execFile('], 'one place starts processes: run()');
  assert.match(src, /execFile\(bin, args, \{[^}]*env: trivyEnv\(/, 'run() passes trivyEnv()');
});
