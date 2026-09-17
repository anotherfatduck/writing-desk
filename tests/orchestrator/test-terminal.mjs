// Terminal states: merge-back guard, conflict, rejection + revision cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { startFakeGitea } from './lib/fake-gitea.mjs';
import { seedBareRemote, fixtureRoot, articleDoc, STAMP_AT, makeCfg, makePorts } from './lib/fixture.mjs';

const require = createRequire(import.meta.url);
const matter = require('gray-matter');

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { pollOnce } = await mod('run');
const { GitStore } = await mod('git-store');
const { httpGitea } = await mod('gitea');
const { loadArticle, saveArticle } = await mod('state');
const { readDocHead } = await mod('frontmatter');
const { bodyHashHex, sha256Hex } = await mod('util');
const { scanWriterRoot } = await mod('scan');

// The ship-refusal note copy (spec §2, second sequential adopter) — verbatim.
const SHIP_REFUSAL_NOTE = [
  'The library version of this article moved forward since you checked it out,',
  'and your desk copy is based on the older version.',
  '',
  'Your work is not lost. Open the History tab to see past snapshots. You can',
  'return the article to the library (Return to library — your text stays in',
  'History), or bring your desk copy in line with the',
  'library — then submit the article for approval again. A fresh submission',
  'starts a new review.',
].join('\n') + '\n';


/** Seed origin/main with the gate-edited article (the physician's merge). */
function seedGateEdit(dir, remote) {
  const gate = join(dir, 'gate');
  execFileSync('git', ['clone', remote, gate], { stdio: ['ignore', 'ignore', 'inherit'] });
  mkdirSync(join(gate, 'articles', 'w1', 'doc-1'), { recursive: true });
  const gateEdited = articleDoc().replace('Body v1.', 'Body v1 — gate-edited by physician');
  writeFileSync(join(gate, 'articles', 'w1', 'doc-1', 'article.md'), gateEdited);
  execFileSync('git', ['-C', gate, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'add', '.']);
  execFileSync('git', ['-C', gate, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'commit', '-m', 'gate edit']);
  execFileSync('git', ['-C', gate, 'push', 'origin', 'main']);
  return gateEdited;
}

function setup(dir) {
  const { root, articlePath } = fixtureRoot(dir);
  const remote = seedBareRemote(dir);
  // pass 2 polls PR state through the REAL adapter over the fake's HTTP
  // surface — the adapter's env contract is production wiring, so supply it
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  const portsFor = (fake) => {
    const cfg = makeCfg(dir, { root, remote, fake });
    const p = makePorts(cfg, fake);
    return { cfg, ports: { git: new GitStore(p.git), gitea: httpGitea(p.gitea) } };
  };
  return { root, articlePath, remote, portsFor };
}

// --- adopted-doc fixtures (spec §2): multi-writer roots + a seeded main ------

/** A desk doc's raw frontmatter + body. `undefined` keys are omitted (js-yaml
 *  refuses them); gray-matter is the same YAML engine the app uses. */
function deskDoc({ docId, title = 'Hypertension Follow-up', libraryKey = null, published = null, submittedAt = null, body = 'Body v1.\n' }) {
  const data = { docId, title };
  if (libraryKey) data.library = { key: libraryKey };
  const review = {};
  if (published) review.published = published;
  if (submittedAt) review.submitted = { at: submittedAt, sessionId: 's1', model: 'glm-5.3-flash' };
  if (Object.keys(review).length > 0) data.review = review;
  return matter.stringify(body, data);
}

/** One writer root (profiles/p1) holding the given docs. */
function mkWriter(dir, id, docs) {
  const root = join(dir, id);
  const profile = join(root, 'profiles', 'p1');
  mkdirSync(join(profile, '_commits'), { recursive: true });
  for (const d of docs) {
    writeFileSync(join(profile, d.fileName ?? 'Article.md'), d.raw);
    mkdirSync(join(profile, '_chats', d.docId), { recursive: true });
    writeFileSync(join(profile, '_chats', d.docId, 's1.jsonl'), '{"role":"user","text":"draft"}\n');
    writeFileSync(join(profile, '_commits', `${d.docId}.jsonl`),
      JSON.stringify({
        ts: 1000, parent: null, fromTs: 0, trigger: 'agent-finished', actors: ['agent'], snapshotTs: 1,
        summary: { added: 5, edited: 0, removed: 0, byActor: { agent: { added: 5, edited: 0, removed: 0 } } },
      }) + '\n');
  }
  return { root, profile };
}

/** Commit a file onto origin/main (the library's current state). */
function seedMain(dir, remote, path, content, tag) {
  const g = join(dir, `seed-${tag}`);
  execFileSync('git', ['clone', remote, g], { stdio: ['ignore', 'ignore', 'inherit'] });
  mkdirSync(dirname(join(g, path)), { recursive: true });
  writeFileSync(join(g, path), content);
  execFileSync('git', ['-C', g, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'add', '.']);
  execFileSync('git', ['-C', g, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'commit', '-m', `seed ${path}`]);
  execFileSync('git', ['-C', g, 'push', 'origin', 'main']);
}

