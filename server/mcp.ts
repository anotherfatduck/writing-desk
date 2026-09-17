/**
 * MCP stdio server: external-agent drafting tool set + stdio/HTTP wiring.
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDataDir, ensureDataDir, resolveDocPath, generateNodeId, atomicWriteFileSync, readConfig, ROOT_DIR } from './helpers.js';
import {
  getDocument,
  getWordCount,
  getPendingChangeCount,
  getTitle,
  getStatus,
  getMetadata,
  setMetadata,
  mergeMetadataUpdates,
  applyChanges,
  applyTextEdits,
  updateDocument,
  save,
  markAllNodesAsPending,
  setAgentLock,
  setAgentLockActive,
  updatePendingCacheForActiveDoc,
  populateDocumentFile,
  applyChangesToFile,
  applyTextEditsToFile,
  getDocId,
  getFilePath,
  getIsTemp,
  extractText,
  countPending,
  getCachedDocument,
  invalidateDocCache,
  isAutoAcceptActive,
  removePendingCacheEntry,
  getExternalMtimeDrift,
  reloadActiveDocFromDisk,
  getCanonical,
  cloneWithPendingReverted,
  bumpDocVersion,
  type NodeChange,
  type PadDocument,
} from './state.js';
import { tiptapToBlocks } from './node-blocks.js';
import { readBlame, summarizeBlame } from './attribution.js';
import { truncateRead } from './peek-outline.js';
import { toCompactFormat, compactNodes, parseMarkdownContent } from './compact.js';
import { markdownToTiptap, tiptapToMarkdown, splitFusedParagraphs } from './markdown.js';
import { loadDocFromDisk, type ProposedProvenance } from './pending-overlay.js';
import { listDocuments, resolveDocId, getActiveFilename, filenameByDocId, createDocumentFile, stagePendingTitle, promoteTempFile } from './documents.js';
import { resolveTypeMeta } from './content-type-meta.js';
import { findOrCreateWorkspace, findOrCreateContainer, addDoc } from './workspaces.js';
import { logger, generateRequestId, withRequestId } from './logger.js';
import { broadcastDocumentSwitched, broadcastDocumentsChanged, broadcastWorkspacesChanged, broadcastMetadataChanged, broadcastPendingDocsChanged, broadcastPendingMetadataChanged, broadcastTitleChanged, broadcastWritingStarted, broadcastWritingFinished } from './ws.js';

export interface DocTarget {
  filename: string;
  filePath: string;
  docId: string;
  isActive: boolean;
  document: PadDocument;
  title: string;
  metadata: Record<string, any>;
  wordCount: number;
  pendingCount: number;
  lastModified: Date;
}
export function resolveDocTarget(docId: string): DocTarget {
  const filename = resolveDocId(docId);
  const activeFilename = getActiveFilename();

  // Fast path: active document — use in-memory state
  if (filename === activeFilename) {
    return {
      filename,
      filePath: getFilePath(),
      docId,
      isActive: true,
      document: getDocument(),
      title: getTitle(),
      metadata: getMetadata(),
      wordCount: getWordCount(),
      pendingCount: getPendingChangeCount(),
      lastModified: new Date(getStatus().lastModified),
    };
  }

  // Non-active: try cache, then disk
  const filePath = resolveDocPath(filename);
  const cached = getCachedDocument(filePath);
  if (cached) {
    const text = extractText(cached.document.content);
    return {
      filename,
      filePath,
      docId: cached.docId,
      isActive: false,
      document: cached.document,
      title: cached.title,
      metadata: cached.metadata,
      wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
      pendingCount: countPending(cached.document.content),
      lastModified: cached.lastModified,
    };
  }

  // Read from disk — load the MERGED view (canonical body + sidecar overlay).
  // The bare markdownToTiptap returns canonical-only; without applying the
  // sidecar, a doc that has pending content (typical after write_to_pad on a
  // non-active doc) would surface here with 0 words and 0 pending — silently
  // dropping the user's just-written content. The overlay-aware loader closes
  // that asymmetry. adr: adr/0005-pending-overlay-model.md
  if (!existsSync(filePath)) throw new Error(`Document file not found: ${filename}`);
  const loaded = loadDocFromDisk(filename);
  const resolvedDocId = loaded.docId || docId;
  const text = extractText(loaded.document.content);
  return {
    filename,
    filePath,
    docId: resolvedDocId,
    isActive: false,
    document: loaded.document,
    title: loaded.title,
    metadata: loaded.metadata || {},
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
    pendingCount: countPending(loaded.document.content),
    lastModified: statSync(filePath).mtime,
  };
}
export type ToolResult = { content: { type: 'text'; text: string }[] };

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any) => Promise<ToolResult>;
}
/** Hard cap on words returned per read_pad call. Above this, the response
 *  is truncated at a top-level node boundary and a continuation hint points
 *  at another read_pad slice. The cap exists so the agent can't accidentally
 *  token-blow a 50k-word doc — read_pad's contract is "doc opening + handle to
 *  continue," not "everything." v0.25 — see CHANGELOG. */
