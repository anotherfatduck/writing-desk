// Review-stamp frontmatter surgery + CAS primitives. Spec Decision 9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const matter = require('gray-matter');

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const fm = await mod('frontmatter');
const { readDocHead, publishedTransition, submittedClearedTransition, prOpenedTransition, returnedTransition, cleanForShipTransition, readLibraryBlock, reapplyLibraryTransition } = fm;
const { withMtimeCas, MtimeRaceError } = await mod('util');

const DOC = `---
docId: doc-abc
title: Hypertension Follow-up
review:
  submitted:
    at: "2026-09-08T10:00:00.000Z"
    sessionId: sess-1
    model: glm-5.3-flash
provenance:
  - agentSessionId: sess-1
    model: glm-5.3-flash
    promptVersion: v3
    proposedAt: "2026-09-08T09:58:00.000Z"
    acceptedAt: "2026-09-08T09:59:00.000Z"
    accepted:
      - nodeId: n1
        status: accepted
---

Body line one.

Body line two.
`;

// everything after the frontmatter's closing ---
const bodyOf = (s) => s.slice(s.indexOf('---', 4) + 4);

test('publishedTransition preserves body-only and empty-block input', () => {
  const bodyOnly = 'Just body, no frontmatter.';
  const emptyBlock = '---\n---\nBody here.';
  assert.equal(publishedTransition({ at: '...', pr: 1, sha: 's' })(bodyOnly), bodyOnly);
  assert.equal(publishedTransition({ at: '...', pr: 1, sha: 's' })(emptyBlock), emptyBlock);
});

test('submittedClearedTransition preserves body-only and empty-block input', () => {
  const bodyOnly = 'Just body, no frontmatter.';
  const emptyBlock = '---\n---\nBody here.';
  assert.equal(submittedClearedTransition()(bodyOnly), bodyOnly);
  assert.equal(submittedClearedTransition()(emptyBlock), emptyBlock);
});

test('transitions are cache-safe (parse-twice sequence)', () => {
  // 1. Populate gray-matter cache with DOC
  readDocHead(DOC);

  // 2. publishedTransition must still apply
  const pub = publishedTransition({ at: '2026-09-08T12:00:00.000Z', pr: 11, sha: 'abc123' })(DOC);
  assert.ok(matter(pub).data.review.published);
  assert.equal(matter(pub).data.review.submitted, undefined);

  // 3. submittedClearedTransition must still apply
  const cleared = submittedClearedTransition()(DOC);
  assert.equal(readDocHead(cleared).submittedAt, null);
});

test('readDocHead extracts docId/title/submitted stamp', () => {
  const h = readDocHead(DOC);
  assert.equal(h.docId, 'doc-abc');
  assert.equal(h.title, 'Hypertension Follow-up');
  assert.equal(h.submittedAt, '2026-09-08T10:00:00.000Z');
  assert.equal(h.sessionId, 'sess-1');
  assert.equal(h.model, 'glm-5.3-flash');
});

test('readLibraryKey: reads the stamp, null-safe otherwise', () => {
  const { readLibraryKey } = fm;
  assert.equal(readLibraryKey('Body text with no frontmatter.'), null);
  assert.equal(readLibraryKey(''), null);
  const raw = matter.stringify('Body text.', { docId: 'cb12af51', title: 'T' });
  assert.equal(readLibraryKey(raw), null);
  const stamped = matter.stringify('Body text.', {
    docId: 'cb12af51', title: 'T', library: { key: '35845f18-1111-4222-8333-444455556666/cb12af51' },
  });
  assert.equal(readLibraryKey(stamped), '35845f18-1111-4222-8333-444455556666/cb12af51');
});

test('publishedTransition clears review.submitted, adds review.published, preserves body + provenance', () => {
  const next = publishedTransition({ at: '2026-09-08T12:00:00.000Z', pr: 11, sha: 'abc123' })(DOC);
  const { data } = matter(next);
  assert.deepEqual(data.review.published, { at: '2026-09-08T12:00:00.000Z', pr: 11, sha: 'abc123' });
  assert.equal(data.review.submitted, undefined);
  assert.equal(readDocHead(next).submittedAt, null);
  assert.equal(bodyOf(next), bodyOf(DOC));                              // body byte-identical
  assert.deepEqual(data.provenance, matter(DOC).data.provenance);       // provenance array round-trips
});