/** The physician's merge: fold a pushed article branch into origin/main. */
function mergeToMain(dir, remote, branch, tag) {
  const g = join(dir, `merge-${tag}`);
  execFileSync('git', ['clone', remote, g], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('git', ['-C', g, '-c', 'user.email=g@e', '-c', 'user.name=gate', 'fetch', 'origin']);
  execFileSync('git', ['-C', g, '-c', 'user.email=g@e', '-c', 'user.name=gate',
    'merge', '--no-ff', '-m', `merge ${branch}`, `origin/${branch}`]);
  execFileSync('git', ['-C', g, 'push', 'origin', 'main']);
}

const remoteFile = (remote, ref, path) =>
  execFileSync('git', ['--git-dir', remote, 'show', `${ref}:${path}`], { encoding: 'utf-8' });
const remotePaths = (remote) =>
  execFileSync('git', ['--git-dir', remote, 'log', '--all', '--name-only', '--pretty=format:'], { encoding: 'utf-8' });
const postCount = (fake) => fake.calls.filter((c) => c.method === 'POST' && /\/pulls$/.test(c.url)).length;

/** Multi-writer ports: a cfg over the given roots + the REAL adapters (pass 2
 *  polls PR state through httpGitea over the fake's HTTP surface, as in setup). */
function portsForRoots(dir, fake, remote, roots) {
  process.env.GITEA_BASIC_USER = 'writer-orchestrator';
  process.env.GITEA_BASIC_PASS = 'test-pass';
  const cfg = { ...makeCfg(dir, { root: roots[0].root, remote, fake }), writerRoots: roots };
  const p = makePorts(cfg, fake);
  return { cfg, ports: { git: new GitStore(p.git), gitea: httpGitea(p.gitea) } };
}

test('merged + clean workspace → merged content written back, review.published stamped, submitted cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-term-'));
  const { articlePath, remote, portsFor } = setup(dir);
  const gateEdited = seedGateEdit(dir, remote);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship + observe open
  await pollOnce(cfg, ports);   // terminal: merged → merge-back

  const after = readFileSync(articlePath, 'utf-8');
  assert.match(after, /gate-edited by physician/);
  assert.equal(readDocHead(after).submittedAt, null);
  const published = matter(after).data.review.published;
  assert.equal(published.pr, 11);
  assert.equal(published.sha, createHash('sha256').update(gateEdited).digest('hex'));
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'idle');
  // branch retired at the merged state (spec §Commit shape): the next cycle
  // re-creates it from the fresh main tip, so the next PR's diff is cycle-2 only
  let branchGone = false;
  try { execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'article/w1/doc-1']); } catch { branchGone = true; }
  assert.ok(branchGone, 'merged article branch should be retired');
  await fake.close();
});

test('merged + diverged workspace → conflict note, stamp cleared + conflict stamped, NO clobber', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-conf-'));
  const { articlePath, remote, portsFor } = setup(dir);
  seedGateEdit(dir, remote);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship
  // the writer edits the article AFTER submitting
  writeFileSync(articlePath, readFileSync(articlePath, 'utf-8') + '\nwriter edit\n');
  const beforeConflict = readFileSync(articlePath, 'utf-8');
  await pollOnce(cfg, ports);   // terminal: merged but diverged → conflict

  const current = readFileSync(articlePath, 'utf-8');
  assert.equal(bodyHashHex(current), bodyHashHex(beforeConflict));                 // body untouched
  assert.equal(readDocHead(current).submittedAt, null);                            // conflict-write cleared the stamp
  const rv = matter(current).data.review;
  assert.equal(rv.pr, undefined, 'review.pr cleared at conflict-write');
  assert.equal(rv.conflict.pr, 11, 'review.conflict stamped with the PR number');
  assert.equal(typeof rv.conflict.at, 'string', 'review.conflict stamped with a timestamp');
  const note = readFileSync(articlePath + '.merge-conflict.txt', 'utf-8');
  assert.match(note, /changed in the library/);
  assert.match(note, /submit the article for approval again/);
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'conflict');
  await fake.close();
});

test('frontmatter resync after the stamp (same body, app JSON dialect) → still a clean merge-back', async () => {
  // UAT 2026-09-11: the app's external-write reload re-saves the doc
  // moments after any orchestrator stamp, re-serializing frontmatter (YAML →
  // the app's JSON dialect). Whole-file hashing read that as writer divergence
  // and refused the merge-back. The guard now compares body hashes: same body,
  // any frontmatter dialect → publish.
  const dir = mkdtempSync(join(tmpdir(), 'orch-resync-'));
  const { articlePath, remote, portsFor } = setup(dir);
  seedGateEdit(dir, remote);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship + observe open (review.pr stamped in YAML)
  // Simulate the app's reload resync: identical body, frontmatter re-serialized
  // to the app's JSON dialect (as seen live on the box).
  const stamped = readFileSync(articlePath, 'utf-8');
  const { data, content } = matter(stamped, {});
  writeFileSync(articlePath, `---\n${JSON.stringify(data)}\n---\n${content}`);
  assert.notEqual(readFileSync(articlePath, 'utf-8'), stamped);   // bytes really changed
  await pollOnce(cfg, ports);   // terminal: merged → body guard passes → merge-back

  const after = readFileSync(articlePath, 'utf-8');
  assert.match(after, /gate-edited by physician/);
  assert.equal(readDocHead(after).submittedAt, null);
  assert.equal(matter(after).data.review.published.pr, 11);
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'idle');
  await fake.close();
});

