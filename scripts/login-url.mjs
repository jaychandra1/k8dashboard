#!/usr/bin/env node
// Print the KubePilot sign-in link: the server's URL with the API token in the
// fragment (the UI moves it into session storage).
//
//   node scripts/login-url.mjs [--base http://localhost:8080]
//   docker exec <container> node scripts/login-url.mjs --base http://localhost:8080
//
// A non-interactive server (Docker, systemd) doesn't print the token in its
// log, where log collectors would keep it; this reads it the way server.js
// does — KUBEPILOT_TOKEN, else ~/.config/kubepilot/token — without creating
// one. --base defaults to http://127.0.0.1:$PORT (3001); pass the address you
// actually open, e.g. the port Docker publishes.
import fs from 'node:fs';
import { envToken, findConfigFile } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--base');
const base = String(i >= 0 && args[i + 1] ? args[i + 1] : `http://127.0.0.1:${Number(process.env.PORT) || 3001}`).replace(/\/+$/, '');

let token = envToken();
if (!token) {
  try {
    token = fs.readFileSync(findConfigFile('token'), 'utf8').trim();
  } catch {
    token = '';
  }
}
if (!token) {
  console.error('✗ No KubePilot token found (KUBEPILOT_TOKEN or ~/.config/kubepilot/token). Start the server once first.');
  process.exit(1);
}
console.log(`${base}/#token=${token}`);
