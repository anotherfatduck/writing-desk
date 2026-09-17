import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { loadConfig } = await mod('config');

const VALID = {
  workspacesBase: '/srv/writer-app/workspaces',
  cloneDir: '/var/lib/orch/clone',
  mainBranch: 'main',
  mergeDir: 'articles',
  branchPrefix: 'article',
  pollIntervalMs: 60000,
  stateDir: '/var/lib/orch/state',
  git: { authorName: 'writer-orchestrator', authorEmail: 'orch@example' },
  gitea: { apiBaseUrl: 'https://gitea.example' },
};

test('loadConfig accepts a full valid static config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(VALID));
  const cfg = loadConfig(p);
  assert.equal(cfg.workspacesBase, '/srv/writer-app/workspaces');
  assert.equal(cfg.mergeDir, 'articles');
  assert.equal(cfg.branchPrefix, 'article');
});

test('loadConfig rejects legacy writerRoots and repo nested keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  const p = join(dir, 'bad.json');
  writeFileSync(p, JSON.stringify({ ...VALID, writerRoots: [{ id: 'w1', root: '/srv/w1' }] }));
  assert.throws(() => loadConfig(p), /config invalid/);
  const p2 = join(dir, 'bad2.json');
  writeFileSync(p2, JSON.stringify({ ...VALID, repo: { url: 'https://gitea.example/owner/content-repo.git', slug: 'owner/content-repo', cloneDir: '/var/lib/orch/clone', mainBranch: 'main', mergeDir: 'articles', branchPrefix: 'article' } }));
  assert.throws(() => loadConfig(p2), /config invalid/);
});

test('loadConfig rejects a short pollIntervalMs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  const p = join(dir, 'bad.json');
  writeFileSync(p, JSON.stringify({ ...VALID, pollIntervalMs: 500 }));
  assert.throws(() => loadConfig(p), /config invalid/);
});

test('loadConfig rejects the dropped tea keys (M4e: PR creation is REST)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  const p = join(dir, 'bad.json');
  writeFileSync(p, JSON.stringify({ ...VALID, gitea: { apiBaseUrl: 'https://gitea.example', teaBin: '/usr/local/bin/tea' } }));
  assert.throws(() => loadConfig(p), /config invalid/);
});
