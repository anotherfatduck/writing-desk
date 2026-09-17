/**
 * Conductor loop — in-process agent loop driving the model-facing tools.
 * Ported from openwriter tests/spike-b/lib/conductor.mjs with the M3 deltas:
 * env triple fast-fail, in-process tools, zod validation, budgets, abort, transcript
 * persistence, progress callback, and Langfuse join metadata.
 */
import { z } from 'zod';
import { CONDUCTOR_TOOLS, CONDUCTOR_TOOL_NAMES } from './conductor-tools.js';
import type { ConductorToolResult } from './conductor-tools.js';
import { appendChatEvent, loadTranscript, readTitleInfo, writeTitleInfo, normalizeTitle, type ChatEvent } from './chat-sessions.js';
import { resolveLlmBaseUrl } from './deploy-env.js';
import { readStore, resolveStoreFile, resolveRuntimeDir, loadMasterKey } from '../shared/store.js';
import { buildChatSystemPrompt, CHAT_PERSONA_DEFAULT } from '../shared/chat-persona.js';

/** The assembled default prompt (neutral persona) — the storeless dev path;
 *  deployed hosts resolve the persona from the store at session start. */
export const CHAT_SYSTEM_PROMPT = buildChatSystemPrompt(CHAT_PERSONA_DEFAULT);

export interface ChatUsage { promptTokens: number; completionTokens: number; }

export interface TurnResult {
  assistantText: string;
  toolCalls: Array<{ name: string; summary: string; ok: boolean }>;
  finishReason: 'complete' | 'stopped' | 'budget-turns' | 'budget-calls' | 'budget-tokens' | 'error';
  error?: string;
  usage: ChatUsage;
}

export interface ChatRuntime {
  sessionId: string;
  docId: string;
  abort: AbortController;
  running: boolean;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: any[] }>;
  usage: ChatUsage;
}

/** Chat credentials: slot mode reads the requesting user's VK from the store
 * (M4d, spec §Editor slots); bare-slot dev runs keep the LLM_API_KEY env
 * fallback. Model + base stay config (env), never store — names are config. */
function userVk(): string | null {
  const userId = process.env.OW_USER_ID;
  if (!userId) return process.env.LLM_API_KEY || null;
  const store = readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()));
  return store?.users.find((u) => u.id === userId)?.vk ?? null;
}

/** The deployment's chat persona (store `chatPersona`). Null when the store
 *  is absent (bare-slot dev) or the field is unset — never 500 a chat over
 *  persona; same degrade-to-default pattern as the front door's siteName(). */
function chatPersona(): string | null {
  try {
    return readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()))?.chatPersona?.trim() || null;
  } catch {
    return null;
  }
}

function requireGatewayEnv(): { base: string; key: string; model: string } {
  const base = resolveLlmBaseUrl();
  const model = process.env.AGENT_MODEL;
  if (!base || !model) {
    throw new Error('Chat is not configured: set LLM_BASE_URL and AGENT_MODEL (the gateway alias — never a provider model id).');
  }
  const key = userVk();
  if (!key) {
    throw new Error('Chat is not configured: your writer has no model key yet — ask the admin to add one for you.');
  }
  return { base: base.replace(/\/$/, ''), key, model };
}

function readBudgets(): { maxTurns: number; maxCalls: number; maxTokens: number; maxOutputTokens: number } {
  return {
    maxTurns: parseInt(process.env.CHAT_MAX_TURNS ?? '12', 10),
    maxCalls: parseInt(process.env.CHAT_MAX_TOOL_CALLS ?? '60', 10),
    maxTokens: parseInt(process.env.CHAT_MAX_TOKENS ?? '400000', 10),
    // Per-request output cap sent as max_tokens. The controller route defaulted
    // server-side when the field was absent; the local route (local-model-xhigh)
    // internal-errors on absent max_tokens — the field is mandatory on the wire.
    maxOutputTokens: parseInt(process.env.CHAT_MAX_OUTPUT_TOKENS ?? '32768', 10),
  };
}

