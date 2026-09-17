#!/usr/bin/env node

/**
 * CLI entry point for writer-app.
 * Usage: writer-app [--port 5050] [--no-open]
 *
 * Boot order:
 *   1. Parse args (light imports only)
 *   2. Start MCP stdio transport (what the MCP client waits for)
 *   3. Lazy-load Express server (heavy deps deferred)
 *
 * Headless by default: no browser open, no port-probe client mode.
 */

// Redirect all console output to stderr so MCP stdio protocol stays clean on stdout
const originalLog = console.log;
console.log = (...args: any[]) => console.error(...args);

// ── Crash guards ──
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('[FATAL] Uncaught exception:', err);
  // Exit non-zero on a real crash (final review I1): a slot child that loses a
  // bind race (EADDRINUSE) must not linger holding the user's OW_HOME — and no
  // wedged process should survive its own fatal state. systemd restarts it.
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection:', reason);
});
process.stdout.on('error', (err: any) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('[stdout error]', err);
});
process.stdin.on('end', () => {
  console.error('[MCP] stdin EOF — the MCP client disconnected. HTTP server still running.');
});
process.stdin.on('close', () => {
  console.error('[MCP] stdin closed.');
});

import { readConfig } from '../server/helpers.js';

const args = process.argv.slice(2);
let port = 5050;
let noOpen = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
  if (args[i] === '--no-open') {
    noOpen = true;
  }
}

// Restore active profile from config
const config = readConfig();
const { setActiveProfile } = await import('../server/helpers.js');
setActiveProfile(config.activeProfile || 'Default');

// Primary mode: start MCP stdio FIRST, then lazy-load Express
const { load } = await import('../server/state.js');
load();

const { startMcpServer } = await import('../server/mcp.js');
startMcpServer().catch((err: any) => {
  console.error('[MCP] Failed to start:', err);
});

const { startHttpServer } = await import('../server/index.js');
startHttpServer({ port, noOpen: true }).catch((err: any) => {
  console.error('[HTTP] Failed to start:', err);
});
