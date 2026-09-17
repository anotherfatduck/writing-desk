// tests/conductor/test-submit-gate.mjs — the chat structurally cannot commit or publish.
// Exhaustive negatives over the conductor tool surface, its import closure, and
// the built REST route tree. Runs in-process against the real built app server.
import { createServer } from 'node:net';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, shutdown, api } from '../spike-a/lib/spike.mjs';
import matter from 'gray-matter';

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`);
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// Hoisted so the self-test below exercises the exact regex the closure scan
// uses. Second alternative catches dynamic imports: import('…') / require('…').
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

// Self-test: the scan must catch BOTH import forms. Without the second
// alternative, a `import('child_process')` in the closure would sail through.
{
  const sample = [
    "import path from 'path';",
    "export { x } from './y.js';",
    "const cp = import('child_process');",
    "const fs = require('node:fs');",
  ].join('\n');
  const specs = [...sample.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
  assert(specs.includes('child_process'), 'scan catches dynamic import() tokens');
  assert(specs.includes('node:fs'), 'scan catches require() tokens');
  assert(specs.includes('path') && specs.includes('./y.js'), 'scan still catches static import/export forms');
}

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function getJson(res) {
  return res.json().catch(() => ({}));
}

async function createDoc(app, title, content) {
  const res = await api(app, 'POST', '/api/documents', { title, content });
  const j = await getJson(res);
  const active = await getJson(await api(app, 'GET', '/api/document'));
  return { ...j, docId: active.metadata?.docId, filename: active.metadata?.title ? `${active.metadata.title}.md` : `${title}.md` };
}

function docFilePath(home, filename) {
  return join(home, 'profiles', 'Default', filename);
}

function sidecarPath(home, docId) {
  return join(home, 'profiles', 'Default', '_pending', `${docId}.json`);
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_DIR = resolve(THIS_DIR, '..', '..', 'dist', 'server');

function followRelativeImports(entryPaths) {
  const reached = new Set();
  const stack = [...entryPaths];
  while (stack.length) {
    const current = stack.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    if (!existsSync(current)) continue;
    const src = readFileSync(current, 'utf-8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.') || spec.startsWith('/')) continue;
      const resolved = resolve(dirname(current), spec);
      // If the literal specifier omitted .js, prefer the existing .js sibling.
      const candidates = [resolved, `${resolved}.js`];
      for (const c of candidates) {
        if (existsSync(c) && !reached.has(c)) {
          stack.push(c);
          break;
        }
      }
    }
  }
  return Array.from(reached);
}

async function main() {
  const app = await bootApp({ port: await freePort() });

  // Create a real document through the REST surface so ctx.docId is bound to a
  // loaded, on-disk document that the in-process tool imports can resolve.
  const doc = await createDoc(app, 'Submit Gate Doc', 'article\n\nHello world.\n\n');
  const docId = doc.docId;
  const filename = doc.filename;
  const docPath = docFilePath(app.home, filename);
  const initialBytes = readFileSync(docPath);

  // Load the server modules against the same isolated home the app child is using.
  // Static imports must NOT happen before this point — helpers.ts fixes ROOT_DIR
  // at import time from process.env.OW_HOME.
  process.env.OW_HOME = app.home;
  const stateMod = await import('../../dist/server/state.js');
  stateMod.load();
  const toolsMod = await import('../../dist/server/conductor-tools.js');
  const { CONDUCTOR_TOOL_NAMES, CONDUCTOR_TOOLS, CONDUCTOR_TOOL_MAP } = toolsMod;

  const ctx = { sessionId: 'gate-session', docId };

  // ============================================================================
  // 1. Surface: exactly the three conductor tools — no submit, ever.
  // ============================================================================
  {
    const expected = new Set(['read_document', 'read_workspace', 'propose_edits']);
    const actual = new Set(CONDUCTOR_TOOL_NAMES);
    assert(actual.size === 3, 'CONDUCTOR_TOOL_NAMES has three distinct names');
    assert(
      expected.size === actual.size && [...expected].every((n) => actual.has(n)),
      `CONDUCTOR_TOOL_NAMES matches the three allowed tools (${CONDUCTOR_TOOL_NAMES.join(', ')})`,
    );
    assert(!CONDUCTOR_TOOL_MAP.submit_for_review, 'no submit_for_review tool on the conductor surface');
  }

  // ============================================================================
  // 2. Import-closure audit: no git/shell imports reachable from conductor files.
  // ============================================================================
  {
    const entries = [
      resolve(DIST_SERVER_DIR, 'conductor.js'),
      resolve(DIST_SERVER_DIR, 'conductor-tools.js'),
      resolve(DIST_SERVER_DIR, 'chat-sessions.js'),
      resolve(DIST_SERVER_DIR, 'chat-routes.js'),
    ];
    const reached = followRelativeImports(entries);
    const childProcessRe = /['"](?:node:)?child_process['"]/;
    const gitRe = /from\s+['"]isomorphic-git['"]|require\s*\(\s*['"]simple-git['"]\s*\)|nodegit/;
    const bad = [];
    for (const p of reached) {
      const src = readFileSync(p, 'utf-8');
      if (childProcessRe.test(src)) bad.push(`${p}: child_process import token`);
      if (gitRe.test(src)) bad.push(`${p}: git import token`);
    }
    assert(bad.length === 0, `conductor import closure contains no git/shell imports (${bad.join('; ') || 'none'})`);
  }

  // ============================================================================
  // 3. Path-traversal resistance: extra target/path args are stripped; tool stays
  //    bound to the session doc.
  // ============================================================================
  {
    const traversalArgs = {
      target: '../../etc/passwd',
      path: '....//....//etc',
    };

    const readRes = await CONDUCTOR_TOOL_MAP.read_document.execute(traversalArgs, ctx);
    assert(Array.isArray(readRes.content) && readRes.content.length === 1, 'read_document returns single text content');
    const readJson = JSON.parse(readRes.content[0].text);
    assert(readJson.docId === docId, `read_document operates on session doc (${readJson.docId})`);
    assert(!readJson.markdown.includes('/etc/passwd'), 'read_document markdown does not leak traversal path');

    const proposeRes = await CONDUCTOR_TOOL_MAP.propose_edits.execute({
      changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Traversal-resistant proposal.' }],
      ...traversalArgs,
    }, ctx);
    assert(Array.isArray(proposeRes.content) && proposeRes.content.length === 1, 'propose_edits returns single text content');
    const proposeJson = JSON.parse(proposeRes.content[0].text);
    assert(proposeJson.success === true && proposeJson.appliedCount === 1, `propose_edits applies exactly one insert (appliedCount=${proposeJson.appliedCount})`);

    // Canonical file must not have been touched.
    const bytesAfterPropose = readFileSync(docPath);
    assert(Buffer.compare(initialBytes, bytesAfterPropose) === 0, 'canonical bytes unchanged after propose_edits');

    // Sidecar for the session doc must hold the pending entry.
    const scPath = sidecarPath(app.home, docId);
    assert(existsSync(scPath), `session-doc sidecar exists at ${scPath}`);
    const sidecar = JSON.parse(readFileSync(scPath, 'utf-8'));
    assert(Array.isArray(sidecar.entries) && sidecar.entries.length === 1, `sidecar has one pending entry (${sidecar.entries?.length})`);
    const entry = sidecar.entries[0];
    assert(entry.nodeId && typeof entry.nodeId === 'string', 'pending entry has nodeId');
    assert(entry.status === 'insert', `pending entry status is insert (${entry.status})`);
    assert(entry.newContent != null, 'pending insert entry carries newContent');
  }

  // ============================================================================
  // 4. Tool outputs are text-only with no extra keys.
  // ============================================================================
  {
    for (const tool of CONDUCTOR_TOOLS) {
      let args;
      if (tool.name === 'propose_edits') {
        args = { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Text-only output probe.' }] };
      } else {
        args = {};
      }
      const res = await tool.execute(args, ctx);
      assert(Array.isArray(res.content), `${tool.name}: result has content array`);
      assert(res.content.every((c) => c.type === 'text' && typeof c.text === 'string'), `${tool.name}: every content item is text`);
      const allowedKeys = ['content', 'terminal'];
      const extra = Object.keys(res).filter((k) => !allowedKeys.includes(k));
      assert(extra.length === 0, `${tool.name}: result has no extra keys (${extra.join(', ')})`);
    }
  }

  // ============================================================================
  // 5. REST surface exposes no submit/commit/publish route strings.
  // ============================================================================
  // Walk the entire dist/server tree recursively — the gate must hold even if
  // future builds move route modules into subdirectories.
  {
    const forbidden = ["/api/submit'", '/api/submit"', "/api/publish'", '/api/publish"', "/api/git'", '/api/git"'];
    const hits = [];
    const allFiles = readdirSync(DIST_SERVER_DIR, { recursive: true })
      .filter((n) => n.endsWith('.js'))
      .map((n) => join(DIST_SERVER_DIR, n));
    for (const p of allFiles) {
      const src = readFileSync(p, 'utf-8');
      for (const token of forbidden) {
        if (src.includes(token)) hits.push(`${p}: ${token}`);
      }
    }
    assert(hits.length === 0, `dist/server contains no submit/publish/git route strings (${hits.join('; ') || 'none'})`);
  }

  // ============================================================================
  // 6. Writes are sidecar-identical: canonical unchanged, entry shape matches
  //    the write_to_pad result model.
  // ============================================================================
  {
    const scPath = sidecarPath(app.home, docId);
    const sidecar = JSON.parse(readFileSync(scPath, 'utf-8'));
    const entry = sidecar.entries?.[0];
    assert(entry != null, 'sidecar-identical check has a pending entry to inspect');
    const required = ['nodeId', 'status'];
    if (entry.status === 'insert') required.push('newContent');
    if (entry.status === 'rewrite') required.push('newContent', 'originalBaseline');
    if (entry.status === 'delete') required.push('originalBaseline');
    const missing = required.filter((k) => !(k in entry));
    assert(missing.length === 0, `sidecar entry has write_to_pad keys (${missing.join(', ') || 'all present'})`);

    const bytesNow = readFileSync(docPath);
    assert(Buffer.compare(initialBytes, bytesNow) === 0, 'canonical bytes unchanged at gate end');
  }

  // submit_for_review is gone from the surface — the absence negative lives in
  // section 1; the unknown-tool loop path is pinned in test-conductor-loop 13.

  // ============================================================================
  // 7. The HUMAN submit route keeps the writer-initiated submit semantics:
  //    POST /api/review-gate/submit stamps review.submitted (sessionId 'user').
  // ============================================================================
  {
    const submitRes = await api(app, 'POST', '/api/review-gate/submit', {});
    assert(submitRes.status === 200, `human submit route returns 200 (got ${submitRes.status})`);
    const stamped = matter(readFileSync(docPath, 'utf-8')).data;
    assert(!!stamped.review?.submitted, 'human submit stamped review.submitted');
    assert(stamped.review?.submitted?.sessionId === 'user', 'human submit stamps sessionId "user", not the agent');
  }

  await shutdown(app);

  console.log(failed ? `submit-gate: ${failed} FAIL(s)` : 'submit-gate: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('submit-gate: unexpected error', err);
  process.exit(1);
});
