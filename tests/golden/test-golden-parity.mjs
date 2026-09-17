import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { markdownToTiptap } from '../../dist/server/markdown-parse.js';
import { tiptapToMarkdown } from '../../dist/server/markdown-serialize.js';
import { tiptapToBlocks } from '../../dist/server/node-blocks.js';
import { applyOverlay } from '../../dist/server/pending-overlay.js';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, 'fixtures', 'golden-contentops.md'), 'utf8');

const first = markdownToTiptap(md);
const round = markdownToTiptap(tiptapToMarkdown(first.document, first.title, first.metadata));

/** Collect block ids in pre-order, matching the serializer's traversal. */
function ids(parsed) {
  return tiptapToBlocks(parsed.document).map((block) => block.id);
}

function paragraph(id, text) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

/** Build real pending overlay entries against the parsed doc and return a
 *  stable classification shape. Pending state is not carried in canonical
 *  markdown (tiptapToMarkdown reverts it by design), so this reconstructs
 *  the overlay on both sides of the markdown round-trip via the real carried
 *  API — mirroring the sidecar reload path loadOverlay -> applyOverlay. */
function classifyPending(parsed) {
  const blocks = tiptapToBlocks(parsed.document);
  const existingNodeId = blocks.find((b) => b.type === 'paragraph')?.id;
  if (!existingNodeId) {
    throw new Error('fixture has no paragraph to anchor pending overlay');
  }

  // Real overlay entries: one stale-baseline rewrite on an existing block,
  // and one orphan rewrite whose anchor no longer exists. These exercise
  // both classification paths the pending-overlay module reports.
  const entries = [
    {
      nodeId: existingNodeId,
      status: 'rewrite',
      newContent: paragraph(existingNodeId, 'Proposed rewrite for outdoor workers.'),
      originalBaseline: paragraph(existingNodeId, 'Original baseline that differs from disk.'),
    },
    {
      nodeId: 'pending-orphan-0001',
      status: 'rewrite',
      newContent: paragraph('pending-orphan-0001', 'Orphaned proposed addition.'),
      originalBaseline: paragraph('pending-orphan-0001', 'Orphan baseline.'),
    },
  ];

  const result = applyOverlay(parsed.document, entries);
  return {
    orphans: result.orphans.map((entry) => ({ nodeId: entry.nodeId, status: entry.status })),
    staleBaseline: result.staleBaseline.map((entry) => ({ nodeId: entry.nodeId, status: entry.status })),
  };
}

const ids1 = ids(first);
const ids2 = ids(round);
if (JSON.stringify(ids1) !== JSON.stringify(ids2)) {
  console.error('FAIL: node ids not stable across markdown round-trip');
  console.error('  first:', JSON.stringify(ids1));
  console.error('  round:', JSON.stringify(ids2));
  process.exit(1);
}

const cls1 = JSON.stringify(classifyPending(first));
const cls2 = JSON.stringify(classifyPending(round));
if (cls1 !== cls2) {
  console.error('FAIL: pending classification not stable across markdown round-trip');
  console.error('  first:', cls1);
  console.error('  round:', cls2);
  process.exit(1);
}

if (cls1 === JSON.stringify({ orphans: [], staleBaseline: [] })) {
  console.error('FAIL: classification assertion is vacuous — no overlay entries were produced');
  process.exit(1);
}

console.log('test-golden-parity: PASS');
