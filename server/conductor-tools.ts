/**
 * Conductor tool layer — the model-facing tools, executed in-process.
 * Writes reuse the external-agent path (write_to_pad handler machinery);
 * the model never reaches git, shell, publish, or arbitrary fs. Spec:
 * docs/superpowers/specs/2026-09-03-m3-conductor-chat-design.md §The four tools.
 *
 * M4 note (chat-agent-config): the conductor has NO submit tool — submission
 * is writer-initiated from the Review tab (/api/review-gate/submit); a model
 * calling submit_for_review hits the loop's unknown-tool reply and the turn
 * continues. The M3-authorized direct-write exception died with the tool.
 */
import { z } from 'zod';
import { readFileSync } from 'fs';
import { TOOL_REGISTRY, resolveDocTarget } from './mcp.js';
import { listDocuments } from './documents.js';
import { listWorkspaces } from './workspaces.js';
import { loadOverlay, nodeTextPreview, entrySummary, type ProposedProvenance } from './pending-overlay.js';
import { tiptapToMarkdown } from './markdown.js';
import { save } from './state.js';
import { getActiveFilename } from './documents.js';
import matter from 'gray-matter';

import { CHAT_PROMPT_VERSION } from '../shared/chat-persona.js';
export { CHAT_PROMPT_VERSION };

export interface ConductorContext { sessionId: string; docId: string; }
export interface ConductorToolResult { content: { type: 'text'; text: string }[]; terminal?: boolean; }
export interface ConductorToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // OpenAI JSON-schema (wire form)
  schema: Record<string, z.ZodTypeAny>;  // zod (enforcement form)
  execute(args: any, ctx: ConductorContext): Promise<ConductorToolResult>;
}

const READ_DOC_MAX_CHARS = 120_000;

function buildProvenance(ctx: ConductorContext): ProposedProvenance {
  return {
    agentSessionId: ctx.sessionId,
    model: process.env.AGENT_MODEL ?? 'unset',
    promptVersion: CHAT_PROMPT_VERSION,
    sourceSet: [] as string[],   // slot — filled when source tracking lands (content-repo MODEL_STRATEGY.md)
    reviewerStatus: null,        // slot — M4's editorial/medical gates fill this
    proposedAt: new Date().toISOString(),
  };
}

async function proposeEdits(args: { changes: any[] }, ctx: ConductorContext): Promise<ConductorToolResult> {
  const writeTool = TOOL_REGISTRY.find((t) => t.name === 'write_to_pad');
  if (!writeTool) throw new Error('write_to_pad tool missing from registry');
  const result = await writeTool.handler({ changes: args.changes, docId: ctx.docId, provenance: buildProvenance(ctx) });
  // Active-doc writes arm a debounced save; flush it so the sidecar is on disk
  // before the test (or caller) reads it back. Attribution already rode the
  // write itself — there is no post-hoc stamping step.
  const filename = resolveDocTarget(ctx.docId).filename;
  if (filename === getActiveFilename()) {
    save('agent');
  }
  return result;
}

export const CONDUCTOR_TOOLS: ConductorToolDef[] = [
  {
    name: 'read_document',
    description: 'Read the session document: canonical markdown (frontmatter + body), the node-id map used to target propose_edits, and pending proposals awaiting review.',
    parameters: { type: 'object', properties: {} },
    schema: {},
    execute: async (args: Record<string, never>, ctx: ConductorContext) => {
      const target = resolveDocTarget(ctx.docId);
      let markdown = tiptapToMarkdown(target.document, target.title, target.metadata);
      let truncated = false;
      if (markdown.length > READ_DOC_MAX_CHARS) {
        markdown = markdown.slice(0, READ_DOC_MAX_CHARS);
        truncated = true;
      }
      const nodes: Array<{ id: string; type: string; preview: string }> = [];
      const walk = (list: any[]) => {
        for (const n of list ?? []) {
          if (n.attrs?.id) {
            nodes.push({ id: n.attrs.id, type: n.type, preview: nodeTextPreview(n) });
          }
          if (n.content) walk(n.content);
        }
      };
      walk(target.document.content);
      const overlay = loadOverlay(target.docId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            title: target.title,
            docId: target.docId,
            wordCount: target.wordCount,
            pendingCount: target.pendingCount,
            truncated,
            markdown,
            nodes,
            pending: overlay.map((e) => ({ nodeId: e.nodeId, status: e.status, preview: entrySummary(e) })),
          }),
        }],
      };
    },
  },
  {
    name: 'read_workspace',
    description: 'List workspace documents with ids, titles, word counts, and active flag; plus workspace titles for campaign awareness.',
    parameters: { type: 'object', properties: {} },
    schema: {},
    execute: async () => {
      const docs = listDocuments().map((d) => {
        // Campaign awareness comes from frontmatter (spec §The four tools):
        // listDocuments() does not surface campaign/series, and extending
        // DocumentInfo for one consumer is not worth it — read each listing
        // file's frontmatter here instead.
        let metadata: Record<string, unknown> = {};
        try {
          const { data } = matter(readFileSync(d.path, 'utf-8'));
          metadata = {
            ...(data.campaign ? { campaign: data.campaign } : {}),
            ...(data.series ? { series: data.series } : {}),
            ...(data.contentType ? { contentType: data.contentType } : {}),
            ...(data.masterDocId ? { masterDocId: data.masterDocId } : {}),
            ...(data.variantType ? { variantType: data.variantType } : {}),
            ...(Array.isArray(data.tags) && data.tags.length > 0 ? { tags: data.tags } : {}),
          };
        } catch { /* unreadable file — empty metadata */ }
        return {
          docId: d.docId,
          title: d.title,
          wordCount: d.wordCount,
          lastModified: d.lastModified,
          isActive: d.isActive,
          metadata,
        };
      });
      const workspaces = listWorkspaces().map((w) => ({ title: w.title }));
      return { content: [{ type: 'text', text: JSON.stringify({ documents: docs, workspaces }) }] };
    },
  },
  {
    name: 'propose_edits',
    description: 'Propose document edits as pending changes the writer accepts or rejects in Review. One tool for one or many changes (1..n per call). Content is markdown. Use afterNodeId: "end" to append.',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              operation: { type: 'string', enum: ['rewrite', 'insert', 'delete'] },
              nodeId: { type: 'string' },
              afterNodeId: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['operation'],
          },
        },
      },
      required: ['changes'],
    },
    schema: {
      changes: z.array(z.object({
        operation: z.enum(['rewrite', 'insert', 'delete']),
        nodeId: z.string().optional(),
        afterNodeId: z.string().optional(),
        content: z.string().optional(),
      })).min(1),
    },
    execute: (args: any, ctx: ConductorContext) => proposeEdits(args, ctx),
  },
];

export const CONDUCTOR_TOOL_MAP: Record<string, ConductorToolDef> = Object.fromEntries(
  CONDUCTOR_TOOLS.map((t) => [t.name, t]),
);
export const CONDUCTOR_TOOL_NAMES = CONDUCTOR_TOOLS.map((t) => t.name);