test('submittedClearedTransition clears review.submitted only', () => {
  const next = submittedClearedTransition()(DOC);
  assert.equal(readDocHead(next).submittedAt, null);
  assert.equal(matter(next).data.review.published, undefined);
  assert.equal(matter(next).data.docId, 'doc-abc');
  assert.equal(bodyOf(next), bodyOf(DOC));
});

// The corpus article must never carry writer-session stamps (review.*) or
// check-out bookkeeping (library.*): the ship path commits the desk file, so
// the pushed copy is cleaned at ship — live leak, 2026-09-15 (Intermittent
// Fasting re-adopt showed "Sent for review" from a corpus-carried stamp).
test('cleanForShipTransition strips cycle stamps + library, keeps published, body and all other keys', () => {
  const raw = matter.stringify('Body line one.\n\nBody line two.', {
    docId: '0a80461e',
    title: 'Intermittent Fasting',
    review: {
      submitted: { at: '2026-09-15T06:52:54.084Z', sessionId: 'user', model: 'user' },
      pr: { at: '2026-09-15T06:53:00.000Z', url: 'https://g/11', cycle: 1 },
      published: { at: '2026-02-03T00:00:00.000Z', pr: null, sha: 'abc123' },
    },
    library: { key: '44ff9a1b-0b2e-4385-a7c7-de9c75a0fee6/0a80461e', adoptedAt: '2026-09-15T04:48:42.206Z' },
    provenance: [{ kind: 'pre-app', authorSlug: 'anchor-physician' }],
    nodes: [['30a91b46', 'h2']],
  });
  const next = cleanForShipTransition()(raw);
  const { data } = matter(next);
  assert.equal(data.review.submitted, undefined);
  assert.equal(data.review.pr, undefined);
  assert.deepEqual(data.review.published, { at: '2026-02-03T00:00:00.000Z', pr: null, sha: 'abc123' });
  assert.equal(data.library, undefined);
  assert.equal(data.docId, '0a80461e');
  assert.deepEqual(data.provenance, [{ kind: 'pre-app', authorSlug: 'anchor-physician' }]);
  assert.deepEqual(data.nodes, [['30a91b46', 'h2']]);
  assert.equal(bodyOf(next), bodyOf(raw));   // body byte-identical
});

test('cleanForShipTransition preserves body-only and empty-block input', () => {
  const bodyOnly = 'Just body, no frontmatter.';
  const emptyBlock = '---\n---\nBody here.';
  assert.equal(cleanForShipTransition()(bodyOnly), bodyOnly);
  assert.equal(cleanForShipTransition()(emptyBlock), emptyBlock);
});

// Merge-back rewrites the desk copy from the cleaned corpus bytes (no library
// block), so the desk's own check-out stamp must be re-applied or the
// librarian resurrects the shelf mirror and the next submit ships under the
// adopter's own key (spec §2).
test('reapplyLibraryTransition re-stamps the library block; readLibraryBlock reads it', () => {
  const stamped = matter.stringify('Body text.', { docId: 'cb12af51', library: { key: 'w1/cb12af51', adoptedAt: '2026-09-08T09:00:00.000Z' } });
  assert.deepEqual(readLibraryBlock(stamped), { key: 'w1/cb12af51', adoptedAt: '2026-09-08T09:00:00.000Z' });
  assert.equal(readLibraryBlock('Body text with no frontmatter.'), null);
  assert.equal(readLibraryBlock(matter.stringify('Body.', { docId: 'x' })), null);
  const cleaned = matter.stringify('Body text.', { docId: 'cb12af51', review: { published: { at: 'x', pr: 11, sha: 's' } } });
  const restored = reapplyLibraryTransition(readLibraryBlock(stamped))(cleaned);
  assert.deepEqual(matter(restored).data.library, { key: 'w1/cb12af51', adoptedAt: '2026-09-08T09:00:00.000Z' });
  assert.deepEqual(matter(restored).data.review.published, { at: 'x', pr: 11, sha: 's' });
  assert.equal(matter(restored).content.trim(), 'Body text.');
  // no desk stamp → no-op (the original writer's own desk carries none)
  assert.equal(reapplyLibraryTransition(null)(cleaned), cleaned);
});