test('bodyHashHex is the prose hash — trailing whitespace invisible, prose changes not', async () => {
  // UAT 2026-09-11 + workspace 2026-09-16: the serializer's
  // trimEnd strips a trailing space between push and merge-back; the guard
  // hashed it byte-exactly and refused the merge of identical prose.
  // bodyHashHex is the PROSE hash: per-line trailing whitespace ([ \t\r]
  // — exactly the serializer's trimEnd class) never changes it.
  assert.equal(bodyHashHex('Body v1.\n'), bodyHashHex('Body v1. \n'), 'trailing space (the workspace byte)');
  assert.equal(bodyHashHex('Body v1.\n'), bodyHashHex('Body v1.\t\n'), 'trailing tab');
  assert.equal(bodyHashHex('Body v1.\n'), bodyHashHex('Body v1.\r\n'), 'trailing CR (trimEnd parity)');
  assert.notEqual(bodyHashHex('Body v1.\n'), bodyHashHex('Body v2.\n'), 'prose change still differs');
  assert.notEqual(bodyHashHex('A  B\n'), bodyHashHex('A B\n'), 'mid-line spaces are prose — still differ');
});

test('trailing-space desk trim between push and merge → still a clean merge-back (workspace 2026-09-16)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ws-'));
  const { articlePath, remote, portsFor } = setup(dir);
  seedGateEdit(dir, remote);
  // the submitted body carries a trailing space at the paragraph end
  writeFileSync(articlePath, readFileSync(articlePath, 'utf-8').replace('Body v1.', 'Body v1. '));
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship: the pushed body carries the trailing space
  // the serializer's move: the app's next save re-serializes without it
  writeFileSync(articlePath, readFileSync(articlePath, 'utf-8').replace('Body v1. ', 'Body v1.'));
  await pollOnce(cfg, ports);   // terminal: merged, prose identical → publish, NOT conflict

  const after = readFileSync(articlePath, 'utf-8');
  assert.match(after, /gate-edited by physician/);
  assert.equal(readDocHead(after).submittedAt, null);
  assert.equal(matter(after).data.review.published.pr, 11);
  assert.equal(existsSync(articlePath + '.merge-conflict.txt'), false, 'no phantom conflict note');
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'idle');
  await fake.close();
});

test('closed PR → rejection note + stamp cleared → fresh resubmit cycle works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-rej-'));
  const { articlePath, remote, portsFor } = setup(dir);
  const fake = await startFakeGitea();
  fake.script.push(
    { state: 'open' },
    { state: 'closed', merged: false },
    { state: 'open' },
  );
  fake.postScript.push(
    { number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' },
    { number: 12, html_url: 'https://gitea.example/owner/content-repo/pulls/12' },
  );
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship → PR 11
  await pollOnce(cfg, ports);   // terminal: closed without merge

  assert.match(readFileSync(articlePath + '.submit-rejected.txt', 'utf-8'), /returned with notes/);
  assert.equal(readDocHead(readFileSync(articlePath, 'utf-8')).submittedAt, null);
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'idle');
  // rejection keeps the branch (spec §Commit shape): the next PR's diff
  // correctly re-shows everything unmerged
  execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'article/w1/doc-1']);

  // revision cycle: the doctor revises and resubmits (fresh stamp > watermark);
  // prNumber was cleared on the return to idle, so cycle 2 opens its own PR
  writeFileSync(articlePath, articleDoc('2026-09-08T14:00:00.000Z'));
  await pollOnce(cfg, ports);   // ship cycle 2 → PR 12
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.prNumber, 12);
  assert.equal(rec.state, 'pr-open');
  await fake.close();
});

test('conflict auto-idles: conflict-write cleared the stamp, next poll → idle, desk keeps the conflict stamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-res-'));
  const { articlePath, remote, portsFor } = setup(dir);
  seedGateEdit(dir, remote);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship
  writeFileSync(articlePath, readFileSync(articlePath, 'utf-8') + '\nwriter edit\n');
  await pollOnce(cfg, ports);   // terminal: diverged → conflict (stamp cleared here)
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'conflict');

  await pollOnce(cfg, ports);   // next tick: submittedAt gone → conflict → idle
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.state, 'idle');
  assert.equal(rec.prNumber, null, 'prNumber cleared on the return to idle');
  assert.equal(rec.prUrl, null, 'prUrl cleared on the return to idle');
  // the desk keeps showing the conflict: the doc still carries review.conflict
  assert.equal(typeof matter(readFileSync(articlePath, 'utf-8')).data.review.conflict?.at, 'string');
  await fake.close();
});

