/**
 * Chat session store — _chats/{docId}/{session}.jsonl transcripts.
 * Dual role: outage/crash resume source and provenance record. The app has no
 * git; the orchestrator (M4) commits these files to the article branch.
 */
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, renameSync } from 'fs';
import { getDataDir } from './helpers.js';

export type ChatEvent =
  | { ts: string; type: 'writer-message'; text: string }
  | { ts: string; type: 'assistant-message'; text: string }
  | { ts: string; type: 'tool-call'; name: string; summary: string; ok: boolean }
  | { ts: string; type: 'session-ended'; reason: 'submit' | 'budget' | 'stop'; summary: string }
  | { ts: string; type: 'error'; message: string };

export interface ChatSessionInfo { sessionId: string; docId: string; startedAt: string; ended: boolean; title: string | null; preview: string; }

export interface ChatTitleInfo { title: string; by: 'user' | 'agent'; at: string; }

const SESSION_ID_RE = /^[0-9a-f]{8}$/;

/** Trim, collapse whitespace runs to single spaces, cap at 80 chars. Blank → null. */
export function normalizeTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return t || null;
}

export function titlePath(docId: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(docId) || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid docId or sessionId: ${docId}/${sessionId}`);
  }
  return join(getDataDir(), '_chats', docId, `${sessionId}.title.json`);
}

export function readTitleInfo(docId: string, sessionId: string): ChatTitleInfo | null {
  try {
    return JSON.parse(readFileSync(titlePath(docId, sessionId), 'utf-8')) as ChatTitleInfo;
  } catch {
    return null; // absent or unreadable → untitled
  }
}

export function writeTitleInfo(docId: string, sessionId: string, info: ChatTitleInfo): void {
  const p = titlePath(docId, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, p); // atomic — a listing never reads a half-written sidecar
}

export function transcriptPath(docId: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(docId) || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid docId or sessionId: ${docId}/${sessionId}`);
  }
  return join(getDataDir(), '_chats', docId, `${sessionId}.jsonl`);
}

export function createChatSession(docId: string): ChatSessionInfo {
  const sessionId = randomUUID().replace(/-/g, '').slice(0, 8);
  const p = transcriptPath(docId, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', { flag: 'wx' });
  return { sessionId, docId, startedAt: new Date().toISOString(), ended: false, title: null, preview: '' };
}

export function loadTranscript(docId: string, sessionId: string): ChatEvent[] {
  const p = transcriptPath(docId, sessionId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function appendChatEvent(docId: string, sessionId: string, event: Omit<ChatEvent, 'ts'>): ChatEvent {
  const stamped = { ...event, ts: new Date().toISOString() } as ChatEvent;
  const p = transcriptPath(docId, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(stamped) + '\n', { flag: 'a' });
  return stamped;
}

export function sessionEnded(docId: string, sessionId: string): boolean {
  const events = loadTranscript(docId, sessionId);
  return events.length > 0 && events[events.length - 1].type === 'session-ended';
}

function firstWriterText(docId: string, sessionId: string): string {
  for (const ev of loadTranscript(docId, sessionId)) {
    if (ev.type === 'writer-message') return ev.text;
  }
  return '';
}

export function listChatSessions(docId: string): ChatSessionInfo[] {
  if (!SESSION_ID_RE.test(docId)) return [];
  const dir = join(getDataDir(), '_chats', docId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && SESSION_ID_RE.test(f.replace(/\.jsonl$/, '')))
    .map((f) => {
      const stat = statSync(join(dir, f));
      return { f, size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
    })
    .filter(({ size }) => size > 0) // never-used sessions (abandoned "New chat") stay invisible
    .sort((a, b) => a.mtimeMs - b.mtimeMs) // random ids — mtime is the only age order
    .map(({ f, mtime }) => {
      const sessionId = f.replace(/\.jsonl$/, '');
      const preview = firstWriterText(docId, sessionId).replace(/\s+/g, ' ').trim().slice(0, 120);
      return {
        sessionId,
        docId,
        startedAt: new Date(mtime).toISOString(),
        ended: sessionEnded(docId, sessionId),
        title: readTitleInfo(docId, sessionId)?.title ?? null,
        preview,
      };
    });
}