// ---- Thread naming (best-effort, cosmetic) ----
const TITLE_TIMEOUT_MS = 15000;
const TITLE_MAX_TOKENS = 32;
const TITLE_INPUT_CHARS = 600;

/** Names a thread after its first exchange: one small tool-less gateway call,
 *  result capped like a user rename. Writes the sidecar only when the writer
 *  hasn't already named the thread; any failure is silent — the first-message
 *  preview remains the fallback. Fired by the messages handler once the first
 *  turn has completed — the transcript already holds the assistant reply — but
 *  without await, so the turn response is never delayed. */
export async function generateSessionTitle(docId: string, sessionId: string): Promise<void> {
  const { base, key, model } = requireGatewayEnv();
  const events = loadTranscript(docId, sessionId);
  const writer = events.find((e): e is Extract<ChatEvent, { type: 'writer-message' }> => e.type === 'writer-message');
  if (!writer) return;
  const assistant = events.find((e): e is Extract<ChatEvent, { type: 'assistant-message' }> => e.type === 'assistant-message');
  const excerpt = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, TITLE_INPUT_CHARS);
  const transcriptExcerpt =
    `Writer: ${excerpt(writer.text)}` + (assistant ? `\n\nAssistant: ${excerpt(assistant.text)}` : '');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TITLE_TIMEOUT_MS);
  try {
    const response = await fetchTurnCompletion(base, key, {
      model,
      messages: [{
        role: 'user',
        content: `Below is the start of a chat between a writer and their writing assistant. Write a 3-6 word title naming what this conversation is about. Reply with the title only — no quotes, no trailing punctuation.\n\n${transcriptExcerpt}`,
      }],
      max_tokens: TITLE_MAX_TOKENS,
      metadata: { session_id: sessionId, doc_id: docId },
    }, ac.signal);
    const body = await response.json() as any;
    const title = normalizeTitle(String(body.choices?.[0]?.message?.content ?? ''));
    if (title && readTitleInfo(docId, sessionId) === null) {
      writeTitleInfo(docId, sessionId, { title, by: 'agent', at: new Date().toISOString() });
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---- Gateway resilience (2026-09-14 incident) ----
// Chat targets a best-effort route. Per gateway call: up to GATEWAY_ATTEMPTS
// tries with jittered exponential backoff (~1s base, ×2, cap 30s, abort-aware —
// Stop interrupts a sleep). Across calls: BREAKER_TRIP consecutive 5xx within
// BREAKER_WINDOW_MS opens the circuit for the cooldown — calls fail fast
// without touching the gateway; the next call after cooldown probes and a
// success re-arms. A failed turn surfaces as a chat error event (the writer
// retries by sending again); the loop never spins.
const GATEWAY_ATTEMPTS = 5;
const GATEWAY_BACKOFF_CAP_MS = 30000;
const BREAKER_WINDOW_MS = 30000;
const BREAKER_TRIP = 10;
const breaker = { fails: [] as number[], openUntil: 0 };

export function resetGatewayCircuitForTests(): void {
  breaker.fails = [];
  breaker.openUntil = 0;
}

function breakerCooldownMs(): number {
  return parseInt(process.env.CHAT_BREAKER_COOLDOWN_MS ?? '60000', 10);
}

async function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); };
    const cleanup = () => { clearTimeout(t); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort);
  });
}

async function fetchTurnCompletion(
  base: string,
  key: string,
  requestBody: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const now = Date.now();
  breaker.fails = breaker.fails.filter((t) => now - t <= BREAKER_WINDOW_MS);
  if (breaker.openUntil > now) {
    const left = Math.ceil((breaker.openUntil - now) / 1000);
    throw new Error(`gateway circuit open — ${breaker.fails.length} consecutive 5xx in 30s; cooldown ${left}s remaining`);
  }
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(requestBody),
      signal,
    });
    if (response.ok) {
      breaker.fails = [];
      breaker.openUntil = 0;
      return response;
    }
    if (response.status < 500) throw new Error(`gateway ${response.status}`);
    breaker.fails.push(Date.now());
    breaker.fails = breaker.fails.filter((t) => Date.now() - t <= BREAKER_WINDOW_MS);
    if (breaker.fails.length >= BREAKER_TRIP) breaker.openUntil = Date.now() + breakerCooldownMs();
    if (attempt >= GATEWAY_ATTEMPTS) {
      throw new Error(`gateway ${response.status} after ${GATEWAY_ATTEMPTS} attempts (backoff exhausted)`);
    }
    const baseMs = parseInt(process.env.CHAT_RETRY_BASE_MS ?? '1000', 10);
    const jitter = Math.floor(Math.random() * (baseMs / 2));
    await sleepMs(Math.min(GATEWAY_BACKOFF_CAP_MS, baseMs * 2 ** (attempt - 1)) + jitter, signal);
  }
}

