// Spike A stub backend: adapter for the writer-app seam smoke test.
// Wraps the fork's boot/api helpers with the `spawnServer` / `drive` contract
// expected by test-seam-smoke.mjs. HTTP/WS behavior against the lifted server.
import { bootApp, shutdown, api, openWs } from './lib/spike.mjs';

export async function spawnServer({ port, bearer }) {
  const inst = await bootApp({ port, bearer });
  return {
    ...inst,
    shutdown: () => shutdown(inst),
  };
}

export const drive = {
  async createDocument(title, content) {
    const inst = this.__inst;
    // Treat a `*.md` argument as a filename hint; strip the extension so the
    // server's title-based filename becomes the intended `*.md`.
    const cleanTitle = title.replace(/\.md$/i, '');
    const created = await (await api(inst, 'POST', '/api/documents', { title: cleanTitle, content })).json();
    const docs = await (await api(inst, 'GET', '/api/documents')).json();
    const doc = docs.find((d) => d.filename === created.filename);
    if (!doc || !doc.docId) throw new Error(`createDocument: no docId for ${created.filename}: ${JSON.stringify(doc).slice(0, 200)}`);
    return { docId: doc.docId, filename: doc.filename };
  },

  async writeToPad(docId, changes) {
    const inst = this.__inst;
    const mapped = changes.map((c) => {
      if (c.op === 'insert') return { operation: 'insert', afterNodeId: 'end', content: c.text };
      throw new Error(`writeToPad: unsupported op ${c.op}`);
    });
    const res = await api(inst, 'POST', '/api/mcp-call', { tool: 'write_to_pad', arguments: { docId, changes: mapped } });
    if (!res.ok) throw new Error(`writeToPad: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async pendingEntries(docId) {
    const inst = this.__inst;
    const res = await api(inst, 'GET', `/api/pending-entries?docId=${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error(`pendingEntries: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async resolveEntry(docId, nodeId, action) {
    const inst = this.__inst;
    const res = await api(inst, 'POST', '/api/documents/resolve-entry', { docId, nodeId, action });
    if (!res.ok) throw new Error(`resolveEntry: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async quiesce(ms) {
    const inst = this.__inst;
    const res = await api(inst, 'POST', '/api/quiesce', { ms });
    if (!res.ok) throw new Error(`quiesce: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async unquiesce() {
    const inst = this.__inst;
    const res = await api(inst, 'POST', '/api/unquiesce');
    if (!res.ok) throw new Error(`unquiesce: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async listCommits(docId) {
    const inst = this.__inst;
    const res = await api(inst, 'GET', `/api/commits/${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error(`listCommits: ${res.status} ${await res.text()}`);
    return res.json();
  },

  async commit(docId, note) {
    const inst = this.__inst;
    const res = await api(inst, 'POST', '/api/commit', { docId, note });
    if (!res.ok) throw new Error(`commit: ${res.status} ${await res.text()}`);
    return res.json();
  },

  bind(inst) {
    this.__inst = inst;
    return this;
  },
};