test('conflict + fresh resubmit before next tick → resolved and shipped same poll', async () => {  const dir = mkdtempSync(join(tmpdir(), 'orch-resubmit-'));
  const { articlePath, remote, portsFor } = setup(dir);
  seedGateEdit(dir, remote);
  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true }, { state: 'open' });
  fake.postScript.push(
    { number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' },
    { number: 12, html_url: 'https://gitea.example/owner/content-repo/pulls/12' },
  );
  const { cfg, ports } = portsFor(fake);

  await pollOnce(cfg, ports);   // ship → PR 11
  writeFileSync(articlePath, readFileSync(articlePath, 'utf-8') + '\nwriter edit\n');
  const divergedBody = readFileSync(articlePath, 'utf-8');
  await pollOnce(cfg, ports);   // terminal: diverged → conflict
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').state, 'conflict');

  // Desk fresh-submit before the next tick: clear conflict, stamp a new submittedAt
  // strictly newer than the watermark.
  const fresh = '2026-09-09T12:00:00.000Z';
  const parsed = matter(readFileSync(articlePath, 'utf-8'), {});
  parsed.data.review = { submitted: { at: fresh, sessionId: 's', model: 'm' } };
  writeFileSync(articlePath, matter.stringify(parsed.content, parsed.data));

  await pollOnce(cfg, ports);   // same tick: conflict → idle, then ship → PR 12
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.state, 'pr-open', 'fresh resubmit should break the conflict wedge');
  assert.equal(rec.prNumber, 12, 'new cycle should open PR 12');
  assert.equal(rec.prUrl, 'https://gitea.example/owner/content-repo/pulls/12');
  // The diverged writer body was pushed, not clobbered.
  const current = readFileSync(articlePath, 'utf-8');
  assert.equal(bodyHashHex(current), bodyHashHex(divergedBody));
  assert.equal(readDocHead(current).submittedAt, fresh);
  assert.equal(matter(current).data.review.conflict, undefined);
  await fake.close();
});

// --- spec §2: adopted submits map to the library key; ship-time base check ---

test('adopted doc on writer B ships to writer A article path — no duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-adopt-'));
  const remote = seedBareRemote(dir);
  const KEY = 'writerA/cb12af51';
  // Writer A's article already on main (its own ship+merge is test-cycle's job).
  const aArticle = deskDoc({ docId: 'cb12af51', body: 'Body v1.\n' });
  seedMain(dir, remote, `articles/${KEY}/article.md`, aArticle, 'a1');

  // Writer A's own desk copy — present, never submitted.
  const a = mkWriter(dir, 'writerA', [{ docId: 'cb12af51', raw: deskDoc({ docId: 'cb12af51' }) }]);
  // Writer B's adopted copy of A's article: it carries the library key and the
  // converged base (sha of the library article it checked out).
  const b = mkWriter(dir, 'writerB', [{
    docId: 'cb12af51',
    raw: deskDoc({
      docId: 'cb12af51', libraryKey: KEY,
      published: { at: '2026-09-08T09:00:00.000Z', pr: 7, sha: sha256Hex(aArticle) },
      submittedAt: '2026-09-08T12:00:00.000Z',
    }),
  }]);
  const roots = [{ id: 'writerA', root: a.root }, { id: 'writerB', root: b.root }];

  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsForRoots(dir, fake, remote, roots);

  await pollOnce(cfg, ports);   // ship: B's adopted submit → A's article branch
  const pushed = remoteFile(remote, `article/${KEY}`, `articles/${KEY}/article.md`);
  assert.match(pushed, /Body v1\./);
  const bPath = join(b.profile, 'Article.md');
  assert.equal(loadArticle(cfg.stateDir, KEY).lastPushedDocPath, bPath);

  mergeToMain(dir, remote, `article/${KEY}`, 'm1');
  await pollOnce(cfg, ports);   // terminal: merged → merge-back onto B's desk

  const bAfter = readFileSync(bPath, 'utf-8');
  assert.equal(matter(bAfter).data.review.published.pr, 11);
  assert.equal(matter(bAfter).data.review.published.sha, sha256Hex(pushed));
  assert.equal(readDocHead(bAfter).submittedAt, null);
  // The merged bytes are the corpus copy (ship-cleaned: no library block), but
  // the desk copy keeps its own check-out stamp — else the librarian resurrects
  // the shelf mirror and the next submit ships under the adopter's own key.
  assert.equal(matter(bAfter).data.library?.key, KEY);
  // the original writer's desk copy is untouched (the pinned merge-back desk)
  assert.equal(matter(readFileSync(join(a.profile, 'Article.md'), 'utf-8')).data.review, undefined);
  // the duplicate-article failure mode is dead: no path under the adopter's id
  const paths = remotePaths(remote);
  assert.ok(!paths.includes('articles/writerB/'), 'no duplicate article under writer B');
  assert.ok(paths.includes(`articles/${KEY}/article.md`), 'shipped at the library path');
  await fake.close();
});

