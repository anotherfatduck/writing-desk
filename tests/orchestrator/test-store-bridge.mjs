// Orchestrator store bridge (M4d): roster/repo/creds re-read every poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGitea } from './lib/fake-gitea.mjs';
import { storeUser, writeFixtureStore } from './lib/fixture.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });

const storeMod = await import(new URL('../../dist/shared/store.js', import.meta.url).href);
const bridgeMod = await import(new URL('../../dist-orchestrator/orchestrator/store-bridge.js', import.meta.url).href);
const runMod = await import(new URL('../../dist-orchestrator/orchestrator/run.js', import.meta.url).href);

const { writeStore } = storeMod;
const { makeStoreBridge } = bridgeMod;
const { runLoop } = runMod;

const STATIC_BASE = {
  workspacesBase: '/srv/writer-app/workspaces',
  cloneDir: '/var/lib/orch/clone',
  mainBranch: 'main',
  mergeDir: 'articles',
  branchPrefix: 'article',
  pollIntervalMs: 60000,
  stateDir: '/var/lib/orch/state',
  git: { authorName: 'orch', authorEmail: 'orch@e' },
  gitea: { apiBaseUrl: 'placeholder' },
};

function withEnv(runtimeDir, storeFile, fn) {
  const oldRuntime = process.env.WRITER_RUNTIME_DIR;
  const oldStore = process.env.WRITER_STORE;
  process.env.WRITER_RUNTIME_DIR = runtimeDir;
  process.env.WRITER_STORE = storeFile;
  try {
    return fn();
  } finally {
    if (oldRuntime === undefined) delete process.env.WRITER_RUNTIME_DIR;
    else process.env.WRITER_RUNTIME_DIR = oldRuntime;
    if (oldStore === undefined) delete process.env.WRITER_STORE;
    else process.env.WRITER_STORE = oldStore;
  }
}

test('readCycle assembles writerRoots, repo slug, and Gitea creds from the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-bridge-'));
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  const staticCfg = { ...STATIC_BASE, gitea: { ...STATIC_BASE.gitea, apiBaseUrl: fake.baseUrl } };
  const repoUrl = 'https://gitea.example.com:3000/owner/content-repo.git';
  const { runtimeDir, storeFile } = writeFixtureStore(dir, {
    users: [storeUser('u1'), storeUser('u2')],
    gitea: { repoUrl, username: 'writer-bot', password: 'secret-1' },
  });

  try {
    const cyc = withEnv(runtimeDir, storeFile, () => makeStoreBridge(staticCfg)());
    assert.ok(cyc, 'expected a Cycle');
    assert.deepEqual(cyc.cfg.writerRoots, [
      { id: 'u1', root: join(staticCfg.workspacesBase, 'u1') },
      { id: 'u2', root: join(staticCfg.workspacesBase, 'u2') },
    ]);
    assert.equal(cyc.cfg.repo.url, repoUrl);
    assert.equal(cyc.cfg.repo.slug, 'owner/content-repo');

    await cyc.gitea.getPrState(1);
    assert.equal(fake.calls.length, 1);
    const auth = Buffer.from('writer-bot:secret-1').toString('base64');
    assert.equal(fake.calls[0].auth, `Basic ${auth}`);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCycle returns null when the store is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-bridge-'));
  const runtimeDir = join(dir, 'runtime');
  const storeFile = join(dir, 'missing.enc');
  const cyc = withEnv(runtimeDir, storeFile, () => makeStoreBridge(STATIC_BASE)());
  assert.equal(cyc, null);
  rmSync(dir, { recursive: true, force: true });
});

test('readCycle re-reads the store each call: roster/cred changes are picked up without a new bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-bridge-'));
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  const staticCfg = { ...STATIC_BASE, gitea: { ...STATIC_BASE.gitea, apiBaseUrl: fake.baseUrl } };
  const repoUrl = 'https://gitea.example.com:3000/owner/content-repo.git';
  const { runtimeDir, storeFile, key } = writeFixtureStore(dir, {
    users: [storeUser('u1'), storeUser('u2')],
    gitea: { repoUrl, username: 'writer-bot', password: 'secret-1' },
  });

  try {
    const readCycle = makeStoreBridge(staticCfg);
    const first = withEnv(runtimeDir, storeFile, () => readCycle());
    assert.equal(first.cfg.writerRoots.length, 2);
    assert.equal(first.cfg.repo.url, repoUrl);

    writeStore(storeFile, key, {
      v: 1,
      createdAt: new Date().toISOString(),
      users: [storeUser('u1'), storeUser('u2'), storeUser('u3')],
      gitea: { repoUrl, username: 'writer-bot', password: 'secret-2' },
      sessions: [],
    });

    const second = withEnv(runtimeDir, storeFile, () => readCycle());
    assert.equal(second.cfg.writerRoots.length, 3);
    assert.ok(second.cfg.writerRoots.find((w) => w.id === 'u3'));
    assert.equal(second.cfg.repo.url, repoUrl);

    // Verify the new password via the gitea port on the same fake HTTP server.
    await second.gitea.getPrState(1);
    assert.equal(fake.calls.length, 1);
    const auth2 = Buffer.from('writer-bot:secret-2').toString('base64');
    assert.equal(fake.calls[0].auth, `Basic ${auth2}`);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLoop idles quietly when readCycle returns null', async () => {
  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  const timer = runLoop({ ...STATIC_BASE, pollIntervalMs: 50 }, () => null);
  await new Promise((r) => setTimeout(r, 160));
  clearInterval(timer);
  console.error = origError;

  const notConfiguredLines = logs.filter((l) => l.includes('not configured'));
  const idleSpam = logs.filter((l) => l.includes('idling'));
  const configuredLines = logs.filter((l) => l.includes('configured — store loaded'));
  const pollFailedLines = logs.filter((l) => l.includes('poll failed'));

  assert.equal(notConfiguredLines.length, 1, 'one transition-to-idle line');
  assert.match(notConfiguredLines[0], /not configured — store absent; idling/);
  assert.equal(idleSpam.length, 1, 'no per-poll idling spam');
  assert.equal(configuredLines.length, 0, 'never configured');
  assert.equal(pollFailedLines.length, 0, 'pollOnce never fires');
});
