// Integration: workspace → branch commit → PR (spec acceptance 1, 2, 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeGitea } from './lib/fake-gitea.mjs';
import { seedBareRemote, fixtureRoot, articleDoc, makeCfg, makePorts } from './lib/fixture.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { pollOnce } = await mod('run');
const { GitStore } = await mod('git-store');
const { httpGitea } = await mod('gitea');
const { loadArticle, saveArticle } = await mod('state');

// module-level fixture: tests below share it and run in file order
const dir = mkdtempSync(join(tmpdir(), 'orch-run-'));
const { root, articlePath } = fixtureRoot(dir);
const remote = seedBareRemote(dir);
// the adapter polls PR state through the REAL adapter (httpGitea) over the
// fake's HTTP surface — the adapter's env contract is production wiring, so
// the tests supply it (each test file is its own node process; no leakage)
process.env.GITEA_BASIC_USER = 'writer-orchestrator';
process.env.GITEA_BASIC_PASS = 'test-pass';

const portsFor = (fake) => {
  const cfg = makeCfg(dir, { root, remote, fake });
  const p = makePorts(cfg, fake);
  return { cfg, ports: { git: new GitStore(p.git), gitea: httpGitea(p.gitea) } };
};
const branchSha = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'article/w1/doc-1'], { encoding: 'utf-8' }).trim();
// POST /pulls is the PR-creation channel — "no second PR" is asserted on the
// fake's recorded POST count
const postCount = (fake) => fake.calls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url)).length;

test('submitted doc → one branch commit with article + transcript, PR opened, watermark set', async () => {
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);
  await pollOnce(cfg, ports);

  assert.match(branchSha(), /^[0-9a-f]{40}$/);
  const article = execFileSync('git', ['--git-dir', remote, 'show', 'article/w1/doc-1:articles/w1/doc-1/article.md'], { encoding: 'utf-8' });
  assert.match(article, /Body v1\./);
  // The corpus article never carries writer-session stamps or check-out
  // bookkeeping (live leak, 2026-09-15): the pushed copy is cleaned at ship
  // while the desk copy keeps its own stamps.
  const { default: matter } = await import('gray-matter');
  const pushed = matter(article).data;
  assert.equal(pushed.review, undefined);
  assert.equal(pushed.library, undefined);
  assert.equal(pushed.docId, 'doc-1');
  const desk = matter(readFileSync(articlePath, 'utf-8')).data;
  assert.equal(desk.review.submitted.at, '2026-09-08T10:00:00.000Z');
  assert.equal(desk.library.key, 'w1/doc-1');
  const chat = execFileSync('git', ['--git-dir', remote, 'show', 'article/w1/doc-1:articles/w1/doc-1/_chats/s1.jsonl'], { encoding: 'utf-8' });
  assert.match(chat, /draft/);
  const commitMsg = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%B', 'article/w1/doc-1'], { encoding: 'utf-8' });
  assert.match(commitMsg, /article: \+5 agent — session s1 \(glm-5\.3-flash\), submitted 2026-09-08/);
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.state, 'pr-open');
  assert.equal(rec.prNumber, 11);
  assert.equal(rec.watermarkMs, Date.parse('2026-09-08T10:00:00.000Z'));
  await fake.close();
});

test('restart replay: second pollOnce is a no-op (no duplicate commits, no second PR)', async () => {
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(fake);
  const before = branchSha();
  await pollOnce(cfg, ports);
  assert.equal(branchSha(), before);
  assert.equal(postCount(fake), 0);   // no second PR
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').prNumber, 11);
  await fake.close();
});

test('re-submit while PR open → amended onto the same branch/PR (no second PR)', async () => {
  // the doctor somehow re-stamps while the PR is open (submit refuses this in the
  // app; the orchestrator defends anyway): later stamp, same doc — with a body
  // edit. Ship-side cleaning means frontmatter-only churn now produces
  // byte-identical corpus bytes and no-ops the upsert (nothing to amend); a
  // body edit is what still amends.
  writeFileSync(articlePath, articleDoc('2026-09-08T11:00:00.000Z').replace('Body v1.', 'Body v1 — amend.'));
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  const { cfg, ports } = portsFor(fake);
  await pollOnce(cfg, ports);

  assert.equal(postCount(fake), 0);   // amended onto PR 11 — no second PR
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.prNumber, 11);
  assert.equal(rec.watermarkMs, Date.parse('2026-09-08T11:00:00.000Z'));
  // bare remote: refs/heads/main, not origin/main (no remote-tracking refs there)
  const count = execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'main..article/w1/doc-1'], { encoding: 'utf-8' }).trim();
  assert.equal(count, '2');   // cycle-1 commit + the amend commit
  await fake.close();
});

test('accept-only doc (no review.submitted) produces zero Gitea calls and no branch', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'orch-acc-'));
  const { root: root2 } = fixtureRoot(dir2, { submit: false });
  const remote2 = seedBareRemote(dir2);
  const fake = await startFakeGitea();
  const { cfg } = portsFor(fake);
  // point the repo AT remote2 — otherwise the branch check below would
  // inspect a repo the code under test never touches
  const cfg2 = { ...cfg, writerRoots: [{ id: 'w1', root: root2 }], stateDir: join(dir2, 'state'), repo: { ...cfg.repo, url: remote2, cloneDir: join(dir2, 'clone') } };
  const p2 = makePorts(cfg2, fake);
  await pollOnce(cfg2, { git: new GitStore(p2.git), gitea: httpGitea(p2.gitea) });

  assert.equal(postCount(fake), 0);   // no PR opened
  assert.equal(fake.calls.filter((c) => c.method === 'GET').length, 0);   // no PR-state poll either
  let threw = false;
  try { execFileSync('git', ['--git-dir', remote2, 'rev-parse', '--verify', 'article/w1/doc-1']); } catch { threw = true; }
  assert.ok(threw, 'no article branch should exist');
  await fake.close();
});

test('stuck-shipping record (crash mid-ship) recovers and completes on the next poll', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'orch-stuck-'));
  const { root: root2 } = fixtureRoot(dir2);
  const remote2 = seedBareRemote(dir2);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  fake.postScript.push({ number: 21, html_url: 'https://gitea.example/owner/content-repo/pulls/21' });
  const cfg2 = makeCfg(dir2, { root: root2, remote: remote2, fake });
  const p2 = makePorts(cfg2, fake);
  // simulate a crash mid-ship: record stuck in 'shipping', watermark not yet advanced
  saveArticle(cfg2.stateDir, 'w1/doc-1', {
    state: 'shipping', watermarkMs: 0, lastMessageTs: 0,
    lastPushedHash: null, lastPushedSha: null, prNumber: null, prUrl: null,
  });
  await pollOnce(cfg2, { git: new GitStore(p2.git), gitea: httpGitea(p2.gitea) });

  const rec = loadArticle(cfg2.stateDir, 'w1/doc-1');
  assert.equal(rec.state, 'pr-open');
  assert.equal(rec.prNumber, 21);
  await fake.close();
});
