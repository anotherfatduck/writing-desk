// Per-article state store: defaults, round-trip, transition legality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { articleKey, loadArticle, saveArticle, transition } = await mod('state');

test('defaults and round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-st-'));
  const rec = loadArticle(dir, articleKey('w1', 'doc-1'));
  assert.equal(rec.state, 'idle');
  assert.equal(rec.watermarkMs, 0);
  assert.equal(rec.lastPushedDocPath, null, 'DEFAULT pins no desk path');
  const rec2 = transition(rec, 'shipping');
  rec2.watermarkMs = 1725780000000;
  rec2.lastPushedHash = 'deadbeef';
  rec2.lastPushedSha = 'abc';
  rec2.lastPushedDocPath = '/ws/profiles/p1/Article.md';
  rec2.lastMessageTs = 42;
  rec2.prNumber = 11;
  rec2.prUrl = 'https://x/pulls/11';
  saveArticle(dir, articleKey('w1', 'doc-1'), rec2);
  assert.deepEqual(loadArticle(dir, articleKey('w1', 'doc-1')), rec2);
});

test('illegal transitions throw; legal ones keep fields', () => {
  const rec = loadArticle('/nonexistent-should-default', 'w/d');
  assert.equal(rec.state, 'idle');
  assert.throws(() => transition(rec, 'merged'), /illegal state transition idle -> merged/);
  assert.throws(() => transition({ ...rec, state: 'shipping' }, 'conflict'), /illegal state transition shipping -> conflict/);
  // the ship-failure restore bypasses the machine (direct saveArticle) — no edge
  assert.throws(() => transition({ ...rec, state: 'shipping' }, 'idle'), /illegal state transition shipping -> idle/);
  assert.equal(transition({ ...rec, state: 'pr-open' }, 'merged').state, 'merged');
  // the amend defense: pr-open → shipping is legal
  assert.equal(transition({ ...rec, state: 'pr-open' }, 'shipping').state, 'shipping');
  // crash recovery: a record caught mid-ship re-runs the ship
  assert.equal(transition({ ...rec, state: 'shipping' }, 'shipping').state, 'shipping');
  // the diverged merge-back: pr-open → conflict is legal (spec §Terminal states)
  assert.equal(transition({ ...rec, state: 'pr-open' }, 'conflict').state, 'conflict');
  // the ship-time base check refusing an idle adopted copy (spec §2)
  assert.equal(transition(rec, 'conflict').state, 'conflict');
});

test('legacy records without lastPushedDocPath load as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-legacy-'));
  // a record written before the field existed (statePath sanitizes the key)
  writeFileSync(join(dir, 'w1_doc-1.json'), JSON.stringify({
    state: 'pr-open', watermarkMs: 5, lastMessageTs: 0,
    lastPushedHash: 'h', lastPushedSha: 's', prNumber: 11, prUrl: 'u', cycles: 1,
  }));
  const rec = loadArticle(dir, articleKey('w1', 'doc-1'));
  assert.equal(rec.lastPushedDocPath, null);
  assert.equal(rec.prNumber, 11);
  assert.equal(rec.watermarkMs, 5);
});

test('keys with odd docIds stay inside the state dir and round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-st-'));
  const key = articleKey('w1', '../../evil');
  const rec = { ...loadArticle(dir, key), watermarkMs: 5 };
  saveArticle(dir, key, rec);
  const files = readdirSync(dir);
  assert.ok(files.every((f) => /^[A-Za-z0-9._-]+\.json$/.test(f)), JSON.stringify(files));
  assert.equal(loadArticle(dir, key).watermarkMs, 5);
});
