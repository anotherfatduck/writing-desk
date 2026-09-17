// Spike A test harness: boots the built writer-app headless in an isolated OW_HOME.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(fileURLToPath(new URL(import.meta.url)), '..', '..', '..', '..');

export async function bootApp({ port, bearer }) {
  const home = mkdtempSync(join(tmpdir(), 'ow-spike-'));
  const child = spawn(process.execPath, ['dist/bin/server.js', '--port', String(port), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, OW_HOME: home, OW_HEADLESS: '1', OW_BEARER_TOKEN: bearer },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app:${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const headers = bearer ? { authorization: `Bearer ${bearer}` } : undefined;
      const res = await fetch(`${base}/api/status`, { headers });
      if (res.ok) return { child, base, home, token: bearer, port };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`app did not become healthy on :${port}`);
}

export function shutdown(inst) {
  return new Promise((resolve) => {
    inst.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { inst.child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
    inst.child.on('exit', () => {
      clearTimeout(timer);
      try { rmSync(inst.home, { recursive: true, force: true }); } catch { /* tmp */ }
      resolve();
    });
  });
}

export function api(inst, method, path, body) {
  return fetch(`${inst.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${inst.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function openWs(inst) {
  return new WebSocket(`ws://127.0.0.1:${inst.port}`, { headers: { authorization: `Bearer ${inst.token}` } });
}
