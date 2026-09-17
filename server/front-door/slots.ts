/**
 * Slot manager (ADR-0008): one editor slot per active user — the existing
 * single-writer app process spawned as a child with a per-user OW_HOME.
 * Disk is canonical: idle-stop loses nothing; the browser reloads from disk
 * on respawn. Slots bind loopback only and carry a per-slot random bearer
 * the front door injects upstream (the slot's own optional bearer gate —
 * server/index.ts:80 — provides defense in depth).
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { newSecret } from '../../shared/store.js';

export interface Slot { userId: string; port: number; bearer: string; }

// dist/server/front-door/slots.js → two hops up to dist/, then bin/server.js
const DIST_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'server.js');

export class SlotManager {
  private slots = new Map<string, { slot: Slot; child: ChildProcess; lastActivity: number; openWs: number }>();
  private spawning = new Map<string, Promise<Slot>>();
  private sweeper: NodeJS.Timeout;
  constructor(private opts: { workspacesBase: string; portBase: number; idleMs: number }) {
    mkdirSync(opts.workspacesBase, { recursive: true });
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [userId, s] of this.slots) {
        // Spec: stopped with NO client connections — an open WS holds the slot.
        if (s.openWs === 0 && now - s.lastActivity > opts.idleMs) { this.stop(userId); console.error(`[front-door] slot idle-stopped: ${userId}`); }
      }
    }, Math.min(30_000, Math.max(1_000, opts.idleMs / 4)));
    this.sweeper.unref?.();
  }
  async getSlot(userId: string): Promise<Slot> {
    const have = this.slots.get(userId);
    if (have) { have.lastActivity = Date.now(); return have.slot; }
    // Single-flight (final review I1): concurrent first hits for one user share
    // one spawn — two callers would otherwise race the deterministic port, and
    // the bind loser lingers alive holding the user's OW_HOME. The map entry is
    // removed once the promise settles, so a failed spawn retries on the next
    // request.
    const inFlight = this.spawning.get(userId);
    if (inFlight) return inFlight;
    const p = this.spawnSlot(userId).finally(() => { this.spawning.delete(userId); });
    this.spawning.set(userId, p);
    return p;
  }
  private async spawnSlot(userId: string): Promise<Slot> {
    if (this.slots.size >= 50) throw new Error('slot limit reached (50)');
    for (let i = 0; i < 50; i++) {
      const port = this.opts.portBase + ((userId.charCodeAt(0) * 31 + userId.length + i) % 50);
      if ([...this.slots.values()].some((s) => s.slot.port === port)) continue;
      const bearer = newSecret(24);
      const home = join(this.opts.workspacesBase, userId);
      mkdirSync(join(home, 'profiles'), { recursive: true });
      const child = spawn(process.execPath, [DIST_SERVER, '--port', String(port), '--no-open'], {
        env: { ...process.env, OW_HOME: home, OW_USER_ID: userId, OW_PORT: String(port), OW_BEARER_TOKEN: bearer },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const ok = await this.waitHealthy(port, 15_000).catch(() => false);
      if (ok) {
        const entry = { slot: { userId, port, bearer } as Slot, child, lastActivity: Date.now(), openWs: 0 };
        this.slots.set(userId, entry);
        child.on('exit', () => this.slots.delete(userId));
        return entry.slot;
      }
      child.kill('SIGKILL'); // port taken by something else — try the next
    }
    throw new Error(`no free slot port for ${userId}`);
  }
  /** Connection liveness (spec: stopped with NO client connections). The proxy's
   * upgrade wiring reports WS open/close; an open WS holds the slot regardless. */
  connOpen(userId: string): void { const s = this.slots.get(userId); if (s) { s.openWs++; s.lastActivity = Date.now(); } }
  connClose(userId: string): void { const s = this.slots.get(userId); if (s) s.openWs = Math.max(0, s.openWs - 1); }

  /** Test seam: register an already-running slot without spawning. */
  registerStaticSlot(userId: string, port: number, bearer: string): void {
    this.slots.set(userId, {
      slot: { userId, port, bearer },
      child: { kill() {}, once(_evt: string, cb: () => void) { cb(); return this; } } as unknown as ChildProcess,
      lastActivity: Date.now(),
      openWs: 0,
    });
  }

  async stop(userId: string): Promise<void> {
    const s = this.slots.get(userId);
    if (!s) return;
    this.slots.delete(userId);
    s.child.kill('SIGTERM');
    await new Promise<void>((r) => { const t = setTimeout(() => { try { s.child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 2000); s.child.once('exit', () => { clearTimeout(t); r(); }); });
  }
  async stopAll(): Promise<void> { for (const id of [...this.slots.keys()]) await this.stop(id); clearInterval(this.sweeper); }
  private async waitHealthy(port: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return true; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }
}
