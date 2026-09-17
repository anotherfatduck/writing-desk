// Deploy artifacts must not rot silently: config schema keys cross-checked
// against the real schema. (The unit file's shape is test-units.mjs's job —
// the shipped payload is packaging/units/, not a copy in this directory.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;

test('config example is static-only: legacy keys ABSENT, schema keys PRESENT', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../orchestrator/deploy/config.example.json', import.meta.url), 'utf-8'));
  // M4d: roster + repo leave the file schema entirely (store-bridge reads the
  // store per poll) — .strict() rejects these legacy keys (test-config.mjs).
  for (const k of ['writerRoots', 'repo']) assert.ok(!(k in cfg), `legacy key must be ABSENT: ${k}`);
  for (const k of ['workspacesBase', 'cloneDir', 'mainBranch', 'mergeDir', 'branchPrefix', 'pollIntervalMs', 'stateDir', 'git', 'gitea']) assert.ok(k in cfg, k);
  for (const k of ['authorName', 'authorEmail']) assert.ok(k in cfg.git, `git.${k}`);
  for (const k of ['apiBaseUrl']) assert.ok(k in cfg.gitea, `gitea.${k}`);
  for (const k of ['teaBin', 'teaLogin']) assert.ok(!(k in cfg.gitea), `dropped tea key must be ABSENT: gitea.${k}`);
});

test('config example passes the real ConfigSchema (cross-check with test-config.mjs)', async () => {
  // Self-build like test-config.mjs so a standalone run works; in-suite this is
  // a fast no-op (the orchestrator build is fresh).
  execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
  const { loadConfig } = await import(new URL('../../dist-orchestrator/orchestrator/config.js', import.meta.url).href);
  const p = new URL('../../orchestrator/deploy/config.example.json', import.meta.url).pathname;
  const parsed = loadConfig(p);
  assert.equal(parsed.workspacesBase, '/srv/writer-app/workspaces');
  assert.equal(parsed.mergeDir, 'articles');
  assert.equal(parsed.pollIntervalMs, 60000);
});