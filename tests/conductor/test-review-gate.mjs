// M4c: gate-state derivation from fixture frontmatter (the spec's app test),
// findings-note reader, and a fresh submit — the writer's Review-tab seam
// (reviewAfterFreshSubmit, the seam /api/review-gate/submit runs) — clears
// returned/published/conflict.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

const HOME = join(tmpdir(), `m4c-gate-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const { deriveReviewGate, readReviewNote, reviewAfterFreshSubmit } = await import('../../dist/server/review-gate.js');
const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

// (1) deriveReviewGate from fixture frontmatter — every state the spec's
// banner table defines, plus the precedence rules (terminal states first).
const reviews = {
  submitted: { submitted: { at: '2026-09-08T10:00:00.000Z', sessionId: 's1', model: 'm' } },
  inReview: { submitted: { at: '2026-09-08T10:00:00.000Z' }, pr: { at: '2026-09-08T10:01:00.000Z', url: 'https://gitea/pulls/3', cycle: 1 } },
  published: { published: { at: '2026-09-09T09:00:00.000Z', pr: 3, sha: 'abc' } },
  returned: { returned: { at: '2026-09-09T09:00:00.000Z', pr: 3 } },
  publishedReturn: { published: { at: '2026-09-09T08:00:00.000Z', pr: 2, sha: 'old' }, returned: { at: '2026-09-09T09:30:00.000Z', pr: 3 } },
  publishedInReview: { published: { at: '2026-09-09T08:00:00.000Z', pr: 2, sha: 'old' }, pr: { at: '2026-09-09T09:30:00.000Z', url: 'https://gitea/pulls/4', cycle: 2 } },
  // Update round: the writer re-submitted after publication (the submit paths
  // now clear published, but the window between stamp and ship can coexist).
  publishedSubmitted: { published: { at: '2026-09-09T08:00:00.000Z', pr: 2, sha: 'old' }, submitted: { at: '2026-09-10T10:00:00.000Z', sessionId: 's2', model: 'm' } },
  conflict: { conflict: { at: '2026-09-11T09:00:00.000Z', pr: 7 } },
  conflictOverStalePr: { conflict: { at: '2026-09-11T09:00:00.000Z', pr: 7 }, pr: { at: '2026-09-08T10:01:00.000Z', url: 'https://gitea/pulls/3', cycle: 1 } },
};
assert(JSON.stringify(deriveReviewGate(reviews.submitted)) === JSON.stringify({ phase: 'submitted', since: '2026-09-08T10:00:00.000Z' }), 'deriveReviewGate: submitted');
assert(JSON.stringify(deriveReviewGate(reviews.inReview)) === JSON.stringify({ phase: 'in-review', since: '2026-09-08T10:01:00.000Z' }), 'deriveReviewGate: in-review (pr wins over bare submitted)');
assert(JSON.stringify(deriveReviewGate(reviews.published)) === JSON.stringify({ phase: 'published', since: '2026-09-09T09:00:00.000Z' }), 'deriveReviewGate: published');
assert(JSON.stringify(deriveReviewGate(reviews.returned)) === JSON.stringify({ phase: 'returned', since: '2026-09-09T09:00:00.000Z' }), 'deriveReviewGate: returned');
assert(JSON.stringify(deriveReviewGate(reviews.publishedReturn)) === JSON.stringify({ phase: 'returned', since: '2026-09-09T09:30:00.000Z' }), 'deriveReviewGate: returned wins over coexisting published (revision-return path)');
assert(JSON.stringify(deriveReviewGate(reviews.publishedInReview)) === JSON.stringify({ phase: 'in-review', since: '2026-09-09T09:30:00.000Z' }), 'deriveReviewGate: in-review wins over coexisting published (revision-cycle banner)');
assert(JSON.stringify(deriveReviewGate(reviews.publishedSubmitted)) === JSON.stringify({ phase: 'submitted', since: '2026-09-10T10:00:00.000Z' }), 'deriveReviewGate: submitted wins over coexisting published (update-round submit window)');
assert(JSON.stringify(deriveReviewGate(reviews.conflict)) === JSON.stringify({ phase: 'conflict', since: '2026-09-11T09:00:00.000Z' }), 'deriveReviewGate: conflict');
assert(JSON.stringify(deriveReviewGate(reviews.conflictOverStalePr)) === JSON.stringify({ phase: 'conflict', since: '2026-09-11T09:00:00.000Z' }), 'deriveReviewGate: conflict wins over a stale coexisting pr');
assert(deriveReviewGate(undefined) === null, 'deriveReviewGate: draft → null (no banner)');
assert(deriveReviewGate({}) === null, 'deriveReviewGate: empty review → null');

// (2) readReviewNote: null when absent, content when present (pure fs read).
const notePath = join(HOME, 'note-target.md');
writeFileSync(notePath, '---\ndocId: n1\n---\n\nBody.\n');
assert(readReviewNote(notePath, 'returned') === null, 'readReviewNote: null when no note file (returned phase)');
writeFileSync(`${notePath}.submit-rejected.txt`, 'submit-rejected: findings here\n');
assert(readReviewNote(notePath, 'returned') === 'submit-rejected: findings here\n', 'readReviewNote: returned reads the submit-rejected sibling');
writeFileSync(`${notePath}.merge-conflict.txt`, 'merge-conflict: recovery note\n');
assert(readReviewNote(notePath, 'conflict') === 'merge-conflict: recovery note\n', 'readReviewNote: conflict reads the merge-conflict sibling');
assert(readReviewNote(notePath, 'published') === null, 'readReviewNote: published shows no note');
assert(readReviewNote(notePath, null) === null, 'readReviewNote: no gate → no note');

// (3) A fresh submit clears review.returned and stamps review.submitted —
// through the exact seam /api/review-gate/submit runs (reviewAfterFreshSubmit
// applied via setMetadata + save, server/index.ts:207).
state.load();
documents.createDocument('Gate Doc', 'article');
state.setMetadata({ review: { returned: { at: '2026-09-09T09:00:00.000Z', pr: 3 } } });
state.save('agent');
const meta = state.getMetadata();
state.setMetadata({ review: reviewAfterFreshSubmit(meta?.review, { at: 'NOW', sessionId: 'user', model: 'user' }) });
state.save('user');
const review = (matter(readFileSync(state.getFilePath(), 'utf-8')).data.review ?? {});
assert(review.submitted && typeof review.submitted.at === 'string', 'review.submitted stamped');
assert(review.returned === undefined, 'review.returned cleared by the fresh submit');

// (4) Update round: a fresh submit clears review.published too — the banner
// leaves "In the library" the moment the writer re-submits.
documents.createDocument('Gate Doc 2', 'article');
state.setMetadata({ review: { published: { at: '2026-09-09T08:00:00.000Z', pr: 2, sha: 'old' } } });
state.save('agent');
const meta2 = state.getMetadata();
state.setMetadata({ review: reviewAfterFreshSubmit(meta2?.review, { at: 'NOW', sessionId: 'user', model: 'user' }) });
state.save('user');
const review2 = (matter(readFileSync(state.getFilePath(), 'utf-8')).data.review ?? {});
assert(review2.submitted && typeof review2.submitted.at === 'string', 'update round: review.submitted stamped');
assert(review2.published === undefined, 'update round: review.published cleared by the fresh submit');

// (5) reviewAfterFreshSubmit: the shared clear-set for the human submit path —
// returned/published/conflict go, everything else stays, submitted stamped.
const mixed = { returned: { at: 'x' }, published: { at: 'y' }, conflict: { at: 'z', pr: 1 }, customKey: 42 };
const out = reviewAfterFreshSubmit(mixed, { at: 'NOW', sessionId: 's', model: 'm' });
assert(out.returned === undefined && out.published === undefined && out.conflict === undefined, 'reviewAfterFreshSubmit: clears returned, published, conflict');
assert(out.customKey === 42 && out.submitted.at === 'NOW', 'reviewAfterFreshSubmit: keeps other keys, stamps submitted');
assert(reviewAfterFreshSubmit(undefined, { at: 'NOW', sessionId: 's', model: 'm' }).submitted.at === 'NOW', 'reviewAfterFreshSubmit: null existing → bare stamp');

// (6) Conflict recovery: a fresh submit clears review.conflict.
documents.createDocument('Gate Doc 3', 'article');
state.setMetadata({ review: { conflict: { at: '2026-09-11T09:00:00.000Z', pr: 7 } } });
state.save('agent');
const meta3 = state.getMetadata();
state.setMetadata({ review: reviewAfterFreshSubmit(meta3?.review, { at: 'NOW', sessionId: 'user', model: 'user' }) });
state.save('user');
const review3 = (matter(readFileSync(state.getFilePath(), 'utf-8')).data.review ?? {});
assert(review3.submitted && typeof review3.submitted.at === 'string', 'conflict recovery: review.submitted stamped');
assert(review3.conflict === undefined, 'conflict recovery: review.conflict cleared by the fresh submit');

rmSync(HOME, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