test('second sequential adopter with a stale base → conflict at ship, no PR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-stale-'));
  const remote = seedBareRemote(dir);
  const KEY = 'orig/doc-1';
  const v2 = deskDoc({ docId: 'doc-1', body: 'Body v2.\n' });
  seedMain(dir, remote, `articles/${KEY}/article.md`, v2, 'v2');
  const shaV2 = sha256Hex(v2);

  // Two desks hold adopted copies of the same article, both converged at v2.
  // B's root is scanned first: A (the stale adopter) must be the LAST doc under
  // the key in this pass — a doc after the refusal would trip the shared-key
  // conflict→idle exit in the same tick and the refusal's conflict state would
  // never be observable.
  const base = { at: '2026-09-08T08:00:00.000Z', pr: 7, sha: shaV2 };
  const a = mkWriter(dir, 'writerA', [{
    docId: 'doc-1',
    raw: deskDoc({ docId: 'doc-1', libraryKey: KEY, published: base }),
  }]);
  const b = mkWriter(dir, 'writerB', [{
    docId: 'doc-1',
    raw: deskDoc({ docId: 'doc-1', libraryKey: KEY, published: base, submittedAt: '2026-09-08T10:00:00.000Z', body: 'Body v2 — B edit.\n' }),
  }]);
  const roots = [{ id: 'writerB', root: b.root }, { id: 'writerA', root: a.root }];

  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsForRoots(dir, fake, remote, roots);

  await pollOnce(cfg, ports);   // B ships (its base still matches v2)
  mergeToMain(dir, remote, `article/${KEY}`, 'm2');   // library is now v3
  await pollOnce(cfg, ports);   // terminal: merged → B's desk stamped published at v3
  const bPub = matter(readFileSync(join(b.profile, 'Article.md'), 'utf-8')).data.review.published;
  assert.notEqual(bPub.sha, shaV2, "B's desk converged on the new library version");
  assert.equal(postCount(fake), 1);

  // A (still based on v2) edits and submits fresh — strictly newer than the watermark.
  const aPath = join(a.profile, 'Article.md');
  const aRaw = deskDoc({
    docId: 'doc-1', libraryKey: KEY, published: base,
    submittedAt: '2026-09-08T12:00:00.000Z', body: 'Body v2 — A edit.\n',
  });
  writeFileSync(aPath, aRaw);

  await pollOnce(cfg, ports);   // base check: v2 vs current main v3 → REFUSE
  assert.equal(postCount(fake), 1, 'no PR opened for the stale adopter');
  const aAfter = readFileSync(aPath, 'utf-8');
  const rv = matter(aAfter).data.review;
  assert.equal(rv.submitted, undefined, 'review.submitted cleared by the refusal');
  assert.equal(rv.conflict.pr, null, 'ship refusal records no PR');
  assert.equal(typeof rv.conflict.at, 'string');
  assert.equal(readFileSync(`${aPath}.merge-conflict.txt`, 'utf-8'), SHIP_REFUSAL_NOTE);
  assert.equal(bodyHashHex(aAfter), bodyHashHex(aRaw), 'body byte-exact');
  assert.equal(loadArticle(cfg.stateDir, KEY).state, 'conflict');

  await pollOnce(cfg, ports);   // next tick: submittedAt gone → conflict → idle
  assert.equal(loadArticle(cfg.stateDir, KEY).state, 'idle');
  await fake.close();
});

test('adopter based on the current library version ships normally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fresh-'));
  const remote = seedBareRemote(dir);
  const KEY = 'orig/doc-1';
  const v3 = deskDoc({ docId: 'doc-1', body: 'Body v3.\n' });
  seedMain(dir, remote, `articles/${KEY}/article.md`, v3, 'v3');

  // B adopts AFTER the library reached v3: its published base is the current file.
  const b = mkWriter(dir, 'writerB', [{
    docId: 'doc-1',
    raw: deskDoc({
      docId: 'doc-1', libraryKey: KEY,
      published: { at: '2026-09-08T11:00:00.000Z', pr: 9, sha: sha256Hex(v3) },
      submittedAt: '2026-09-08T12:00:00.000Z', body: 'Body v3 — B edit.\n',
    }),
  }]);

  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' });
  fake.postScript.push({ number: 21, html_url: 'https://gitea.example/owner/content-repo/pulls/21' });
  const { cfg, ports } = portsForRoots(dir, fake, remote, [{ id: 'writerB', root: b.root }]);

  await pollOnce(cfg, ports);

  const rec = loadArticle(cfg.stateDir, KEY);
  assert.equal(rec.state, 'pr-open');
  assert.equal(rec.prNumber, 21);
  assert.equal(rec.lastPushedDocPath, join(b.profile, 'Article.md'));
  assert.equal(postCount(fake), 1);
  assert.match(remoteFile(remote, `article/${KEY}`, `articles/${KEY}/article.md`), /B edit/);
  const desk = readFileSync(join(b.profile, 'Article.md'), 'utf-8');
  assert.equal(matter(desk).data.review.conflict, undefined, 'base check passed — no conflict');
  await fake.close();
});

