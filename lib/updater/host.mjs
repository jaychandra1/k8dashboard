// Backend → desktop host requests. The backend runs as an Electron
// utilityProcess; installing an update and restarting the app are things only
// the main process may do, so the backend asks over the process's parent port
// (process.parentPort) and waits for the matching reply:
//   → { kpUpdate: 1, id, type, payload }
//   ← { kpUpdate: 1, id, ok: true, result } | { kpUpdate: 1, id, ok: false, error: { code, message } }
// Without a parent port (plain `node server.js`) `available` is false.
import { updateError } from './errors.mjs';

export function createHostBridge(parentPort = process.parentPort) {
  const pending = new Map();
  let seq = 0;
  if (parentPort) {
    parentPort.on('message', (event) => {
      const msg = event?.data ?? event;
      if (!msg || msg.kpUpdate !== 1 || !pending.has(msg.id)) return;
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.ok) resolve(msg.result);
      else reject(updateError(msg.error?.code || 'install_failed', msg.error?.message));
    });
  }
  return {
    available: !!parentPort,
    request(type, payload, { timeoutMs = 60_000 } = {}) {
      if (!parentPort)
        return Promise.reject(
          updateError('unsupported', 'Updates can only be installed from the KubePilot desktop app.')
        );
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            updateError(type === 'relaunch' ? 'restart_failed' : 'install_failed', undefined, {
              detail: `${type}: no answer from the desktop host`,
            })
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        parentPort.postMessage({ kpUpdate: 1, id, type, payload });
      });
    },
  };
}
