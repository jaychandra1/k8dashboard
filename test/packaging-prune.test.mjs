// The desktop package leaves out every `dist-es` folder (package.json
// build.files: "!**/node_modules/**/dist-es/**"): the AWS SDK and Smithy ship
// each module twice, and Node only ever loads the `dist-cjs` copy. That is
// 1,200+ files fewer for each update to move, unpack and scan on Windows.
// This guards the assumption: for every installed package with a dist-es
// folder, Node's own resolver — for `import` and for `require`, on the package
// and on each of its subpath exports — never lands in dist-es, and no code
// outside dist-es names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function packagesWithDistEs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { packagesWithDistEs(p, out); continue; }
    if (!fs.existsSync(path.join(p, 'package.json'))) continue;
    if (fs.existsSync(path.join(p, 'dist-es'))) out.push(p);
    packagesWithDistEs(path.join(p, 'node_modules'), out);
  }
  return out;
}

// The name a package is required by, and where to resolve it from.
const nameAndBase = (dir) => {
  const parts = dir.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  const name = parts[i + 1].startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  return { name, base: parts.slice(0, i).join(path.sep) };
};

const subpaths = (pj) => {
  const ex = pj.exports;
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return ['.'];
  const keys = Object.keys(ex).filter((k) => k.startsWith('.'));
  return keys.length ? keys.filter((k) => !k.includes('*') && !k.endsWith('.json')) : ['.'];
};

test('the desktop package excludes dist-es', () => {
  assert.ok(pkgJson.build.files.includes('!**/node_modules/**/dist-es/**'));
});

test('Node never loads a dist-es file of any installed package', async () => {
  const dirs = packagesWithDistEs(path.join(root, 'node_modules'));
  assert.ok(dirs.length > 0, 'expected the AWS SDK to ship dist-es folders');
  const problems = [];
  for (const dir of dirs) {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const { name, base } = nameAndBase(dir);
    const from = path.join(base, 'resolve-from.js');
    const req = createRequire(from);
    for (const sub of subpaths(pj)) {
      const spec = sub === '.' ? name : `${name}/${sub.slice(2)}`;
      for (const [kind, resolve] of [
        ['require', () => req.resolve(spec)],
        ['import', () => fileURLToPath(import.meta.resolve(spec, pathToFileURL(from).href))],
      ]) {
        let target;
        try { target = resolve(); } catch { continue; } // e.g. a types-only subpath
        if (target.split(path.sep).includes('dist-es')) problems.push(`${spec} (${kind}) → ${path.relative(root, target)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no shipped code outside dist-es refers to dist-es', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'dist-es' && e.name !== 'dist-types') walk(p); continue; }
      if (/\.(c|m)?js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('dist-es/')) offenders.push(path.relative(root, p));
    }
  };
  for (const dir of packagesWithDistEs(path.join(root, 'node_modules'))) walk(dir);
  assert.deepEqual(offenders, []);
});
