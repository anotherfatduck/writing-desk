import { SlotManager } from '../../dist/server/front-door/slots.js';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

async function test() {
  const tmp = mkdtempSync(join(tmpdir(), 'slot-test-'));
  let failed = false;

  const ok = (val, msg) => {
    if (!val) {
      console.error(`FAIL: ${msg}`);
      failed = true;
    } else {
      console.log(`ok: ${msg}`);
    }
  };

  try {
    const mgr1 = new SlotManager({ workspacesBase: tmp, portBase: 10000, idleMs: 400 });
    const mgr2 = new SlotManager({ workspacesBase: tmp, portBase: 11000, idleMs: 400 });

    // 1. Basic spawn and memoization
    const s1 = await mgr1.getSlot('u1');
    const res1 = await fetch(`http://127.0.0.1:${s1.port}/api/status`).catch(() => ({ ok: false }));
    ok(res1.ok, 'u1 status answers');

    const s1_again = await mgr1.getSlot('u1');
    ok(s1.port === s1_again.port, 'u1 memoized');

    const s2 = await mgr1.getSlot('u2');
    ok(s1.port !== s2.port, 'u2 distinct port');

    ok(existsSync(join(tmp, 'u1', 'profiles')), 'slot dir exists');

    // 2. Connection hold — deadline-bounded (T11 hardening): a slow u2 spawn in
    //    leg 1 can idle-stop u1 before the hold begins (400ms idle < 1s sweeper
    //    tick under load), so re-arm u1 first (same deterministic port — u2
    //    skipped it while u1 was registered), then POLL through at least one
    //    full sweeper tick instead of a fixed sleep.
    writeFileSync(join(tmp, 'u1', 'marker'), '1');
    const s1_held = await mgr1.getSlot('u1');
    mgr1.connOpen('u1');
    const holdStart = Date.now();
    let held = true;
    while (Date.now() - holdStart < 1300) { // 1300ms window spans ≥1 1000ms tick
      await new Promise(r => setTimeout(r, 100));
      const resHold = await fetch(`http://127.0.0.1:${s1_held.port}/api/status`).catch(() => ({ ok: false }));
      if (!resHold.ok) { held = false; break; }
    }
    ok(held, 'slot held by connection (survives >= one sweeper tick)');

    mgr1.connClose('u1');

    // Poll for idle-stop
    let stopped = false;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${s1_held.port}/api/status`).catch(() => ({ ok: false }));
      if (!res.ok) {
        stopped = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    ok(stopped, 'slot idle-stopped after connClose');

    // 3. Respawn
    const s1_respawn = await mgr1.getSlot('u1');
    const resRespawn = await fetch(`http://127.0.0.1:${s1_respawn.port}/api/status`).catch(() => ({ ok: false }));
    ok(resRespawn.ok, 'slot respawned');
    ok(existsSync(join(tmp, 'u1', 'marker')), 'disk canonical (marker persists)');

    // 4. Restart leg
    await mgr1.stopAll();
    const s1_mgr2 = await mgr2.getSlot('u1');
    const resMgr2 = await fetch(`http://127.0.0.1:${s1_mgr2.port}/api/status`).catch(() => ({ ok: false }));
    ok(resMgr2.ok, 'respawned on mgr2');
    ok(s1_mgr2.port >= 11000 && s1_mgr2.port < 11050, 'mgr2 port range');
    ok(existsSync(join(tmp, 'u1', 'marker')), 'disk canonical on mgr2');

    await mgr2.stopAll();

    // 5. Spawn race (final review I1): two concurrent first hits for one fresh
    //    user must share ONE spawn (single-flight) — never two children racing
    //    the same deterministic port. Asserted via the live process table.
    const countSlotChildren = () => {
      try {
        return parseInt(execFileSync('pgrep', ['-fc', 'dist/bin/server\\.js --port'], { encoding: 'utf-8' }).trim(), 10) || 0;
      } catch { return 0; } // pgrep exits 1 (no match) — count 0
    };
    const mgr3 = new SlotManager({ workspacesBase: tmp, portBase: 12000, idleMs: 60000 });
    const before = countSlotChildren();
    let settled = false;
    const pA = mgr3.getSlot('race1'); pA.then(() => { settled = true; });
    const pB = mgr3.getSlot('race1');
    // Sample the process table while the spawn is in flight: at most one child
    // may exist (boot + health poll give the loop several samples).
    let maxDuring = 0;
    for (let i = 0; i < 40 && !settled; i++) {
      await new Promise(r => setTimeout(r, 25));
      maxDuring = Math.max(maxDuring, countSlotChildren() - before);
    }
    ok(maxDuring === 1, `exactly ONE slot child during the concurrent spawn window (saw max ${maxDuring})`);
    const [sA, sB] = await Promise.all([pA, pB]);
    ok(sA === sB, 'both concurrent callers resolve to the SAME slot object');
    ok(sA.port === sB.port && sA.bearer === sB.bearer, 'same port + bearer');
    ok(countSlotChildren() - before === 1, `exactly one child remains after settle (${countSlotChildren() - before})`);
    const resRace = await fetch(`http://127.0.0.1:${sA.port}/api/status`).catch(() => ({ ok: false }));
    ok(resRace.ok, 'raced slot answers');
    const sC = await mgr3.getSlot('race1');
    ok(sC === sA, 'post-settle call returns the registered slot');
    await mgr3.stopAll();
    ok(countSlotChildren() - before === 0, 'race-leg child cleaned up by stopAll');

  } catch (e) {
    console.error(`FAIL: unexpected error: ${e}`);
    failed = true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.exit(failed ? 1 : 0);
}

test();
