/**
 * Express HTTP server: serves built React app and WebSocket.
 * MCP stdio transport is started separately in bin/server.ts for fast startup.
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { setupWebSocket, broadcastAgentStatus, broadcastDocumentSwitched, broadcastDocumentsChanged, broadcastWorkspacesChanged, broadcastMetadataChanged, broadcastPendingDocsChanged, broadcastSyncStatus, broadcastWritingStarted, broadcastWritingFinished, broadcastCommentsChanged, broadcastLibraryChanged } from './ws.js';
import { initLogger, logger, generateRequestId, withRequestId } from './logger.js';
import { TOOL_REGISTRY } from './mcp.js';
import { z } from 'zod';
import { save, cancelDebouncedSave, load, getDocument, getTitle, getFilePath, getDocId, getDocVersion, getMetadata, getStatus, updateDocument, setMetadata, applyTextEdits, isAgentLocked, getPendingDocInfo, getOverlayEntries, getDocTagsByFilename, addDocTag, removeDocTag, markAllNodesAsPending, updatePendingCacheForActiveDoc, removePendingCacheEntry, clearAllCaches, stripPendingAttrs, stripPendingAttrsFromFile, setAutoAcceptOnFile, bumpDocVersion, markAsAgentStub, extractText, quiesce, unquiesce, isQuiesced } from './state.js';
import { listDocuments, switchDocument, createDocument, deleteDocument, duplicateDocument, createVariant, reloadDocument, updateDocumentTitle, openFile, reorderDocs, searchDocuments, listArchivedDocuments, archiveDocument, unarchiveDocument, getActiveFilename, resolveDocId, batchResolve, resolveOverlayEntry, listLibraryDocs, readLibraryDoc, adoptLibraryDoc, restoreLibraryDoc } from './documents.js';
import { markdownToTiptap } from './markdown.js';
import { readStore, loadMasterKey, resolveRuntimeDir, resolveStoreFile, DEFAULT_SITE_NAME } from '../shared/store.js';
import matter from 'gray-matter';
import { loadOverlay } from './pending-overlay.js';
import { removeDocFromAllWorkspaces } from './workspaces.js';
import { resolveDocPath, getActiveProfile, setActiveProfile, listProfiles, createProfile, deleteProfile, listTrashedProfiles, restoreProfile, saveConfig, readConfig } from './helpers.js';
import { resolveListenHost } from './deploy-env.js';
import { isAllowedHost, isAllowedOrigin, shouldTrustProxy } from './site-gate.js';
import { createVersionRouter } from './version-routes.js';
import { createChatRouter } from './chat-routes.js';
import { broadcastChatProgress } from './ws.js';
import { deriveReviewGate, readReviewNote, reviewAfterFreshSubmit } from './review-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Runtime port the HTTP server is actually listening on. Set inside
// startHttpServer once the port is resolved; read by tools that need to
// construct absolute URLs (e.g. get_doc_link). Defaults to 5050 if read
// before the server has booted — matches the default option.
let runtimePort = 5050;
export function getRuntimePort(): number { return runtimePort; }
export function getBaseUrl(): string { return `http://localhost:${runtimePort}`; }

// ---- Trust boundary (anti-DNS-rebinding + CSRF) — MCP-5 ----
// The HTTP API binds to loopback, but "localhost" is not a trust boundary
// by itself: with no Host/Origin validation a remote page can rebind a
// hostname to 127.0.0.1 and drive any mutating route. The Host/Origin
// middleware below validates every request. adr: see MCP-5.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global security gate, applied before any route or body parsing.
 *  (a) Host allowlist — the anti-DNS-rebinding control.
 *  (b) Origin/Referer same-origin check on state-changing methods (CSRF).
 *      Browsers always send Origin on cross-origin POST, so a rebound page is
 *      rejected here too. A *missing* Origin is allowed only for state-changing
 *      requests from non-browser local clients (the client-mode MCP-over-HTTP
 *      proxy uses curl-style requests with no Origin); the Host gate still
 *      bounds those to loopback.
 *  (c) Restrictive security headers on every response.
 */
