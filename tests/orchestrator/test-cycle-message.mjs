// Cycle commit message from _commits manifests (ADR-0006 label source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { cycleMessage } = await mod('cycle-message');

const manifest = [
  { ts: 1000, parent: null, fromTs: 0, trigger: 'agent-finished', actors: ['agent'], snapshotTs: 1,
    summary: { added: 3, edited: 1, removed: 0, byActor: { agent: { added: 3, edited: 1, removed: 0 } } } },
  { ts: 2000, parent: 1000, fromTs: 1000, trigger: 'accept', actors: ['human'], snapshotTs: 2,
    summary: { added: 0, edited: 2, removed: 1, byActor: { human: { added: 0, edited: 2, removed: 1 } } } },
  // race-path accept: stamps accepted[] in the doc but has NO net authored change
  { ts: 2500, parent: 2000, fromTs: 2000, trigger: 'accept', actors: [], snapshotTs: 2,
    summary: { added: 0, edited: 0, removed: 0, byActor: {} } },
  { ts: 3000, parent: 2500, fromTs: 2500, trigger: 'manual', actors: ['human', 'agent'], snapshotTs: 3,
    summary: { added: 0, edited: 0, removed: 4, byActor: { human: { added: 0, edited: 0, removed: 1 }, agent: { added: 0, edited: 0, removed: 3 } } } },
].map((l) => JSON.stringify(l)).join('\n') + '\n';

function writeManifest(dir) {
  const p = join(dir, '_commits', 'doc-1.jsonl');
  mkdirSync(join(dir, '_commits'), { recursive: true });
  writeFileSync(p, manifest);
  return p;
}

test('sums the window and formats the message', () => {
  const p = writeManifest(mkdtempSync(join(tmpdir(), 'orch-msg-')));
  const msg = cycleMessage(p, 0, 9999, { at: '2026-09-08T10:00:00.000Z', sessionId: 'a3f2', model: 'glm-5.3-flash' });
  assert.equal(
    msg,
    'article: +3 ~1 -3 agent · ~2 -2 you — session a3f2 (glm-5.3-flash), submitted 2026-09-08T10:00:00.000Z',
  );
});

test('window before all lines → submit-only message', () => {
  const p = writeManifest(mkdtempSync(join(tmpdir(), 'orch-msg-')));
  const msg = cycleMessage(p, 9000, 9500, { at: '2026-09-08T10:00:00.000Z', sessionId: 'a3f2', model: 'glm' });
  assert.equal(msg, 'article: submitted — session a3f2 (glm), submitted 2026-09-08T10:00:00.000Z');
});

test('missing manifest file → submit-only message', () => {
  const msg = cycleMessage('/nonexistent/doc.jsonl', 0, 9999, { at: 'x', sessionId: 's', model: 'm' });
  assert.equal(msg, 'article: submitted — session s (m), submitted x');
});