test('merge-back stamps the desk whose body was pushed (pinned doc path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-pin-'));
  const remote = seedBareRemote(dir);
  const KEY = 'orig/doc-1';
  // B's adopted desk copy — the raw doc B pushed as the library article.
  const bRaw = deskDoc({ docId: 'doc-1', libraryKey: KEY, published: { at: 'x', pr: 7, sha: 'v1' }, body: 'Body v1 — pushed by B.\n' });
  seedMain(dir, remote, `articles/${KEY}/article.md`, bRaw, 'pin');

  // Two adopted desks share the library key; A's root is scanned first, so the
  // stale desk A is the doc the terminal pass meets first.
  const aRaw = deskDoc({ docId: 'doc-1', libraryKey: KEY, published: { at: 'x', pr: 5, sha: 'old' }, body: 'Body v1 — A stale.\n' });
  const a = mkWriter(dir, 'writerA', [{ docId: 'doc-1', raw: aRaw }]);
  const b = mkWriter(dir, 'writerB', [{ docId: 'doc-1', raw: bRaw }]);
  const aPath = join(a.profile, 'Article.md');
  const bPath = join(b.profile, 'Article.md');

  const fake = await startFakeGitea();
  fake.script.push({ state: 'closed', merged: true });
  const { cfg, ports } = portsForRoots(dir, fake, remote, [{ id: 'writerA', root: a.root }, { id: 'writerB', root: b.root }]);

  // The record B's ship left: pr-open, pinned to B's desk file.
  saveArticle(cfg.stateDir, KEY, {
    state: 'pr-open', watermarkMs: 1725780000000, lastMessageTs: 0,
    lastPushedHash: bodyHashHex(bRaw), lastPushedSha: 'abc',
    lastPushedDocPath: bPath, prNumber: 11, prUrl: 'https://gitea.example/owner/content-repo/pulls/11', cycles: 1,
  });

  await pollOnce(cfg, ports);   // terminal only: the pinned desk gets the merge-back

  assert.equal(matter(readFileSync(bPath, 'utf-8')).data.review.published.pr, 11, "B's desk got the stamp");
  assert.equal(readFileSync(aPath, 'utf-8'), aRaw, 'A is byte-untouched — not the pushed desk');
  assert.equal(loadArticle(cfg.stateDir, KEY).state, 'idle');
  await fake.close();
});

test('title promotion between ship and merge — pin converges to the promoted path, terminal handling survives', async () => {
  // A doc can ship while untitled (nothing blocks stamping `submitted` on a
  // `_untitled-*.md`, and the scan deliberately includes those). The writer's
  // title promotion then renames the file mid-review (promoteTempFile), so no
  // scanned doc sits at the pinned path any more. Regression: the terminal pass
  // used to skip EVERY doc under the key in that state — the rec wedged
  // pr-open forever, the PR orphaned open, the desk never stamped
  // review.published despite the merge.
  const dir = mkdtempSync(join(tmpdir(), 'orch-promo-'));
  const remote = seedBareRemote(dir);
  const TEMP_NAME = '_untitled-3f9c2a44.md';
  const untitled = matter.stringify('Body v1.\n', {
    docId: 'doc-1',
    review: { submitted: { at: STAMP_AT, sessionId: 's1', model: 'glm-5.3-flash' } },
  });
  const w = mkWriter(dir, 'w1', [{ docId: 'doc-1', fileName: TEMP_NAME, raw: untitled }]);
  const tempPath = join(w.profile, TEMP_NAME);
  const titledPath = join(w.profile, 'Hypertension Follow-up.md');

  const fake = await startFakeGitea();
  fake.script.push({ state: 'open' }, { state: 'closed', merged: true });
  fake.postScript.push({ number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' });
  const { cfg, ports } = portsForRoots(dir, fake, remote, [{ id: 'w1', root: w.root }]);

  await pollOnce(cfg, ports);   // ship from the untitled path → PR 11
  assert.equal(loadArticle(cfg.stateDir, 'w1/doc-1').lastPushedDocPath, tempPath, 'pinned to the untitled path');

  // The writer sets a title: promoteTempFile renames the file on disk and the
  // app stamps `title` into frontmatter. The body is untouched.
  renameSync(tempPath, titledPath);
  const renamed = matter(readFileSync(titledPath, 'utf-8'), {});
  writeFileSync(titledPath, matter.stringify(renamed.content, { ...renamed.data, title: 'Hypertension Follow-up' }));

  mergeToMain(dir, remote, 'article/w1/doc-1', 'm1');
  await pollOnce(cfg, ports);   // terminal: merged → merge-back onto the PROMOTED path

  const after = readFileSync(titledPath, 'utf-8');
  assert.equal(matter(after).data.review.published.pr, 11, 'review.published stamped on the promoted doc');
  assert.equal(readDocHead(after).submittedAt, null, 'submitted stamp cleared by the merge-back');
  const rec = loadArticle(cfg.stateDir, 'w1/doc-1');
  assert.equal(rec.state, 'idle', 'the rec converged — not wedged pr-open');
  assert.equal(rec.prNumber, null, 'prNumber cleared on the return to idle');
  assert.equal(rec.lastPushedDocPath, titledPath, 'the pin migrated to the promoted path');
  assert.ok(!existsSync(tempPath), 'no doc at the pinned path any more');
  await fake.close();
});

test('replayed interrupted ship on a stale base → refused on the desk, no throw, no PR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-replay-'));
  const remote = seedBareRemote(dir);
  const KEY = 'orig/doc-1';
  const v3 = deskDoc({ docId: 'doc-1', body: 'Body v3.\n' });
  seedMain(dir, remote, `articles/${KEY}/article.md`, v3, 'v3');
  const shaV2 = sha256Hex(deskDoc({ docId: 'doc-1', body: 'Body v2.\n' }));

  // A's adopted copy is still based on v2 while the library is at v3.
  const aRaw = deskDoc({
    docId: 'doc-1', libraryKey: KEY,
    published: { at: '2026-09-08T08:00:00.000Z', pr: 7, sha: shaV2 },
    submittedAt: '2026-09-08T12:00:00.000Z', body: 'Body v2 — A edit.\n',
  });
  const a = mkWriter(dir, 'writerA', [{ docId: 'doc-1', raw: aRaw }]);
  const aPath = join(a.profile, 'Article.md');

  const fake = await startFakeGitea();
  const { cfg, ports } = portsForRoots(dir, fake, remote, [{ id: 'writerA', root: a.root }]);

  // The record a crash mid-ship left: state shipping, no PR. The restart replay
  // re-runs the ship — and the base check must refuse it without throwing
  // (shipping has no →conflict edge by design; the desk write is what matters).
  saveArticle(cfg.stateDir, KEY, {
    state: 'shipping', watermarkMs: 1725780000000, lastMessageTs: 0,
    lastPushedHash: bodyHashHex(aRaw), lastPushedSha: 'abc',
    lastPushedDocPath: aPath, prNumber: null, prUrl: null, cycles: 1,
  });

  await (async () => {
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try { await pollOnce(cfg, ports); } finally { console.error = orig; }   // must not throw
    assert.ok(errs.some((l) => l.includes('ship-refused (stale base)')), 'refusal logged as a refusal');
    // The refusal is a normal outcome, not an internal error: a rec the machine
    // cannot move to conflict ('shipping') must not blow up the ship path.
    assert.ok(!errs.some((l) => l.includes('ship failed')), `no ship failure in the refusal path: ${errs.join(' | ')}`);
  })();

  assert.equal(postCount(fake), 0, 'no PR for the refused replay');
  const aAfter = readFileSync(aPath, 'utf-8');
  const rv = matter(aAfter).data.review;
  assert.equal(rv.submitted, undefined, 'review.submitted cleared by the refusal');
  assert.equal(rv.conflict.pr, null, 'ship refusal records no PR');
  assert.equal(readFileSync(`${aPath}.merge-conflict.txt`, 'utf-8'), SHIP_REFUSAL_NOTE);
  assert.equal(bodyHashHex(aAfter), bodyHashHex(aRaw), 'body byte-exact');
  const rec = loadArticle(cfg.stateDir, KEY);
  assert.equal(rec.prNumber, null, 'the refusal never claims a PR');
  assert.equal(rec.state, 'shipping', 'no shipping -> conflict edge (state.ts) — rec stays inert');
  await fake.close();
});