function securityGate(port: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join('; '),
    );

    // Bearer gate: env-token required for all routes except the health probe.
    // Unset = disabled. The /api/status checkPort probe stays exempt so health
    // checks keep working.
    const bearer = process.env.OW_BEARER_TOKEN;
    if (bearer && req.path !== '/api/status') {
      if (req.headers.authorization !== `Bearer ${bearer}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    if (!isAllowedHost(req.headers.host, port)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (STATE_CHANGING.has(req.method)) {
      const origin = req.headers.origin;
      const referer = req.headers.referer;
      if (origin) {
        if (!isAllowedOrigin(origin, port)) { res.status(403).json({ error: 'Forbidden' }); return; }
      } else if (referer) {
        if (!isAllowedOrigin(referer, port)) { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      // No Origin and no Referer: non-browser local client; Host gate above
      // already constrained it to loopback. Allow.
    }

    next();
  };
}

export async function startHttpServer(options: { port?: number; noOpen?: boolean } = {}): Promise<void> {
  const port = options.port || 5050;
  runtimePort = port;
  const listenHost = resolveListenHost();

  initLogger();

  const app = express();
  // Behind the org reverse proxy (site URL set): trust only loopback proxies so
  // req.protocol reflects X-Forwarded-Proto. Dev: unset, unchanged.
  if (shouldTrustProxy()) app.set('trust proxy', 'loopback');
  // Trust boundary FIRST — reject cross-host / cross-origin before body
  // parsing or any route handler runs. Covers every route, including the
  // unauth state-changers /api/profiles/switch, /api/plugins/enable,
  // /api/plugins/config, and the universal /api/mcp-call dispatcher. MCP-5.
  app.use(securityGate(port));
  app.use(express.json({ limit: '10mb' }));

  // API routes for direct HTTP access (fallback if WS not available)
  app.get('/api/status', (_req, res) => {
    res.json(getStatus());
  });

  // MCP tool metadata: lets client-mode proxies discover tools without importing mcp.js
  app.post('/api/mcp-call', async (req, res) => {
    const { tool: toolName, arguments: args } = req.body;
    // Wrap the call in a request ID scope so every event logged during
    // this tool invocation correlates. adr: adr/logging-system.md
    const reqId = generateRequestId(`mcp-http-${toolName || 'unknown'}`);
    await withRequestId(reqId, async () => {
      try {
        const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
        if (!tool) {
          res.status(404).json({ error: `Unknown tool: ${toolName}` });
          return;
        }
        // Validate arguments against the tool's Zod schema (mirrors McpServer.validateToolInput)
        const schema = z.object(tool.schema);
        const parsed = schema.safeParse(args || {});
        if (!parsed.success) {
          res.status(400).json({ content: [{ type: 'text' as const, text: `Validation error: ${parsed.error.message}` }] });
          return;
        }
        logger.debug('mcp', 'tool-call-http', tool.name, { tool: tool.name });
        const result = await tool.handler(parsed.data);
        res.json(result);
      } catch (err: any) {
        logger.error('mcp', 'tool-error-http', `${toolName}: ${err.message}`, { tool: toolName }, err);
        res.status(500).json({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
      }
    });
  });

  app.get('/api/document', (_req, res) => {
    res.json({ document: getDocument(), title: getTitle(), metadata: getMetadata() });
  });

  // Human-only metadata writes (the MCP surface forbids the agent these keys —
  // MCP-9). Today: the auto-accept toggle; merge-only semantics.
  app.put('/api/document/metadata', (req, res) => {
    try {
      setMetadata(req.body ?? {});
      broadcastDocumentsChanged();
      res.json({ metadata: getMetadata() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/review-gate', (_req, res) => {
    // The gate is derived from the doc FILE, not the in-memory metadata
    // cache: the orchestrator stamps review.* out-of-band, and any missed
    // watch event (dir watch now, but a miss still costs nothing to guard)
    // would otherwise leave the banner on a stale phase until some app-side
    // write refreshed the cache (UAT 2026-09-11). Same fallthrough on any
    // read error — a cached gate beats a 500 on a transient fs hiccup.
    let review: Record<string, any> | null = null;
    try {
      const { data } = matter(readFileSync(getFilePath(), 'utf-8'), {});
      review = (data as any)?.review ?? null;
    } catch { /* fall back to the cache below */ }
    const metadata = getMetadata();
    const source = review ?? (metadata as any)?.review;
    const gate = deriveReviewGate(source);
    res.json({ gate, note: readReviewNote(getFilePath(), gate?.phase ?? null) });
  });

  // Human submit (Review tab button) — the only writer of the
  // review.submitted stamp (submission is writer-initiated); the orchestrator's
  // next poll picks the doc up from disk and files the review copy + PR.
  app.post('/api/review-gate/submit', (_req, res) => {
    try {
      const metadata = getMetadata();
      if ((metadata as any)?.review?.submitted) {
        return res.status(409).json({ error: 'Already submitted for review.' });
      }
      setMetadata({ review: reviewAfterFreshSubmit((metadata as any)?.review, { at: new Date().toISOString(), sessionId: 'user', model: 'user' }) });
      save('agent');
      broadcastMetadataChanged(getMetadata());
      // The docs list carries reviewGate per doc (sidebar lifecycle chips) —
      // without this broadcast the chip trails the banner until some other
      // event refetches the list.
      broadcastDocumentsChanged();
      res.json({ gate: deriveReviewGate((getMetadata() as any)?.review) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pending-docs', (_req, res) => {
    res.json(getPendingDocInfo());
  });

  // Full overlay payload — seam #6. No docId param = active doc (pattern:
  // /api/pending-docs above). ?docId=<id> = that doc's overlay — the CALLER
  // supplies docId, matching seam #7's resolveOverlayEntry(docId, ...) signature.
  // The non-active read happens inside the server (loadOverlay on the sidecar) —
  // the backend reads overlay via this API, never by scraping sidecar files
  // (spec line 95). Spike patch #6 — the read seam for the orchestrator/review UI.
  app.get('/api/pending-entries', (req, res) => {
    const requested = typeof req.query.docId === 'string' && req.query.docId ? req.query.docId : undefined;
    if (!requested || requested === getDocId()) {
      res.json({ docId: getDocId(), filename: getActiveFilename(), version: getDocVersion(), entries: getOverlayEntries() });
      return;
    }
    // Validate docId format before any filesystem lookup. Real docIds are 8-char hex
    // (randomUUID().replace(/-/g,'').slice(0,8)); reject anything else at the seam.
    if (!/^[a-f0-9]{8}$/i.test(requested)) {
      res.status(404).json({ error: `no such docId: ${requested}` });
      return;
    }
    let filename: string;
    try { filename = resolveDocId(requested); } catch { res.status(404).json({ error: `no such docId: ${requested}` }); return; }
    res.json({ docId: requested, filename, version: null, entries: loadOverlay(requested) });
  });

  app.post('/api/save', (_req, res) => {
    try {
      save();
      res.json({ success: true });
    } catch (err: any) {
      // Library read-only refusal (assertWritableDocPath, status 400) surfaces
      // as a 4xx with its message; genuine failures keep the 500 they had.
      res.status(err?.status ?? 500).json({ error: err?.message ?? 'save failed' });
    }
  });

  // Beacon-based flush: browser sends this on beforeunload/visibilitychange
  // Client sends as application/json Blob (non-CORS-safelisted, so cross-origin sendBeacon is blocked)
  app.post('/api/flush', (req, res) => {
    try {
      if (isAgentLocked(getActiveFilename())) {
        console.log('[Flush] Blocked (agent write lock active)');
        res.status(204).end();
        return;
      }
      const msg = req.body;
      if (msg.document) {
        updateDocument(msg.document);
        save();
      } else if (msg.markdown) {
        const parsed = markdownToTiptap(msg.markdown);
        updateDocument(parsed.document);
        if (parsed.title !== 'Untitled') setMetadata({ title: parsed.title });
        save();
      }
      res.status(204).end();
    } catch {
      res.status(400).end();
    }
  });

  // Document CRUD routes
  app.get('/api/documents', (_req, res) => {
    res.json(listDocuments());
  });

  // Author attribution (voice-shape heatmap data). Returns char-weighted
  // composition + per-node origin (human|agent|mixed|unknown) for a doc.
  // The heatmap colours the live editor by nodeOrigins; the header shows percent.
  // adr: adr/0006-document-history-attribution.md
  app.get('/api/attribution/:docId', async (req, res) => {
    try {
      const { docId } = req.params;
      const { readBlame, summarizeBlame } = await import('./attribution.js');
      const { tiptapToBlocks } = await import('./node-blocks.js');
      let doc: any = null;
      if (getDocId() === docId) {
        doc = getDocument();
      } else {
        const { filenameByDocId } = await import('./documents.js');
        const { loadDocFromDisk } = await import('./pending-overlay.js');
        const fn = filenameByDocId(docId);
        if (fn) {
          try { doc = loadDocFromDisk(fn).document; } catch { doc = null; }
        }
      }
      const blame = readBlame(docId);
      if (!doc) {
        res.json({ tracked: blame !== null, percent: { human: 0, agent: 0, unknown: 0 }, chars: { human: 0, agent: 0, unknown: 0 }, nodeOrigins: {}, attributionSince: blame?.attributionSince ?? null });
        return;
      }
      const summary = summarizeBlame(blame, tiptapToBlocks(doc));
      res.json({ tracked: blame !== null, percent: summary.percent, chars: summary.chars, nodeOrigins: summary.nodes, attributionSince: blame?.attributionSince ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Version commits — the attributed git-history for a doc (newest first), each
  // with a one-line changeset label. adr: adr/0006-document-history-attribution.md
  app.get('/api/commits/:docId', async (req, res) => {
    try {
      const { listCommits, summaryLine, commitSnapshotAvailable } = await import('./commits.js');
      const commits = listCommits(req.params.docId)
        .map((c) => ({ ...c, label: summaryLine(c.summary), restorable: commitSnapshotAvailable(req.params.docId, c.ts) }))
        .reverse(); // newest first for the panel
      res.json({ commits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // One commit's attributed change detail (the per-event diff data the panel
  // renders when a commit row is expanded).
  app.get('/api/commit-detail/:docId/:ts', async (req, res) => {
    try {
      const { getCommitDetail } = await import('./commits.js');
      const detail = getCommitDetail(req.params.docId, Number(req.params.ts));
      if (!detail) { res.status(404).json({ error: 'commit not found' }); return; }
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Save version" — create a commit now with an optional note. The
  // changeset is whatever attributed edits have accrued since the last commit.
  app.post('/api/commit', async (req, res) => {
    try {
      const { docId, note } = req.body || {};
      if (!docId || typeof docId !== 'string') { res.status(400).json({ error: 'docId required' }); return; }
      // Flush the active doc so its latest edits are on disk before we snapshot.
      if (getDocId() === docId) { try { save(); } catch { /* best-effort */ } }
      const { commitFromFile } = await import('./commits.js');
      const { filenameByDocId } = await import('./documents.js');
      const { resolveDocPath } = await import('./helpers.js');
      const fn = filenameByDocId(docId);
      const commit = fn
        ? commitFromFile(docId, resolveDocPath(fn), { trigger: 'manual', actor: 'human', note: typeof note === 'string' ? note : undefined, nowTs: Date.now() })
        : null;
      res.json({ committed: commit !== null, commit });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mount version history routes (snapshot/list/get/restore). Carried verbatim
  // from openwriter because the History tab (VersionsTab) is a kept M2
  // client surface and needs the restore endpoint the Task 2 trim omitted.
  app.use(createChatRouter({ onProgress: (docId, sessionId, line) => broadcastChatProgress(docId, sessionId, line) }));
  app.use(createVersionRouter({
    getDocId,
    getFilePath,
    updateDocument,
    save,
    broadcastDocumentSwitched,
  }));

  // Paragraph list for a single doc: headings + paragraphs with preview text,
  // used by the chat surface to ground turns in the requested document.
  app.get('/api/documents/by-doc-id/:docId/paragraphs', async (req, res) => {
    try {
      const { resolveDocId } = await import('./documents.js');
      const filename = resolveDocId(req.params.docId);
      const activeFilename = getActiveFilename();
      let doc: any;
      if (filename === activeFilename) {
        doc = getDocument();
      } else {
        const filePath = resolveDocPath(filename);
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = markdownToTiptap(raw);
        doc = parsed.document;
      }

      type ParaEntry = { nodeId: string; type: string; level?: number; preview: string };
      const out: ParaEntry[] = [];
      function walk(nodes: any[]): void {
        for (const node of nodes) {
          if (node.type === 'heading' || node.type === 'paragraph') {
            const text = (node.content || [])
              .map((c: any) => (c.type === 'text' ? (c.text || '') : ''))
              .join('')
              .trim();
            if (!text) continue; // skip empty paragraphs
            const preview = text.length > 80 ? text.slice(0, 79) + '…' : text;
            const entry: ParaEntry = { nodeId: node.attrs?.id || '', type: node.type, preview };
            if (node.type === 'heading') entry.level = node.attrs?.level || 1;
            if (entry.nodeId) out.push(entry);
          } else if (Array.isArray(node.content)) {
            walk(node.content);
          }
        }
      }
      walk(doc.content || []);
      res.json({ paragraphs: out });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.get('/api/documents/:filename/text', (req, res) => {
    try {
      const filepath = resolveDocPath(req.params.filename);
      const raw = readFileSync(filepath, 'utf-8');
      // Parse YAML frontmatter
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      const text = fmMatch ? fmMatch[2].trim() : raw.trim();
      let meta: Record<string, any> = {};
      if (fmMatch) {
        try { meta = JSON.parse(fmMatch[1]); } catch {}
      }
      res.json({ text, meta });
    } catch (err: any) {
      res.status(404).json({ error: 'Document not found' });
    }
  });

  app.put('/api/documents/reorder', (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
      reorderDocs(order);
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents', (req, res) => {
    try {
      const result = createDocument(req.body.title, req.body.content, req.body.path);

      // Apply metadata if provided (e.g. tweetContext for threadified docs)
      if (req.body.metadata) {
        setMetadata(req.body.metadata);
        save();
      }

      // Variant relationship — set masterDocId and variantType in frontmatter
      if (req.body.masterDocId || req.body.variantType) {
        const variantMeta: Record<string, any> = {};
        if (req.body.masterDocId) variantMeta.masterDocId = req.body.masterDocId;
        if (req.body.variantType) variantMeta.variantType = req.body.variantType;
        setMetadata(variantMeta);
        save();
      }

      // Plugin flags: mark all content as pending + tag as agent-created
      if (req.body.markPending) {
        markAllNodesAsPending(getDocument(), 'insert');
        updatePendingCacheForActiveDoc();
        save();
      }
      if (req.body.agentCreated) {
        // In-memory stub registry — not persisted to disk frontmatter.
        // adr: adr/agent-stub-model.md
        markAsAgentStub(result.filename);
      }

      broadcastDocumentSwitched(result.document, result.title, result.filename);
      if (req.body.markPending || req.body.agentCreated) {
        broadcastDocumentsChanged();
        broadcastPendingDocsChanged();
      }
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/duplicate', (req, res) => {
    try {
      const { filename, masterDocId, variantType } = req.body;
      if (!filename) { res.status(400).json({ error: 'filename is required' }); return; }
      const result = duplicateDocument(
        filename,
        (masterDocId || variantType) ? { masterDocId, variantType } : undefined,
      );
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      broadcastDocumentsChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Create variant: a retyped derivative nested under the master. Field-projection
  // (body always; title folds into body on downcast; target type scaffolded) —
  // NOT a verbatim clone (that's /duplicate). adr: docs/variants.md
  app.post('/api/documents/variant', (req, res) => {
    try {
      const { filename, masterDocId, variantType } = req.body;
      if (!filename || !masterDocId || !variantType) {
        res.status(400).json({ error: 'filename, masterDocId, and variantType are required' });
        return;
      }
      const result = createVariant(filename, { masterDocId, variantType });
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      broadcastDocumentsChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/batch-resolve', (req, res) => {
    try {
      const { filenames, action } = req.body;
      if (!Array.isArray(filenames) || !filenames.length) { res.status(400).json({ error: 'filenames array is required' }); return; }
      if (action !== 'accept' && action !== 'reject') { res.status(400).json({ error: 'action must be "accept" or "reject"' }); return; }
      const result = batchResolve(filenames, action);
      if (result.docsResolved > 0) {
        // Clear pending cache for resolved docs + broadcast
        for (const fn of filenames) removePendingCacheEntry(fn);
        updatePendingCacheForActiveDoc();
        broadcastPendingDocsChanged();
        broadcastDocumentsChanged();
      }
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Per-node resolve (spike patch #7) — the approval seam the review UI and the
  // orchestrator drive. The CALLER supplies docId (evaluation build list #7):
  // active doc resolves in-memory, any other pending doc through the file path.
  app.post('/api/documents/resolve-entry', (req, res) => {
    try {
      const { docId, nodeId, action } = req.body;
      if (typeof docId !== 'string' || !docId) { res.status(400).json({ error: 'docId is required' }); return; }
      if (typeof nodeId !== 'string' || !nodeId) { res.status(400).json({ error: 'nodeId is required' }); return; }
      if (action !== 'accept' && action !== 'reject') { res.status(400).json({ error: 'action must be "accept" or "reject"' }); return; }
      // Format guard first, same standard as the /api/pending-entries read seam:
      // reject malformed docIds with 404 before any filesystem lookup.
      if (!/^[a-f0-9]{8}$/i.test(docId)) { res.status(404).json({ error: `no such docId: ${docId}` }); return; }
      const result = resolveOverlayEntry(docId, nodeId, action);
      if (result.resolved > 0) {
        removePendingCacheEntry(resolveDocId(docId));
        updatePendingCacheForActiveDoc();
        broadcastPendingDocsChanged();
        broadcastDocumentsChanged();
        if (action === 'accept' && docId === getDocId()) {
          // Trigger a version commit after the user accepts agent changes on the
          // active doc. Bundles attributed edit-events into a commit (actor = the
          // human who accepted). Dynamic import avoids boot-time cycles with the
          // commit module.
          (async () => { try {
            const { commitFromFile } = await import('./commits.js');
            const did = getDocId(); const fp = getFilePath();
            if (did && fp) commitFromFile(did, fp, { trigger: 'accept', actor: 'human', nowTs: Date.now() });
          } catch { /* best-effort */ } })();
        }
      }
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/quiesce', (req, res) => {
    const ms = Number(req.body?.ms ?? 5000);
    res.json({ until: quiesce(ms), quiesced: true });
  });
  app.post('/api/unquiesce', (_req, res) => {
    unquiesce();
    res.json({ quiesced: isQuiesced() });
  });

  app.post('/api/documents/open', (req, res) => {
    try {
      const { path } = req.body;
      if (!path) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const result = openFile(path);
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Sync browser editor content to server state — guarantees server has latest before MCP calls.
  // Used by compose modals that need to read server state via MCP tools.
  app.post('/api/documents/sync-content', (req, res) => {
    try {
      const { document: doc, filename } = req.body;
      if (!doc || !filename) {
        res.status(400).json({ error: 'document and filename required' });
        return;
      }
      if (filename === getActiveFilename()) {
        updateDocument(doc);
        save();
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/documents/switch', (req, res) => {
    try {
      const alreadyActive = req.body.filename === getActiveFilename();
      const result = switchDocument(req.body.filename);
      if (!alreadyActive) {
        broadcastDocumentSwitched(result.document, result.title, result.filename);
      }
      res.json(result);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/documents/reload', (_req, res) => {
    try {
      const result = reloadDocument();
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/documents/archived', (_req, res) => {
    res.json(listArchivedDocuments());
  });

  app.get('/api/documents/search', (req, res) => {
    const q = (req.query.q as string) || '';
    const includeArchived = req.query.archived === 'true';
    res.json(searchDocuments(q, includeArchived));
  });

  app.post('/api/documents/:filename/archive', (req, res) => {
    try {
      const result = archiveDocument(req.params.filename);
      removeDocFromAllWorkspaces(req.params.filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/:filename/unarchive', (req, res) => {
    try {
      const result = unarchiveDocument(req.params.filename);
      broadcastDocumentsChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/documents/:filename/content', (req, res) => {
    try {
      const targetPath = resolveDocPath(req.params.filename);
      if (!existsSync(targetPath)) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const raw = readFileSync(targetPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      res.json({
        title: parsed.title,
        document: parsed.document,
        metadata: parsed.metadata,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/documents/:filename', async (req, res) => {
    try {
      // Membership follows success (F1 rider, spec 2026-09-13) — and the
      // sibling-adjacent switch inside deleteDocument reads the manifest.
      const result = await deleteDocument(req.params.filename);
      removeDocFromAllWorkspaces(req.params.filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/documents/:filename', (req, res) => {
    try {
      // Title change = metadata only. Filename stays stable.
      updateDocumentTitle(req.params.filename, req.body.title);
      broadcastDocumentsChanged();
      res.json({ filename: req.params.filename });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Document-level tag routes
  app.get('/api/doc-tags/:filename', (req, res) => {
    res.json({ tags: getDocTagsByFilename(req.params.filename) });
  });

  app.post('/api/doc-tags/:filename', (req, res) => {
    try {
      const { tag } = req.body;
      if (!tag?.trim()) { res.status(400).json({ error: 'tag is required' }); return; }
      addDocTag(req.params.filename, tag.trim());
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/doc-tags/:filename/:tag', (req, res) => {
    try {
      removeDocTag(req.params.filename, req.params.tag);
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Comments (formerly "agent marks")
  app.post('/api/edit-text', (req, res) => {
    try {
      const { nodeId, edits } = req.body;
      if (!nodeId || !edits) {
        res.status(400).json({ error: 'nodeId and edits are required' });
        return;
      }
      const result = applyTextEdits(nodeId, edits);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ---- Profile management ----
  app.get('/api/profiles', (_req, res) => {
    res.json({ profiles: listProfiles(), active: getActiveProfile() });
  });

  app.post('/api/profiles', (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      createProfile(name.trim());
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/profiles/switch', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      const profiles = listProfiles();
      if (!profiles.includes(name)) { res.status(404).json({ error: `Profile "${name}" not found` }); return; }

      // Flush current doc
      cancelDebouncedSave();
      save();

      // Switch profile
      setActiveProfile(name);
      saveConfig({ activeProfile: name });

      // Clear caches and reload
      clearAllCaches();
      load();

      // Broadcast fresh state
      broadcastDocumentSwitched(getDocument(), getTitle(), getFilePath().split(/[/\\]/).pop() || '', getMetadata());
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      broadcastPendingDocsChanged();
      res.json({ success: true, active: name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/profiles/:name', (req, res) => {
    try {
      deleteProfile(req.params.name);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/profiles/trash', (_req, res) => {
    res.json({ profiles: listTrashedProfiles() });
  });

  app.post('/api/profiles/restore', (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      restoreProfile(name.trim());
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Library shelf (read-only) ----
  // The librarian's mirrors beneath ROOT_DIR/library/. Listing/preview are
  // pure reads; adopt is the one write path OUT of the shelf (spec §2), and
  // restore discards the adopted desk copy so the librarian re-seeds. Every
  // other write into the shelf is refused by assertWritableDocPath in the
  // save chokepoints. adr: adr/0007-git-orchestrator-dumb-host-side.md

  app.get('/api/library', (_req, res) => {
    res.json(listLibraryDocs());
  });

  app.get('/api/library/:docId', (req, res) => {
    try {
      res.json(readLibraryDoc(req.params.docId));
    } catch (err: any) {
      // A bad docId (400) is the caller's mistake; a missing mirror is 404.
      const status = err?.status ?? (err?.code === 'ENOENT' ? 404 : 500);
      res.status(status).json({ error: err?.message ?? 'library read failed' });
    }
  });

  app.post('/api/library/adopt', (req, res) => {
    try {
      const docId = req.body?.docId;
      if (typeof docId !== 'string' || !docId.trim()) { res.status(400).json({ error: 'docId is required' }); return; }
      const info = adoptLibraryDoc(docId.trim(), 'human');
      broadcastDocumentsChanged();
      broadcastLibraryChanged();
      res.json(info);
    } catch (err: any) {
      res.status(err?.status ?? 400).json({ error: err?.message ?? 'adopt failed', ...(err?.code ? { code: err.code } : {}) });
    }
  });

  app.post('/api/library/:docId/restore', async (req, res) => {
    try {
      const result = await restoreLibraryDoc(req.params.docId, 'human');
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename, getMetadata());
      }
      broadcastDocumentsChanged();
      // restore deletes a desk doc (restoreLibraryDoc → removeDocFromAllWorkspaces)
      // — a membership change, so workspaces broadcast like the delete route.
      broadcastWorkspacesChanged();
      broadcastLibraryChanged();
      res.json({ restored: true, filename: result.filename });
    } catch (err: any) {
      res.status(err?.status ?? 400).json({ error: err?.message ?? 'restore failed' });
    }
  });

  const clientDir = join(__dirname, '..', 'client');
  if (existsSync(clientDir)) {
    // index: false — the shell is served through appShellHtml() so the tab
    // title carries the deployment's name; every other asset stays static.
    app.use(express.static(clientDir, { index: false }));
    let shellCache: string | null = null;
    app.get('*', (_req, res) => {
      if (!shellCache) shellCache = readFileSync(join(clientDir, 'index.html'), 'utf-8');
      let site = DEFAULT_SITE_NAME;
      try {
        site = readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()))?.siteName || DEFAULT_SITE_NAME;
      } catch { /* store absent or unreadable (dev) → default name */ }
      const safe = site.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      res.type('html').send(shellCache.replace(/<title>[\s\S]*?<\/title>/, `<title>${safe}</title>`));
    });
  }

  const server = createServer(app);

  // Setup WebSocket on same server
  setupWebSocket(server);

  // Broadcast agent status now that WS is ready
  broadcastAgentStatus(true);

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[HTTP] Port ${port} in use — retrying in 2s...`);
        setTimeout(() => {
          server.listen(port, listenHost, () => {
            console.log(`Writing Desk running at http://localhost:${port}`);
            resolve();
          });
        }, 2000);
      } else {
        console.error(`[HTTP] Server error:`, err);
        reject(err);
      }
    });
    server.listen(port, listenHost, () => {
      console.log(`Writing Desk running at http://localhost:${port}`);
      resolve();
    });
  });

}
