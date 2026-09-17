// M4c gate-state visibility: the full stamp lifecycle on the workspace article
// (spec §Gate-state model, §Findings at return).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';
import { startFakeGitea } from './lib/fake-gitea.mjs';
import { seedBareRemote, fixtureRoot, makeCfg, makePorts } from './lib/fixture.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { pollOnce } = await mod('run');
const { GitStore } = await mod('git-store');
const { httpGitea } = await mod('gitea');
const { loadArticle } = await mod('state');
const { sha256Hex, bodyHashHex } = await mod('util');

const reviewOf = (raw) => (matter(raw).data.review ?? {});

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-gate-'));
  const { root, articlePath } = fixtureRoot(dir);
  const remote = seedBareRemote(dir);
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  return { dir, root, articlePath, remote };
};

const portsFor = (dir, { root, remote }, fake) => {
  const cfg = makeCfg(dir, { root, remote, fake });
  const p = makePorts(cfg, fake);
  return { cfg, ports: { git: new GitStore(p.git), gitea: httpGitea(p.gitea) } };
};

test('ship stamps review.pr into the workspace article and refreshes the pushed baseline', async () => {
  const { dir, root, articlePath, remote } = await setup();
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(dir, { root, remote }, fake);
  await pollOnce(cfg, ports);
  const raw = readFileSync(articlePath, 'utf-8');
  const review = reviewOf(raw);
  assert.ok(review.pr, 'review.pr stamped');
  assert.equal(review.pr.cycle, 1);
  assert.equal(typeof review.pr.url, 'string');
  assert.ok(review.submitted, 'submitted still stamped while PR open');
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.cycles, 1);
  // Baseline is the BODY hash of the stamped content: the guard is body-level
  // (the app's reload resync churns frontmatter bytes right after the stamp —
  // UAT 2026-09-11), so the recorded baseline must ignore them.
  assert.equal(rec.lastPushedHash, bodyHashHex(raw));
  assert.notEqual(rec.lastPushedHash, sha256Hex(raw));   // whole-file hash is NOT the baseline anymore
  await fake.close();
});

test('closed PR → review.returned stamped, submitted cleared, note carries the gate findings', async () => {
  const { dir, root, articlePath, remote } = await setup();
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(dir, { root, remote }, fake);
  await pollOnce(cfg, ports);                                    // ship → pr-open
  const prNumber = loadArticle(cfg.stateDir, 'w1/doc-1').prNumber;
  fake.script.push({ state: 'closed', merged: false });          // pass 2: gate closed it
  fake.commentScript.push([
    { user: { login: 'owner' }, body: 'Fix the unsupported claim in section 2.', created_at: '2026-09-09T10:00:00Z' },
  ]);
  await pollOnce(cfg, ports);
  const review = reviewOf(readFileSync(articlePath, 'utf-8'));
  assert.equal(review.submitted, undefined);
  assert.equal(review.pr, undefined);
  assert.equal(review.returned.pr, prNumber);
  assert.equal(typeof review.returned.at, 'string');
  const note = readFileSync(`${articlePath}.submit-rejected.txt`, 'utf-8');
  assert.match(note, /Notes from the reviewer:/);
  assert.match(note, /Fix the unsupported claim in section 2\./);
  assert.match(note, /the owner at 2026-09-09T10:00:00Z/);
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.prNumber, null, 'prNumber cleared after closed terminal');
  assert.equal(rec.prUrl, null, 'prUrl cleared after closed terminal');
  await fake.close();
});

test('closed PR with zero comments keeps the rejection note in desk/library prose', async () => {
  const { dir, root, articlePath, remote } = await setup();
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(dir, { root, remote }, fake);
  await pollOnce(cfg, ports);                                    // ship → pr-open
  fake.script.push({ state: 'closed', merged: false });          // pass 2: gate closed it
  fake.commentScript.push([]);                                   // no comments from the gate
  await pollOnce(cfg, ports);
  const note = readFileSync(`${articlePath}.submit-rejected.txt`, 'utf-8');
  assert.doesNotMatch(note, /Notes from the reviewer:/);
  assert.doesNotMatch(note, /reviewer notes unavailable:/);
  assert.match(note, /Your article was returned with notes from the reviewer/);
  assert.match(note, /No changes were made to your desk copy\./);
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.prNumber, null, 'prNumber cleared after closed terminal');
  assert.equal(rec.prUrl, null, 'prUrl cleared after closed terminal');
  await fake.close();
});

test('closed PR with malformed comments response falls back to findings unavailable', async () => {
  const { dir, root, articlePath, remote } = await setup();
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(dir, { root, remote }, fake);
  await pollOnce(cfg, ports);                                    // ship → pr-open
  fake.script.push({ state: 'closed', merged: false });          // pass 2: gate closed it
  fake.commentScript.push({ notAnArray: true });                 // GET /issues/:n/comments returns an object, so getPrComments throws
  await pollOnce(cfg, ports);
  const note = readFileSync(`${articlePath}.submit-rejected.txt`, 'utf-8');
  assert.match(note, /reviewer notes unavailable:/);
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.prNumber, null, 'prNumber cleared after closed terminal');
  assert.equal(rec.prUrl, null, 'prUrl cleared after closed terminal');
  await fake.close();
});

/** Seed origin/main with the physician's merge of the current workspace article. */
function seedPhysicianMerge(remote, articleRaw) {
  const gate = mkdtempSync(join(tmpdir(), 'orch-gate-merge-'));
  execFileSync('git', ['clone', remote, gate]);
  mkdirSync(join(gate, 'articles', 'w1', 'doc-1'), { recursive: true });
  writeFileSync(join(gate, 'articles', 'w1', 'doc-1', 'article.md'), articleRaw);
  execFileSync('git', ['-C', gate, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'add', '.']);
  execFileSync('git', ['-C', gate, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'commit', '-m', 'physician merge']);
  execFileSync('git', ['-C', gate, 'push', 'origin', 'main']);
}

test('merged PR → review.pr cleared, review.published stamped (existing merge-back, now stamp-complete)', async () => {
  const { dir, articlePath, root, remote } = await setup();
  const fake = await startFakeGitea();
  const { cfg, ports } = portsFor(dir, { root, remote }, fake);
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  await pollOnce(cfg, ports);                    // ship + observe open
  const stampedRaw = readFileSync(articlePath, 'utf-8');
  seedPhysicianMerge(remote, stampedRaw);          // model the gate merging the PR
  await pollOnce(cfg, ports);                    // terminal: merged → merge-back
  const review = reviewOf(readFileSync(articlePath, 'utf-8'));
  assert.equal(review.pr, undefined);
  assert.ok(review.published, 'published stamped');
  assert.equal(review.submitted, undefined);
  await fake.close();
});