// --- spec §1+§2: the whole monk loop, against the bare remote + fake gitea ---

test('monk loop: seed → adopt → submit → merge → re-propagate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-monk-'));
  const remote = seedBareRemote(dir);
  const KEY = 'writerA/doc-1';
  const DOC = 'doc-1';

  // A's desk holds the seeding article, submitted. B's desk is registered from
  // the start and empty — the library reaches it through the librarian, not a
  // submit of its own.
  const a = mkWriter(dir, 'writerA', [{
    docId: DOC,
    raw: deskDoc({ docId: DOC, submittedAt: STAMP_AT, body: 'Body v1.\n' }),
  }]);
  const b = mkWriter(dir, 'writerB', []);
  const roots = [{ id: 'writerA', root: a.root }, { id: 'writerB', root: b.root }];

  const fake = await startFakeGitea();
  // One PR-state read per shipping tick: the ship and its first observation
  // land in the same poll (the existing idiom), so a cycle is two reads.
  fake.script.push(
    { state: 'open' }, { state: 'closed', merged: true },
    { state: 'open' }, { state: 'closed', merged: true },
  );
  fake.postScript.push(
    { number: 11, html_url: 'https://gitea.example/owner/content-repo/pulls/11' },
    { number: 12, html_url: 'https://gitea.example/owner/content-repo/pulls/12' },
  );
  const { cfg, ports } = portsForRoots(dir, fake, remote, roots);

  // 1. seed: A submits → PR 11 ships to A's own article path; the gate merges;
  //    the next poll merges back and stamps A's desk.
  await pollOnce(cfg, ports);
  assert.equal(postCount(fake), 1, 'A opened PR 11');
  assert.match(remoteFile(remote, `article/${KEY}`, `articles/${KEY}/article.md`), /Body v1\./);

  mergeToMain(dir, remote, `article/${KEY}`, 'm1');
  await pollOnce(cfg, ports);
  const aPath = join(a.profile, 'Article.md');
  const aAfter = readFileSync(aPath, 'utf-8');
  assert.equal(matter(aAfter).data.review.published.pr, 11, "A's desk stamped review.published");
  assert.equal(
    matter(aAfter).data.review.published.sha,
    sha256Hex(remoteFile(remote, 'main', `articles/${KEY}/article.md`)),
    "published.sha is the merged library article",
  );
  assert.equal(readDocHead(aAfter).submittedAt, null);
  assert.equal(loadArticle(cfg.stateDir, KEY).state, 'idle');

  // 2. the librarian mirrored the merged article onto B's shelf: pristine
  //    library bytes (never stamped) + the identity map docId → key.
  await pollOnce(cfg, ports);
  const libV1 = remoteFile(remote, 'main', `articles/${KEY}/article.md`);
  const bMirror = join(b.root, 'library', `${DOC}.md`);
  assert.equal(readFileSync(bMirror, 'utf-8'), libV1, "B's shelf mirror is the pristine library bytes");
  assert.equal(matter(readFileSync(bMirror, 'utf-8')).data.library, undefined, 'mirrors are never stamped');
  assert.deepEqual(
    JSON.parse(readFileSync(join(b.root, 'library', 'index.json'), 'utf-8')),
    { [DOC]: KEY },
    'identity map: docId → library key',
  );

  // 3. adopt on B: the app-server promotes the mirror into B's working area
  //    (frontmatter spread-preserved, body byte-exact, stamped library.key);
  //    the shelf mirror stays — the catalog row survives the check-out
  //    (spec 2026-09-16).
  const bPath = join(b.profile, 'Article.md');
  const mirror = matter(readFileSync(bMirror, 'utf-8'));
  writeFileSync(bPath, matter.stringify(mirror.content, { ...mirror.data, library: { key: KEY } }));
  const adopted = scanWriterRoot(b.root);
  assert.equal(adopted.length, 1, 'the adopted doc is a normal desk doc');
  assert.equal(adopted[0].docId, DOC, 'the adopted doc keeps the library docId');
  assert.equal(adopted[0].libraryKey, KEY, 'scan sees the check-out');
  assert.equal(matter(readFileSync(bPath, 'utf-8')).content, mirror.content, 'body byte-exact vs the mirror');

  // 4. B edits + submits: the adopted doc ships under A's key — same branch
  //    prefix, SAME repo path (the duplicate-article failure mode stays dead).
  writeFileSync(bPath, matter.stringify('Body v2 — B edit.\n', {
    ...matter(readFileSync(bPath, 'utf-8')).data,
    review: { submitted: { at: '2026-09-08T12:00:00.000Z', sessionId: 's1', model: 'glm-5.3-flash' } },
  }));
  await pollOnce(cfg, ports);
  assert.equal(postCount(fake), 2, 'B opened a second PR');
  const libV2 = remoteFile(remote, `article/${KEY}`, `articles/${KEY}/article.md`);
  assert.match(libV2, /B edit/);
  const shipped = loadArticle(cfg.stateDir, KEY);
  assert.equal(shipped.state, 'pr-open');
  assert.equal(shipped.lastPushedDocPath, bPath, 'merge-back pinned to the adopter');
  const paths = remotePaths(remote);
  assert.ok(paths.includes(`articles/${KEY}/article.md`), 'shipped at the library path');
  assert.ok(!paths.includes('articles/writerB/'), 'no duplicate article under the adopter');

  // 5. the gate merges B's PR; the next poll merges back onto B's desk.
  mergeToMain(dir, remote, `article/${KEY}`, 'm2');
  await pollOnce(cfg, ports);
  const bAfter = readFileSync(bPath, 'utf-8');
  assert.equal(matter(bAfter).data.review.published.pr, 12, "B's desk stamped review.published");
  assert.equal(matter(bAfter).data.review.published.sha, sha256Hex(libV2), 'stamped at the merged version');
  assert.equal(readDocHead(bAfter).submittedAt, null);
  assert.equal(matter(bAfter).data.library.key, KEY, 'the check-out survives the merge-back');
  assert.equal(loadArticle(cfg.stateDir, KEY).state, 'idle');

  // 6. re-propagate: B's key is still checked out, but the catalog row stays
  //    current (the mirror never left — the catalog keeps the card in the
  //    drawer while the book is out, spec 2026-09-16); a desk registered after
  //    the merge seeds the new version.
  const c = mkWriter(dir, 'writerC', []);
  cfg.writerRoots.push({ id: 'writerC', root: c.root });
  await pollOnce(cfg, ports);

  const libV3 = remoteFile(remote, 'main', `articles/${KEY}/article.md`);
  assert.match(libV3, /B edit/, "the library advanced to B's version");
  assert.equal(readFileSync(join(b.root, 'library', `${DOC}.md`), 'utf-8'), libV3, "B keeps its catalog row at the current library version (the book is out, the card stays)");
  assert.equal(readFileSync(bPath, 'utf-8'), bAfter, "B's working copy is untouched — the desk copy is the working copy");
  const cMirror = join(c.root, 'library', `${DOC}.md`);
  assert.equal(readFileSync(cMirror, 'utf-8'), libV3, 'C seeded with the new library version');
  assert.deepEqual(
    JSON.parse(readFileSync(join(c.root, 'library', 'index.json'), 'utf-8')),
    { [DOC]: KEY },
    'C identity map',
  );
  await fake.close();
});
