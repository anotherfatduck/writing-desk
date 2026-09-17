// tests/regression/test-auto-clean-target.mjs — auto-clean keys off the TARGET
// doc, never the active doc. Regression: proposing an insert to a doc while a
// FRESH single-empty-paragraph doc is active converted the insert into a
// rewrite of the ACTIVE doc's node id — absent in the target → appliedCount 0,
// success false, change silently dropped.
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

const HOME = join(tmpdir(), `auto-clean-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');
const mcpMod = await import('../../dist/server/mcp.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

state.load();
// Create the content-bearing TARGET first, then a fresh empty doc —
// createDocument activates each new doc (probe-verified, see
// test-review-overlay-push.mjs §2 comment), so the ACTIVE doc at propose time
// is the fresh empty one and the TARGET is the content doc. createDocument
// returns no docId; read it from the doc file's frontmatter (the §2 pattern).
const contentCreated = documents.createDocument('Content Doc', 'One paragraph.\n\nTwo paragraph.\n');
const contentDocId = matter(readFileSync(join(HOME, 'profiles', 'Default', contentCreated.filename), 'utf-8')).data.docId;
documents.createDocument('Empty Doc');

const wtp = mcpMod.TOOL_REGISTRY.find((t) => t.name === 'write_to_pad');
const result = JSON.parse((await wtp.handler({
  changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Seeded into the content doc.' }],
  docId: contentDocId,
})).content[0].text);

assert(result.success === true && result.appliedCount === 1, `insert to non-active content doc applies while fresh empty doc is active (got ${JSON.stringify(result)})`);

console.log(failed ? `auto-clean-target: ${failed} FAIL(s)` : 'auto-clean-target: PASS');
process.exit(failed ? 1 : 0);