export function startChat(docId: string, sessionId: string): ChatRuntime {
  requireGatewayEnv();
  const rt: ChatRuntime = {
    sessionId,
    docId,
    abort: new AbortController(),
    running: false,
    messages: [{ role: 'system', content: buildChatSystemPrompt(chatPersona()) }],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  for (const ev of loadTranscript(docId, sessionId)) {
    if (ev.type === 'writer-message') rt.messages.push({ role: 'user', content: ev.text });
    else if (ev.type === 'assistant-message') rt.messages.push({ role: 'assistant', content: ev.text });
  }
  return rt;
}

export function abortChat(rt: ChatRuntime): boolean {
  if (rt.abort.signal.aborted) return false;
  rt.abort.abort();
  return true;
}

export async function runChatTurn(
  rt: ChatRuntime,
  writerText: string,
  onProgress?: (line: string) => void,
): Promise<TurnResult> {
  const { base, key, model } = requireGatewayEnv();
  const { maxTurns, maxCalls, maxTokens, maxOutputTokens } = readBudgets();

  appendChatEvent(rt.docId, rt.sessionId, { type: 'writer-message', text: writerText } as any);
  rt.messages.push({ role: 'user', content: writerText });

  let turns = 0;
  let callsUsed = 0;
  let assistantText = '';
  const finishedCalls: TurnResult['toolCalls'] = [];
  let finishReason: TurnResult['finishReason'] | undefined;
  let error: string | undefined;

  rt.running = true;
  try {
    while (turns < maxTurns && callsUsed < maxCalls) {
      turns++;
      const requestBody = {
        model,
        messages: rt.messages,
        tools: CONDUCTOR_TOOLS.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto' as const,
        max_tokens: maxOutputTokens,
        metadata: { session_id: rt.sessionId, doc_id: rt.docId },
      };

      const response = await fetchTurnCompletion(base, key, requestBody, rt.abort.signal);

      if (!response.ok) {
        throw new Error(`gateway ${response.status}`);
      }

      const body = await response.json() as any;
      const message = body.choices?.[0]?.message;
      if (body.usage) {
        rt.usage.promptTokens += body.usage.prompt_tokens ?? 0;
        rt.usage.completionTokens += body.usage.completion_tokens ?? 0;
      }

      if (rt.usage.promptTokens + rt.usage.completionTokens >= maxTokens) {
        finishReason = 'budget-tokens';
        break;
      }

      const calls = message?.tool_calls ?? [];
      if (calls.length > 0) {
        rt.messages.push({ role: 'assistant', content: '', tool_calls: calls });
        for (const call of calls) {
          // Spec §Abort: check the flag between tool calls. A stop arriving
          // while a gateway response was pending must not let the rest of
          // this response's burst execute. Mirrors the AbortError catch below
          // (same finishReason + transcript event).
          if (rt.abort.signal.aborted) {
            finishReason = 'stopped';
            appendChatEvent(rt.docId, rt.sessionId, { type: 'session-ended', reason: 'stop', summary: 'Stopped by user.' } as any);
            break;
          }
          const toolName = call.function?.name as string | undefined;
          if (callsUsed >= maxCalls) {
            // Hard budget boundary: do not execute further calls in this response.
            finishReason = 'budget-calls';
            const skipMsg = 'budget: tool call skipped — CHAT_MAX_TOOL_CALLS reached';
            finishedCalls.push({ name: toolName ?? 'unknown', summary: skipMsg, ok: false });
            if (onProgress) onProgress(`${toolName ?? 'unknown'}: ${skipMsg}`);
            appendChatEvent(rt.docId, rt.sessionId, { type: 'tool-call', name: toolName ?? 'unknown', summary: skipMsg, ok: false } as any);
            rt.messages.push({ role: 'tool', tool_call_id: call.id, content: skipMsg });
            continue;
          }
          callsUsed++;
          const tool = toolName ? CONDUCTOR_TOOLS.find((t) => t.name === toolName) : undefined;
          let resultContent = '';
          let ok = false;
          let summary = '';
          let isTerminal = false;

          if (!tool) {
            resultContent = `unknown tool; available: ${CONDUCTOR_TOOL_NAMES.join(', ')}`;
          } else {
            let args: unknown;
            try {
              args = JSON.parse(call.function?.arguments ?? '{}');
            } catch (err: any) {
              resultContent = `invalid arguments: ${err.message}`;
            }
            if (args !== undefined) {
              const parsed = z.object(tool.schema).safeParse(args);
              if (!parsed.success) {
                const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
                resultContent = `schema-invalid call: ${issues}`;
              } else {
                const ctx = { sessionId: rt.sessionId, docId: rt.docId };
                const result: ConductorToolResult = await tool.execute(parsed.data, ctx);
                const text = result.content.map((c) => c.text).join('\n');
                // 4000-char truncation inherited from the audited fork harness.
                resultContent = text.slice(0, 4000);
                summary = text.slice(0, 120);
                ok = true;
                if (result.terminal) {
                  isTerminal = true;
                  finishReason = 'complete';
                }
              }
            }
          }

          finishedCalls.push({ name: toolName ?? 'unknown', summary: summary || (ok ? 'ok' : 'failed'), ok });
          if (onProgress) onProgress(`${toolName ?? 'unknown'}: ${summary || (ok ? 'ok' : 'failed')}`);
          appendChatEvent(rt.docId, rt.sessionId, { type: 'tool-call', name: toolName ?? 'unknown', summary: summary || (ok ? 'ok' : 'failed'), ok } as any);
          rt.messages.push({ role: 'tool', tool_call_id: call.id, content: resultContent });

          if (isTerminal) {
            const lastProse = [...rt.messages].reverse().find(
              (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content,
            );
            const endedSummary = (lastProse?.content as string) || 'Submitted for review.';
            appendChatEvent(rt.docId, rt.sessionId, { type: 'session-ended', reason: 'submit', summary: endedSummary } as any);
            break;
          }

          if (finishReason) break;
        }
        if (finishReason) break;
      } else {
        assistantText = message?.content ?? '';
        rt.messages.push({ role: 'assistant', content: assistantText });
        appendChatEvent(rt.docId, rt.sessionId, { type: 'assistant-message', text: assistantText } as any);
        finishReason = 'complete';
        break;
      }
    }

    if (!finishReason) {
      if (callsUsed >= maxCalls) finishReason = 'budget-calls';
      else if (turns >= maxTurns) finishReason = 'budget-turns';
    }

    if (finishReason?.startsWith('budget-')) {
      const summary = `Turns: ${turns}, tool calls: ${callsUsed}, tokens: ${rt.usage.promptTokens + rt.usage.completionTokens}.`;
      appendChatEvent(rt.docId, rt.sessionId, { type: 'session-ended', reason: 'budget', summary } as any);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      finishReason = 'stopped';
      appendChatEvent(rt.docId, rt.sessionId, { type: 'session-ended', reason: 'stop', summary: 'Stopped by user.' } as any);
    } else {
      finishReason = 'error';
      error = String(err?.message ?? err);
      appendChatEvent(rt.docId, rt.sessionId, { type: 'error', message: error } as any);
    }
  } finally {
    rt.running = false;
  }

  return {
    assistantText,
    toolCalls: finishedCalls,
    finishReason: finishReason ?? 'error',
    error,
    usage: { ...rt.usage },
  };
}
