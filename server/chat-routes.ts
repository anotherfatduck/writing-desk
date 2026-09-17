/**
 * Chat REST surface: sessions, turns, transcripts, stop.
 * One runtime per session per process; concurrent turns rejected with 409.
 */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'fs';
import {
  createChatSession,
  listChatSessions,
  loadTranscript,
  sessionEnded,
  transcriptPath,
  normalizeTitle,
  readTitleInfo,
  writeTitleInfo,
  type ChatSessionInfo,
} from './chat-sessions.js';
import { startChat, runChatTurn, abortChat, generateSessionTitle, type ChatRuntime, type TurnResult } from './conductor.js';
import { resolveDocId } from './documents.js';

export interface ChatRouteDeps {
  onProgress: (docId: string, sessionId: string, line: string) => void;
}

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();
  const runtimes = new Map<string, ChatRuntime>();

  function send404(res: Response, message: string): void {
    res.status(404).json({ error: message });
  }

  function sessionExists(docId: string, sessionId: string): boolean {
    try {
      return existsSync(transcriptPath(docId, sessionId));
    } catch {
      return false;
    }
  }

  router.post('/api/chat/:docId/sessions', (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const s = createChatSession(docId);
      res.status(201).json(s);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/api/chat/:docId/sessions', (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const sessions = listChatSessions(docId).reverse(); // newest-first
      res.json({ sessions });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get('/api/chat/:docId/sessions/:sessionId', (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const { sessionId } = req.params;
      if (!sessionExists(docId, sessionId)) {
        return send404(res, `Session not found: ${sessionId}`);
      }
      const events = loadTranscript(docId, sessionId);
      res.json({ events, ended: sessionEnded(docId, sessionId) });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.put('/api/chat/:docId/sessions/:sessionId/title', (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const { sessionId } = req.params;
      if (!sessionExists(docId, sessionId)) {
        return send404(res, `Session not found: ${sessionId}`);
      }
      const raw = req.body?.title;
      const title = typeof raw === 'string' ? normalizeTitle(raw) : null;
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      writeTitleInfo(docId, sessionId, { title, by: 'user', at: new Date().toISOString() });
      res.json({ sessionId, title, by: 'user' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/chat/:docId/sessions/:sessionId/stop', (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const { sessionId } = req.params;
      if (!sessionExists(docId, sessionId)) {
        return send404(res, `Session not found: ${sessionId}`);
      }
      const rt = runtimes.get(sessionId);
      if (!rt || !rt.running) {
        res.json({ stopped: false });
        return;
      }
      const stopped = abortChat(rt);
      res.json({ stopped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/chat/:docId/sessions/:sessionId/messages', async (req: Request, res: Response) => {
    try {
      const docId = req.params.docId;
      resolveDocId(docId); // validate existence
      const { sessionId } = req.params;
      const text = req.body?.text;
      if (typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      if (!sessionExists(docId, sessionId)) {
        return send404(res, `Session not found: ${sessionId}`);
      }
      if (sessionEnded(docId, sessionId)) {
        // Distinct from 409 ("turn in progress", transient — the UI self-
        // corrects). 410 says the session is OVER; the composer disables
        // itself instead of retrying. A post-submit message must not flip
        // the session back to open in listings.
        res.status(410).json({ error: 'session has ended' });
        return;
      }

      const existing = runtimes.get(sessionId);
      if (existing?.running) {
        res.status(409).json({ error: 'turn in progress' });
        return;
      }

      let rt: ChatRuntime;
      try {
        rt = startChat(docId, sessionId);
      } catch (startErr: any) {
        res.status(503).json({ error: startErr.message });
        return;
      }
      runtimes.set(sessionId, rt);

      const turn: TurnResult = await runChatTurn(rt, text, (line: string) => {
        deps.onProgress(docId, sessionId, line);
      });

      if (sessionEnded(docId, sessionId)) {
        runtimes.delete(sessionId);
      }

      const events = loadTranscript(docId, sessionId);
      // Thread naming: the first turn just completed — `events` above is the
      // post-turn transcript, so the naming prompt sees the assistant reply.
      // Fire precondition (spec): first turn only AND no sidecar exists — a
      // session the writer already named is left alone (no wasted round-trip).
      // Fire-and-forget: the response below never waits on it. Silent on failure.
      // The naming call shares this module's gateway breaker with turn calls
      // (spec-mandated): a flaky gateway during naming can contribute to opening
      // the circuit for the next turn; cosmetic failures stop once it is open.
      if (events.filter((e) => e.type === 'writer-message').length === 1 && readTitleInfo(docId, sessionId) === null) {
        generateSessionTitle(docId, sessionId).catch(() => { /* cosmetic — stay silent */ });
      }
      res.json({ turn, events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