test('withMtimeCas writes atomically and round-trips a transition', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fm-'));
  const p = join(dir, 'doc.md');
  writeFileSync(p, DOC);
  withMtimeCas(p, (raw) => submittedClearedTransition()(raw));
  const after = readFileSync(p, 'utf-8');
  assert.equal(readDocHead(after).submittedAt, null);
  assert.equal(matter(after).data.docId, 'doc-abc');
});

test('withMtimeCas detects a mid-CAS mutation and does not write (MtimeRaceError)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fm-race-'));
  const p = join(dir, 'doc.md');
  writeFileSync(p, DOC);
  // simulate the app writing while the orchestrator is mid-CAS: the write
  // lands inside the fn — the read-to-write-back window the final mtime check
  // guards (deterministic; a timer callback could not fire inside a
  // synchronous fn anyway)
  assert.throws(
    () => withMtimeCas(p, (raw) => {
      writeFileSync(p, DOC + '\nextra\n');
      utimesSync(p, new Date(), new Date());
      return raw;
    }),
    (e) => e instanceof MtimeRaceError,
  );
  assert.match(readFileSync(p, 'utf-8'), /extra/);   // the app's write survived
});

const RAW = [
  '---',
  'docId: doc-1',
  'title: Hypertension Follow-up',
  'review:',
  '  submitted:',
  '    at: "2026-09-08T10:00:00.000Z"',
  '    sessionId: s1',
  '    model: glm-5.3-flash',
  '  pr:',
  '    at: "2026-09-08T10:01:00.000Z"',
  '    url: "https://gitea/pulls/3"',
  '    cycle: 1',
  '---',
  '',
  'Body v1.',
  '',
].join('\n');

test('prOpenedTransition stamps review.pr and keeps the body byte-exact', () => {
  const out = prOpenedTransition({ at: '2026-09-08T10:01:00.000Z', url: 'https://gitea/pulls/3', cycle: 1 })(RAW);
  const parsed = matter(out);
  assert.equal(parsed.content.trim(), 'Body v1.');                       // body survives
  assert.deepEqual(parsed.data.review.pr, { at: '2026-09-08T10:01:00.000Z', url: 'https://gitea/pulls/3', cycle: 1 });
  assert.ok(parsed.data.review.submitted, 'submitted stamp untouched');
});

test('returnedTransition clears submitted + pr, stamps returned', () => {
  const out = returnedTransition({ at: '2026-09-09T09:00:00.000Z', pr: 3 })(RAW);
  const parsed = matter(out);
  assert.equal(parsed.data.review.submitted, undefined);
  assert.equal(parsed.data.review.pr, undefined);
  assert.deepEqual(parsed.data.review.returned, { at: '2026-09-09T09:00:00.000Z', pr: 3 });
});

test('publishedTransition clears submitted, pr, and returned; stamps published', () => {
  const withReturned = RAW.replace('  pr:', '  returned:\n    at: "x"\n    pr: 3\n  pr:');
  const out = publishedTransition({ at: '2026-09-09T09:00:00.000Z', pr: 3, sha: 'abc' })(withReturned);
  const parsed = matter(out);
  assert.equal(parsed.data.review.submitted, undefined);
  assert.equal(parsed.data.review.pr, undefined);
  assert.equal(parsed.data.review.returned, undefined);
  assert.deepEqual(parsed.data.review.published, { at: '2026-09-09T09:00:00.000Z', pr: 3, sha: 'abc' });
});

test('transitions are no-ops on files without frontmatter', () => {
  const bare = 'no frontmatter here\n';
  assert.equal(prOpenedTransition({ at: 'x', url: 'u', cycle: 1 })(bare), bare);
  assert.equal(returnedTransition({ at: 'x', pr: 1 })(bare), bare);
});

