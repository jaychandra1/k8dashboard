// The backend on the built-in demo cluster, for trying the UI without a real
// cluster: a throwaway HOME and no kubeconfig, so nothing on this machine is
// read or changed. Serves client/dist (run `npm run build` first).
//
//   node scripts/demo-server.mjs        # PORT defaults to 3088
//
// Prints the URL to open (with its one-time token).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'k8board-demo-'));
const token = crypto.randomBytes(24).toString('base64url');
Object.assign(process.env, {
  KUBEPILOT_DEMO: '1',
  KUBEPILOT_TOKEN: token,
  HOST: '127.0.0.1',
  PORT: process.env.PORT || '3088',
  KUBECONFIG: path.join(home, 'no-kubeconfig'),
  HOME: home,
  USERPROFILE: home,
  NODE_ENV: 'production',
});
const cleanup = () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

await import('../server.js');

// Enter the demo cluster once the server answers.
const base = `http://127.0.0.1:${process.env.PORT}`;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(`${base}/api/config/context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextName: 'demo-cluster' }),
    });
    if (res.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`[demo] open ${base}/#token=${token}`);