const READ_PAD_MAX_WORDS = 2000;
/** First-truncation FYI shows once per MCP process lifetime so the agent
 *  learns the new behavior without repeating the explanation. Resets on
 *  server restart. */
let firstTruncationShown = false;

/** MCP-9: metadata keys an agent must NEVER set via set_metadata. `autoAccept`
 *  governs the human accept/reject gate — letting the agent write it via
 *  open-ended frontmatter would self-grant auto-accept and bypass human review.
 *  These are operator-only (set through the UI toggle path). The metadata
 *  surface is otherwise intentionally open-ended, so this is a denylist of the
 *  finite, enumerable privileged keys rather than an allowlist of content keys. */
const AGENT_FORBIDDEN_METADATA_KEYS = new Set(['autoAccept']);
export const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'read_pad',
    description: `Read a document by docId. Returns compact tagged-line format with [type:id] per node. Default: first ~${READ_PAD_MAX_WORDS} words. Three knobs for longer docs:\n• \`slice: { from, to }\` — read a percentile range (floats in [0,1]). \`{from:0.5, to:1}\` = back half, \`{from:0.25, to:0.75}\` = middle 50%, \`{from:0.0, to:0.1}\` then \`{from:0.1, to:0.2}\` … = sequential 10% chunks. Snaps to top-level node boundaries; subject to the word cap unless force is set.\n• \`force: true\` — bypass the cap, return the full requested region (whole doc or whole slice). Use for full-doc audits/rewrites where you've accepted the cost.\n• When the cap kicks in, the response includes \`lastNodeId\` + continuation hints to another \`read_pad\` slice.`,
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
      // Schemas use z.preprocess to coerce string inputs — some MCP clients
      // serialize complex / boolean params as JSON strings rather than native
      // types. Accepting both forms means agents work regardless of client.
      slice: z.preprocess(
        (v) => (typeof v === 'string' && v.trim().startsWith('{')) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v,
        z.object({
          from: z.number().min(0).max(1).describe('Start of the slice as a fraction of total word count (0 = beginning).'),
          to: z.number().min(0).max(1).describe('End of the slice as a fraction of total word count (1 = end). Must be > from.'),
        }).optional(),
      ).describe('Percentile range to read instead of the doc opening. Snaps to top-level node boundaries. Examples: { from: 0.5, to: 1 } = back half; { from: 0.25, to: 0.75 } = middle 50%.'),
      force: z.preprocess(
        (v) => (typeof v === 'string') ? v === 'true' : v,
        z.boolean().optional(),
      ).describe(`Bypass the ~${READ_PAD_MAX_WORDS}-word cap. Returns the full requested region in one call. Use for full-doc audits and rewrites where the cost is acknowledged.`),
    },
    handler: async ({ docId, slice, force }: { docId: string; slice?: { from: number; to: number }; force?: boolean }) => {
      const target = resolveDocTarget(docId);
      const trunc = truncateRead(target.document, { maxWords: READ_PAD_MAX_WORDS, slice, force });
      const compact = toCompactFormat(
        trunc.doc,
        target.title,
        trunc.returnedWords,
        target.pendingCount,
        target.docId,
        target.metadata,
      );
      let hint = '';

      // Label forced / sliced reads so the response is self-describing.
      if (trunc.forced) {
        const region = trunc.slice
          ? `forced slice ${(trunc.slice.from * 100).toFixed(0)}–${(trunc.slice.to * 100).toFixed(0)}%`
          : 'forced full read';
        hint += `\n[${region.toUpperCase()} — ${trunc.returnedWords.toLocaleString()} words returned of ${trunc.totalWords.toLocaleString()} total. Cap bypassed.]`;
      } else if (trunc.slice && !trunc.truncated) {
        hint += `\n[SLICE ${(trunc.slice.from * 100).toFixed(0)}–${(trunc.slice.to * 100).toFixed(0)}% — ${trunc.returnedWords.toLocaleString()} of ${trunc.totalWords.toLocaleString()} words. Adjacent slices: read_pad({ docId: "${target.docId}", slice: { from: ${trunc.slice.to.toFixed(2)}, to: ${Math.min(1, trunc.slice.to + (trunc.slice.to - trunc.slice.from)).toFixed(2)} } }) for the next region.]`;
      } else if (trunc.truncated) {
        if (!firstTruncationShown) {
          hint += `\n\n[FYI: read_pad caps at ~${READ_PAD_MAX_WORDS} words to keep cost predictable. Override per-call with force:true, or read a specific region with slice:{from,to}. This notice shows once per session.]`;
          firstTruncationShown = true;
        }
        const anchor = trunc.lastNodeId ?? '<no-id>';
        const sliceLabel = trunc.slice
          ? ` of slice ${(trunc.slice.from * 100).toFixed(0)}–${(trunc.slice.to * 100).toFixed(0)}%`
          : '';
        hint += `\n[TRUNCATED — ${trunc.totalWords.toLocaleString()} words total, ${trunc.returnedWords.toLocaleString()} returned${sliceLabel}, ${trunc.remaining.toLocaleString()} remain. Continue with:`
          + `\n  read_pad({ docId: "${target.docId}", slice: { from: 0.5, to: 1 } })  — read the back half (or any percentile range)`
          + `\n  read_pad({ docId: "${target.docId}", force: true })  — entire body, cap bypassed]`;
      }
      return { content: [{ type: 'text', text: compact + hint }] };
    },
  },
  {
    name: 'write_to_pad',
    description: 'Preferred tool for all document edits. Send 3-8 changes per call for responsive feel. Multiple rapid calls better than one monolithic call. Content can be a markdown string (preferred) or TipTap JSON. Markdown strings are auto-converted. Changes appear as pending decorations the user accepts or rejects. Use afterNodeId: "end" to append to the document without knowing node IDs. Response includes lastNodeId for chaining subsequent inserts. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      changes: z.array(z.object({
        operation: z.enum(['rewrite', 'insert', 'delete']),
        nodeId: z.string().optional(),
        afterNodeId: z.string().optional(),
        content: z.any().optional(),
      })).describe('Array of node changes. Content accepts markdown strings or TipTap JSON.'),
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
      provenance: z.object({
        agentSessionId: z.string(),
        model: z.string(),
        promptVersion: z.string(),
        sourceSet: z.array(z.string()).optional(),
        reviewerStatus: z.any().optional(),
        proposedAt: z.string(),
      }).optional(),
    },
    handler: async ({ changes, docId, provenance }: { changes: any[]; docId: string; provenance?: ProposedProvenance }) => {
      const filename = resolveDocId(docId);
      const processed = changes.map((change) => {
        const resolved = { ...change };
        if (typeof resolved.content === 'string') {
          resolved.content = parseMarkdownContent(resolved.content);
        }
        // Canonical form for every doc type (including X templates) is separate
        // paragraph nodes — one node per review unit, intra-paragraph single
        // <br>s preserved. Heal any fused double-<br> paragraph that arrives as
        // TipTap JSON: the markdown-string path above already splits via
        // markdown-it, but JSON content bypasses it, so an X-style fused node
        // would otherwise enter canonical and break the serialize→reparse
        // round-trip (sync-check FAIL), the node-identity matcher, and the
        // pending decorations. Idempotent on already-split content.
        // adr: adr/tweet-paragraph-convention.md
        if (resolved.content != null && resolved.operation !== 'delete') {
          const asArray = Array.isArray(resolved.content) ? resolved.content : [resolved.content];
          resolved.content = splitFusedParagraphs(asArray);
        }
        return resolved;
      });

      const targetIsNonActive = filename && filename !== getActiveFilename();
      if (targetIsNonActive) {
        const { count: appliedCount, lastNodeId } = applyChangesToFile(filename, processed as NodeChange[], provenance);
        broadcastPendingDocsChanged();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: appliedCount > 0,
              appliedCount,
              ...(lastNodeId ? { lastNodeId } : {}),
              ...(appliedCount < processed.length ? { skipped: processed.length - appliedCount } : {}),
            }),
          }],
        };
      }

      const { count: appliedCount, lastNodeId } = applyChanges(processed as NodeChange[], provenance);
      // broadcastPendingDocsChanged() already fires via onChanges listener in ws.ts
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: appliedCount > 0,
            appliedCount,
            ...(lastNodeId ? { lastNodeId } : {}),
            ...(appliedCount < processed.length ? { skipped: processed.length - appliedCount } : {}),
          }),
        }],
      };
    },
  },
  {
    name: 'get_pad_status',
    description: 'Get the status of a document: word count, pending changes. Cheap call for polling.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      const status: Record<string, any> = {
        title: target.title,
        wordCount: target.wordCount,
        pendingChanges: target.pendingCount,
        lastModified: target.lastModified.toISOString(),
      };
      // Surface effective autoAccept (doc flag OR workspace/container inherited)
      // so the agent stops waiting for review when it's on.
      if (isAutoAcceptActive(target.filename, target.metadata)) status.autoAccept = true;
      // External-write drift: only meaningful for the active doc (non-active
      // docs are read fresh from disk on each access). If the file's on-disk
      // mtime differs from what we loaded, an external writer modified the
      // file — the next save would be blocked by the guard. Surface this so
      // agents can call read_pad to refresh from disk before re-attempting a
      // write. adr: adr/external-write-guard.md
      if (target.isActive) {
        const drift = getExternalMtimeDrift();
        if (drift) {
          status.externalWriteDetected = {
            diskMtime: new Date(drift.diskMtime).toISOString(),
            loadedMtime: new Date(drift.loadedMtime).toISOString(),
            note: 'File modified externally. Call read_pad to refresh from disk before writing or your changes will be blocked.',
          };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(status) }] };
    },
  },
  {
    name: 'list_documents',
    description: 'List all documents. Shows title, docId, word count, last modified, and active flag. Use the docId to target documents in other tools. v0.19.0: three-field enrichment schema — logline (LLM), status (agent: canonical / draft), STALE (system).',
    schema: {},
    handler: async () => {
      const docs = listDocuments();
      const lines = docs.map((d) => {
        const active = d.isActive ? ' (active)' : '';
        const id = d.docId ? ` [${d.docId}]` : '';
        const date = d.lastModified.split('T')[0];
        const enrichBits: string[] = [];
        // v0.19.0: only canonical surfaces — draft is the default and would
        // clutter the listing on every doc.
        if (d.status === 'canonical') enrichBits.push('canonical');
        if (d.enrichmentStale === true) enrichBits.push('STALE');
        const enrichTag = enrichBits.length > 0 ? ` (${enrichBits.join(', ')})` : '';
        const main = `  "${d.title}"${id}${active}${enrichTag} — ${d.wordCount.toLocaleString()} words — ${date}`;
        if (d.logline) return `${main}\n      → ${d.logline}`;
        return main;
      });
      return { content: [{ type: 'text', text: `documents:\n${lines.join('\n') || '  (none)'}` }] };
    },
  },
  {
    name: 'declare_writes',
    description: 'Declare a batch of documents to create at once. Use this when creating multiple documents in parallel. Each write gets its own sidebar spinner keyed to its filename. Returns an array of { docId, filename, title }. Next step: call write_to_pad once per docId to fill in content (in parallel is fine). For creating a single document, call declare_writes with one entry or create the file directly via write_to_pad using afterNodeId: "end".',
    schema: {
      writes: z.array(z.object({
        title: z.string().describe('Title for the document.'),
        content_type: z.enum(['document', 'article']).describe('Content type. Use "document" for plain docs. "article" = a long-form piece.'),
        workspace: z.string().optional().describe('Workspace title to add this doc to. Creates the workspace if it does not exist.'),
        container: z.string().optional().describe('Container name within the workspace (e.g. "Chapters"). Requires workspace.'),
        path: z.string().optional().describe('Absolute file path to create the document at. If omitted, creates in ~/.openwriter/.'),
        afterId: z.string().optional().describe('Place the new doc immediately after this docId or containerId inside its parent. Omit to append to the bottom (default, ascending-order convention). Requires workspace.'),
      })).min(1).describe('List of documents to declare (minimum 1).'),
    },
    handler: async ({ writes }: { writes: Array<{ title: string; content_type: string; workspace?: string; container?: string; url?: string; path?: string; afterId?: string }> }) => {
      const results: Array<{ docId: string; filename: string; title: string; error?: string }> = [];
      let workspacesChanged = false;
      const broadcastedKeys: string[] = [];

      for (const w of writes) {
        try {
          let wsTarget: { wsFilename: string; containerId: string | null } | undefined;
          if (w.workspace) {
            const ws = findOrCreateWorkspace(w.workspace);
            let containerId: string | null = null;
            if (w.container) {
              const c = findOrCreateContainer(ws.filename, w.container);
              containerId = c.containerId;
            }
            wsTarget = { wsFilename: ws.filename, containerId };
            workspacesChanged = true;
          }

          const typeMeta = resolveTypeMeta(w.content_type);
          const result = createDocumentFile(w.title, w.path, typeMeta);

          if (wsTarget) {
            const afterRef = w.afterId ? (filenameByDocId(w.afterId) ?? w.afterId) : null;
            addDoc(wsTarget.wsFilename, wsTarget.containerId, result.filename, result.title, afterRef);
          }

          broadcastWritingStarted(w.title, wsTarget, result.filename, result.filename, result.docId);
          broadcastedKeys.push(result.filename);

          results.push({ docId: result.docId, filename: result.filename, title: result.title });
        } catch (err: any) {
          results.push({ docId: '', filename: '', title: w.title, error: err.message });
        }
      }

      broadcastDocumentsChanged();
      if (workspacesChanged) broadcastWorkspacesChanged();

      const successes = results.filter((r) => !r.error);
      const failures = results.filter((r) => r.error);

      const lines = [
        `Declared ${successes.length} write${successes.length === 1 ? '' : 's'}${failures.length ? ` (${failures.length} failed)` : ''}:`,
        ...successes.map((r) => `  "${r.title}" [${r.docId}] → ${r.filename}`),
      ];
      if (failures.length) {
        lines.push('', 'Errors:');
        for (const r of failures) lines.push(`  "${r.title}" — ${r.error}`);
      }
      if (successes.length) {
        lines.push('', 'Next: call write_to_pad once per docId to fill in content (use afterNodeId: "end" to append).');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'get_metadata',
    description: 'Get the JSON frontmatter metadata for a document. Returns all key-value pairs stored in frontmatter (title, summary, characters, tags, etc.). Useful for understanding document context without reading full content.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      return { content: [{ type: 'text', text: Object.keys(target.metadata).length > 0 ? JSON.stringify(target.metadata) : '{}' }] };
    },
  },
  {
    name: 'get_attribution',
    description: 'Get human-vs-agent author attribution for a document. Returns the char-weighted composition (% human / % agent / % unknown) plus per-node coarse origin (human | agent | mixed | unknown). Attribution is captured automatically at save time and anchored to sentence content, so it survives edits, splits, and paste-back. "unknown" = content authored before attribution tracking began. Use to report how much of a doc is genuinely author-written vs agent-scaffolded.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      const blocks = tiptapToBlocks(target.document);
      const blame = readBlame(docId);
      const summary = summarizeBlame(blame, blocks);
      const nodeCounts = { human: 0, agent: 0, mixed: 0, unknown: 0 } as Record<string, number>;
      for (const origin of Object.values(summary.nodes)) nodeCounts[origin] = (nodeCounts[origin] ?? 0) + 1;
      return { content: [{ type: 'text', text: JSON.stringify({
        docId,
        percent: summary.percent,
        chars: summary.chars,
        nodeOrigins: summary.nodes,
        nodeCounts,
        tracked: blame !== null,
        attributionSince: blame?.attributionSince ?? null,
      }) }] };
    },
  },
  {
    name: 'set_metadata',
    description: 'Update frontmatter metadata on a document. Merges with existing metadata — only provided keys are changed. Use for summaries, character lists, tags, arc notes, or any organizational data. Saves to disk immediately. Lifecycle convention (v0.19.0): use `set_metadata({ status: "canonical" })` when a doc commits to the workspace spine (Beats locks, Research Note becomes load-bearing); use `set_metadata({ status: "draft" })` when a doc is superseded or demoted. Status is the agent\'s field — the enrichment minion never writes it.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
      metadata: z.record(z.any()).describe('Key-value pairs to merge into frontmatter. Set a key to null to remove it.'),
    },
    handler: async ({ docId, metadata: rawUpdates }: { docId: string; metadata: Record<string, any> }) => {
      const target = resolveDocTarget(docId);

      // MCP-9: strip control keys. `autoAccept` governs the human accept/reject
      // gate — an agent that could set it via set_metadata would self-grant
      // auto-accept and bypass human review entirely. The approval-mode flag is
      // operator-only (UI toggle → setDocAutoAccept / setWorkspaceAutoAccept).
      // Stripping covers both set AND remove: deleting an explicit
      // `autoAccept: false` would re-enable workspace-inherited auto-accept.
      const updates: Record<string, any> = {};
      const blockedKeys: string[] = [];
      for (const [key, value] of Object.entries(rawUpdates)) {
        if (AGENT_FORBIDDEN_METADATA_KEYS.has(key)) { blockedKeys.push(key); continue; }
        updates[key] = value;
      }

      const setKeys: string[] = [];
      const removed: string[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined) {
          removed.push(key);
        } else {
          setKeys.push(key);
        }
      }

      const cleaned: Record<string, any> = {};
      for (const key of setKeys) cleaned[key] = updates[key];

      // Title is gated through pending-overlay unless this is a temp file
      // being titled for the first time (creation path — promoteTempFile
      // must run synchronously so the file gets a real filename on disk).
      // adr: adr/0005-pending-overlay-model.md
      let stagedTitle: { from: string; to: string } | null = null;
      const isCreationTitleSet = cleaned.title && target.isActive && getIsTemp();
      const wantsTitlePending = cleaned.title && !isCreationTitleSet;
      if (wantsTitlePending) {
        const staged = stagePendingTitle(docId, cleaned.title);
        if (staged.from !== staged.to) {
          stagedTitle = { from: staged.from, to: staged.to };
        }
        delete cleaned.title; // remove from the hot-write path
      }

      if (target.isActive) {
        // Active doc: use in-memory path
        if (Object.keys(cleaned).length > 0) setMetadata(cleaned);
        const meta = getMetadata();
        for (const key of removed) delete meta[key];
        save('agent');
        broadcastMetadataChanged(getMetadata());

        if (cleaned.title) {
          // Reached only on temp-file creation titling — hot promote.
          const promoted = promoteTempFile(cleaned.title);
          broadcastTitleChanged(cleaned.title);
          broadcastDocumentsChanged();
          if (promoted) {
            broadcastDocumentSwitched(getDocument(), getTitle(), promoted, getMetadata());
          }
        }
      } else {
        // Non-active doc: read → merge → write file
        let meta = { ...target.metadata };
        if (Object.keys(cleaned).length > 0) {
          const merged = mergeMetadataUpdates(meta, cleaned);
          if (merged) meta = merged;
        }
        for (const key of removed) delete meta[key];
        // Title may have been stripped out for pending-staging; preserve the
        // canonical (on-disk) title in the rewrite.
        const newTitle = meta.title || target.title;
        const markdown = tiptapToMarkdown(target.document, newTitle, meta);
        atomicWriteFileSync(target.filePath, markdown);
        invalidateDocCache(target.filePath);
      }

      if (stagedTitle) {
        broadcastPendingMetadataChanged(docId, { title: stagedTitle });
        broadcastPendingDocsChanged();
      }

      const keys = Object.keys(cleaned);
      const parts: string[] = [];
      if (keys.length > 0) parts.push(`set: ${keys.join(', ')}`);
      if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`);
      if (blockedKeys.length > 0) parts.push(`ignored (operator-only): ${blockedKeys.join(', ')}`);
      return { content: [{ type: 'text', text: `Metadata updated (${parts.join('; ')})` }] };
    },
  },
  {
    name: 'edit_text',
    description: 'Apply fine-grained text edits within a node. Find text by exact match and replace it, or add/remove marks on matched text. More precise than rewriting the whole node. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      nodeId: z.string().describe('ID of the node to edit'),
      edits: z.array(z.object({
        find: z.string().describe('Exact text to find within the node'),
        replace: z.string().optional().describe('Replacement text (omit to keep text, just change marks)'),
        addMark: z.object({
          type: z.string(),
          attrs: z.record(z.any()).optional(),
        }).optional().describe('Mark to add to the matched text (e.g. link, bold)'),
        removeMark: z.string().optional().describe('Mark type to remove from matched text'),
      })).describe('Array of text edits to apply'),
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
    },
    handler: async ({ nodeId, edits, docId }: { nodeId: string; edits: any[]; docId: string }) => {
      const filename = resolveDocId(docId);
      const targetIsNonActive = filename && filename !== getActiveFilename();
      if (targetIsNonActive) {
        const result = applyTextEditsToFile(filename, nodeId, edits);
        if (result.success) broadcastPendingDocsChanged();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(applyTextEdits(nodeId, edits)) }] };
    },
  },
];

let mcpServerInstance: McpServer | null = null;

export async function startMcpServer(): Promise<void> {
  const combinedNotice = '';

  const server = new McpServer({
    name: 'content-repo',
    version: '0.2.0',
  }, combinedNotice ? { instructions: combinedNotice } : undefined);

  // Wrap each tool handler in withRequestId so every event logged during
  // the tool's execution inherits the same request ID. Trace one MCP call
  // through the system with: jq 'select(.requestId=="mcp-toolname-xxxxxx")'.
  // adr: adr/logging-system.md
  for (const tool of TOOL_REGISTRY) {
    const wrappedHandler = async (args: any) => {
      const reqId = generateRequestId(`mcp-${tool.name}`);
      return await withRequestId(reqId, async () => {
        logger.debug('mcp', 'tool-call', tool.name, { tool: tool.name });
        try {
          const result = await tool.handler(args);
          return result;
        } catch (err: any) {
          logger.error('mcp', 'tool-error', `${tool.name}: ${err.message}`, { tool: tool.name }, err);
          throw err;
        }
      });
    };
    server.tool(tool.name, tool.description, tool.schema, wrappedHandler);
  }

  mcpServerInstance = server;

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
