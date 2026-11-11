#!/usr/bin/env node
// Bundle the backend's entry points, each with every library it uses, into
// one file apiece — for the desktop app only (electron/after-pack.cjs swaps
// them in and drops node_modules but node-pty). An update then moves, unpacks
// and scans a few files instead of ~3,800, which is what made Windows updates
// slow (every file goes through the installer and the virus scanner).
//
//   node scripts/bundle-backend.mjs [outDir]     default: build/backend-bundle
//
// Entry points, kept at the app root under their own names, so the paths the
// code works out from its own location stay the same:
//   server.js       the backend (utilityProcess.fork in electron/main.cjs)
//   eks-token.js    `K8Board --token-helper eks` (electron/main.cjs imports it)
//   azure-token.js  `K8Board --token-helper azure`
//   gke-token.js    `K8Board --token-helper gke`
//   mcp-stdio.js    run by MCP clients as `node <app>/mcp-stdio.js`
// External: Node's built-ins, electron, node-pty (native, stays in
// node_modules) and ws's optional native speed-ups (loaded in a try/catch).
// The Docker image and source checkouts run the sources; nothing changes there.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ENTRIES = ['server.js', 'eks-token.js', 'azure-token.js', 'gke-token.js', 'mcp-stdio.js'];
/** node_modules the bundles still load from disk. */
export const KEEP_MODULES = ['node-pty'];
const EXTERNAL = new Set(['electron', 'node-pty', 'bufferutil', 'utf-8-validate', ...builtinModules]);
// Compacted (whitespace out, code folded) but names kept, so stack traces
// stay readable and code that reads constructor/function names still works:
// about half the size, so less for the virus scanner and the parser.
const COMPACT = { compress: true, mangle: false, codegen: { removeWhitespace: true } };
const isExternal = (id) => id.startsWith('node:') || EXTERNAL.has(id) || EXTERNAL.has(id.split('/')[0]);

async function loadRolldown() {
  // The UI's build tool (Vite) ships rolldown; the root has no bundler of its own.
  const req = createRequire(path.join(ROOT, 'client', 'package.json'));
  let entry;
  try { entry = req.resolve('rolldown'); } catch {
    throw new Error('rolldown not found: install the client dependencies first (npm ci --prefix client)');
  }
  return import(pathToFileURL(entry).href);
}

export async function bundleBackend({ outDir = path.join(ROOT, 'build', 'backend-bundle'), log = console.log } = {}) {
  const { rolldown } = await loadRolldown();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const entry of ENTRIES) {
    const bundle = await rolldown({
      input: path.join(ROOT, entry),
      platform: 'node',
      cwd: ROOT,
      external: isExternal,
      logLevel: 'warn',
      onLog(level, l, handler) {
        // CJS libraries reading `this` at the top level / eval warnings are noise here.
        if (l.code === 'EVAL' || l.code === 'THIS_IS_UNDEFINED' || l.code === 'CIRCULAR_DEPENDENCY') return;
        handler(level, l);
      },
    });
    const file = path.join(outDir, entry);
    const { output } = await bundle.write({ file, format: 'esm', codeSplitting: false, minify: COMPACT, banner: `// ${entry} — bundled with its libraries by scripts/bundle-backend.mjs; the source is in the repository.` });
    await bundle.close();
    const bytes = fs.statSync(file).size;
    // What the bundle still loads from disk at run time (Node built-ins aside).
    const chunk = output.find((o) => o.type === 'chunk') || {};
    const externals = [...new Set([...(chunk.imports || []), ...(chunk.dynamicImports || [])])]
      .filter((s) => s !== entry && !s.startsWith('node:') && !builtinModules.includes(s));
    out.push({ entry, file, bytes, externals });
    log?.(`  • bundled ${entry} (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  bundleBackend({ outDir }).catch((e) => { console.error(e?.stack || e); process.exit(1); });
}
