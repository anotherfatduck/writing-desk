// GitStore against a local bare remote (hermetic; no auth, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { GitStore } = await mod('git-store');

function bareRemote(dir) {
  const p = join(dir, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', p]);
  return p;
}

/** Seed the bare remote's main with a README (branch base is non-empty). */
function seedRemote(dir, url) {
  const seed = join(dir, 'seed');
  execFileSync('git', ['clone', url, seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
}

test('branch created from main tip, files committed and pushed; re-ship is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git-'));
  const url = bareRemote(dir);
  seedRemote(dir, url);

  const store = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone'), mainBranch: 'main', authorName: 'orch', authorEmail: 'orch@e' });
  const sha1 = await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: '---\ndocId: doc-1\n---\n\nv1\n' },
    { path: 'articles/w1/doc-1/_chats/s1.jsonl', content: '{"t":1}\n' },
  ], 'article: +1 agent — session s1 (glm), submitted x');
  assert.match(sha1, /^[0-9a-f]{40}$/);

  const show = execFileSync('git', ['--git-dir', url, 'show', 'article/w1/doc-1:articles/w1/doc-1/article.md'], { encoding: 'utf-8' });
  assert.match(show, /v1/);

  // idempotent re-ship: same content → same sha, no new commit
  const sha1b = await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: '---\ndocId: doc-1\n---\n\nv1\n' },
  ], 'article: nothing new');
  assert.equal(sha1b, sha1);

  // second cycle appends on the branch
  const sha2 = await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: '---\ndocId: doc-1\n---\n\nv2\n' },
  ], 'article: +2 agent — session s2 (glm), submitted y');
  assert.notEqual(sha2, sha1);
});

test('showRemoteFile reads merged content from origin/main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git2-'));
  const url = bareRemote(dir);
  seedRemote(dir, url);
  const seed = join(dir, 'seed');
  mkdirSync(join(seed, 'articles', 'w1', 'doc-1'), { recursive: true });
  writeFileSync(join(seed, 'articles', 'w1', 'doc-1', 'article.md'), 'merged-by-gates\n');
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'gate edit']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);

  const store = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  assert.equal(await store.showRemoteFile('articles/w1/doc-1/article.md'), 'merged-by-gates\n');
  assert.equal(await store.showRemoteFile('articles/w1/doc-1/nope.md'), null);
});

test('lost local clone adopts persisted remote branch instead of recreating from main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git-lost-'));
  const url = bareRemote(dir);
  seedRemote(dir, url);

  // First store creates the article branch and leaves it on the remote.
  const store1 = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone1'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  const sha1 = await store1.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v1\n' },
  ], 'cycle 1');
  assert.match(sha1, /^[0-9a-f]{40}$/);

  // Simulate clone wipe: a fresh GitStore with a new cloneDir, remote branch still present.
  const store2 = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone2'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  const sha2 = await store2.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v2\n' },
  ], 'cycle 2 after clone wipe');
  assert.notEqual(sha2, sha1);

  // The v2 commit must descend from the original article branch tip (FF push succeeded).
  const mergeBase = execFileSync('git', ['--git-dir', url, 'merge-base', sha1, sha2], { encoding: 'utf-8' }).trim();
  assert.equal(mergeBase, sha1, 'second commit should be built on top of the persisted article branch');

  // After the remote branch is removed, a fresh clone falls back to origin/main again.
  await store2.retireBranch('article/w1/doc-1');
  const store3 = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone3'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  const sha3 = await store3.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v3\n' },
  ], 'cycle 3 after branch retired');
  assert.match(sha3, /^[0-9a-f]{40}$/);
  const remoteMain = execFileSync('git', ['--git-dir', url, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim();
  const base3 = execFileSync('git', ['--git-dir', url, 'merge-base', remoteMain, sha3], { encoding: 'utf-8' }).trim();
  assert.equal(base3, remoteMain, 'fallback recreates the branch from origin/main when the remote branch is gone');
});

test('retireBranch re-syncs main and removes the article branch (post-merge lifecycle; idempotent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-git3-'));
  const url = bareRemote(dir);
  seedRemote(dir, url);
  const store = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v1\n' },
  ], 'cycle 1');
  await store.retireBranch('article/w1/doc-1');
  await store.retireBranch('article/w1/doc-1');   // idempotent — merged handling may retry after a partial failure
  let threw = false;
  try { execFileSync('git', ['--git-dir', url, 'rev-parse', '--verify', 'article/w1/doc-1']); } catch { threw = true; }
  assert.ok(threw, 'remote article branch should be gone');
  const head = execFileSync('git', ['-C', join(dir, 'clone'), 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
  assert.equal(head, 'main');   // the clone is parked on a re-synced main for the next cycle
});

test('stale tracking ref after out-of-band branch delete must not resurrect the branch from the old tip', async () => {
  // Production sequence (writer-host-02 2026-09-15): the head branch
  // disappears server-side at merge time (gate's merge-time delete), the
  // clone keeps a stale origin/article/* tracking ref (retireBranch's
  // push --delete fails against the gone branch and prunes nothing; every
  // fetch is scoped to main), and the next submit's origin/<branch> check
  // resolves the stale ref — basing the new cycle on the pre-merge tip, so
  // the next PR conflicts with main's post-merge changes.
  const dir = mkdtempSync(join(tmpdir(), 'orch-git-stale-'));
  const url = bareRemote(dir);
  seedRemote(dir, url);

  const store = new GitStore({ repoUrl: url, cloneDir: join(dir, 'clone'), mainBranch: 'main', authorName: 'o', authorEmail: 'o@e' });
  const sha1 = await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v1\n' },
  ], 'cycle 1');

  // Merge-time branch delete, out-of-band: the clone's tracking ref goes stale.
  execFileSync('git', ['--git-dir', url, 'branch', '-D', 'article/w1/doc-1']);
  // And main moves on (post-merge stamp / other merges).
  const seed = join(dir, 'seed');
  writeFileSync(join(seed, 'POSTMERGE.md'), 'stamp\n');
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'post-merge stamp']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'main']);
  const mainTip = execFileSync('git', ['--git-dir', url, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim();

  // Production's merged handling: retireBranch runs anyway (idempotent) — its
  // push --delete fails against the already-gone branch, but the local branch
  // is dropped.
  await store.retireBranch('article/w1/doc-1');

  // Next submit: must base on the CURRENT main tip, not the stale branch tip.
  const sha2 = await store.upsertBranchFiles('article/w1/doc-1', [
    { path: 'articles/w1/doc-1/article.md', content: 'v2\n' },
  ], 'cycle 2');
  const base = execFileSync('git', ['--git-dir', url, 'merge-base', mainTip, sha2], { encoding: 'utf-8' }).trim();
  assert.equal(base, mainTip, 'next cycle must be created fresh from the main tip, not from the stale branch tip');
  assert.notEqual(base, sha1, 'and must not resurrect the deleted branch');
});
