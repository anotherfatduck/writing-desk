import { useEffect, useRef, useState } from 'react';
import type { RightRailTabProps } from '../types';
import { collectSelectionQuote } from '../../editor/selection-quote';
import { SessionPicker, displayName } from './SessionPicker';

// Mirror of server/chat-sessions.ts ChatEvent union (client tsconfig is DOM-only).
type ChatEvent =
  | { ts: string; type: 'writer-message'; text: string }
  | { ts: string; type: 'assistant-message'; text: string }
  | { ts: string; type: 'tool-call'; name: string; summary: string; ok: boolean }
  | { ts: string; type: 'session-ended'; reason: 'submit' | 'budget' | 'stop'; summary: string }
  | { ts: string; type: 'error'; message: string };

interface ChatSessionInfo {
  sessionId: string;
  docId: string;
  startedAt: string;
  ended: boolean;
  title: string | null;
  preview: string;
}

interface TurnResponse {
  turn: {
    assistantText: string;
    toolCalls: Array<{ name: string; summary: string; ok: boolean }>;
    finishReason: string;
    error?: string;
  };
  events: ChatEvent[];
}

interface SessionsResponse {
  sessions: ChatSessionInfo[];
}

interface TranscriptResponse {
  events: ChatEvent[];
  ended: boolean;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function apiPath(docId: string, suffix: string): string {
  return `/api/chat/${encodeURIComponent(docId)}${suffix}`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // fall through
  }
  return res.statusText || `HTTP ${res.status}`;
}

export function ChatTab({ docId, currentFilename, subscribeChatProgress, editors, chatQuote, onAttachChatQuote, onClearChatQuote }: RightRailTabProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<ChatEvent[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [allSessions, setAllSessions] = useState<ChatSessionInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  // Doc-level auto-accept (frontmatter): when on, the companion's changes
  // commit directly instead of waiting in the pending overlay.
  const [autoAccept, setAutoAccept] = useState<boolean | null>(null);

  // Load latest session + transcript whenever the active doc changes.
  useEffect(() => {
    setMessages([]);
    setSessionId(null);
    setPickerOpen(false);
    setAllSessions([]);
    setProgress([]);
    setError(null);
    setRunning(false);
    setSessionEnded(false);

    if (!docId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch(apiPath(docId, '/sessions'))
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseError(res));
        const data: SessionsResponse = await res.json();
        if (cancelled) return;
        setAllSessions(data.sessions);
        if (data.sessions.length > 0) {
          const latest = data.sessions[0].sessionId;
          setSessionId(latest);
          setSessionEnded(Boolean(data.sessions[0].ended));
          return loadTranscript(latest);
        }
      })
      .then((events) => {
        if (cancelled) return;
        if (events) setMessages(events);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [docId, currentFilename]);

  // Subscribe to App-owned WS progress lines and accumulate those for the active session.
  useEffect(() => {
    if (!subscribeChatProgress || !docId) return;
    const unsubscribe = subscribeChatProgress((payload) => {
      if (payload.docId !== docId) return;
      if (payload.sessionId !== sessionIdRef.current) return;
      setProgress((prev) => [...prev, payload.line]);
    });
    return unsubscribe;
  }, [subscribeChatProgress, docId]);

  // Clear progress when the active session changes.
  useEffect(() => {
    setProgress([]);
  }, [sessionId]);

  // Load the doc's auto-accept flag whenever the active doc changes.
  const prevDocId = useRef<string | null>(null);
  useEffect(() => {
    setAutoAccept(null);
    // A selection quote belongs to the doc it was made in — drop it on switch
    // (but keep one set at mount: the floating toolbar's Discuss button lands
    // here with the quote already attached).
    if (prevDocId.current !== null && prevDocId.current !== docId) onClearChatQuote?.();
    prevDocId.current = docId;
    if (!docId) return;
    let cancelled = false;
    fetch('/api/document')
      .then(async (res) => (res.ok ? res.json() : null))
      .then((d) => { if (!cancelled && d) setAutoAccept(d.metadata?.autoAccept === true); })
      .catch(() => { /* toggle stays hidden */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, currentFilename]);

  async function toggleAutoAccept(next: boolean) {
    if (!docId) return;
    const prev = autoAccept;
    setAutoAccept(next); // optimistic; revert on failure
    try {
      const res = await fetch('/api/document/metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoAccept: next }),
      });
      if (!res.ok) throw new Error(await parseError(res));
    } catch (err: any) {
      setAutoAccept(prev);
      setError(err.message);
    }
  }

  async function loadTranscript(sid: string): Promise<ChatEvent[]> {
    if (!docId) return [];
    const res = await fetch(apiPath(docId, `/sessions/${encodeURIComponent(sid)}`));
    if (!res.ok) throw new Error(await parseError(res));
    const data: TranscriptResponse = await res.json();
    return data.events;
  }

  async function createSession(): Promise<string> {
    if (!docId) throw new Error('No active document');
    const res = await fetch(apiPath(docId, '/sessions'), { method: 'POST' });
    if (!res.ok) throw new Error(await parseError(res));
    const s: ChatSessionInfo = await res.json();
    setAllSessions((prev) => [s, ...prev]);
    setSessionId(s.sessionId);
    setMessages([]);
    setSessionEnded(false);
    return s.sessionId;
  }

  async function sendText(text: string) {
    if (!docId || running) return;
    setError(null);
    setRunning(true);
    setProgress([]);

    let sid = sessionId;
    try {
      if (!sid) {
        sid = await createSession();
      }

      const res = await fetch(apiPath(docId, `/sessions/${encodeURIComponent(sid)}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        if (res.status === 410) {
          setSessionEnded(true);
          setRunning(false);
          setProgress([]);
          return;
        }
        const message = await parseError(res);
        setMessages((prev) => [
          ...prev,
          { ts: new Date().toISOString(), type: 'error', message },
        ]);
        setRunning(false);
        setProgress([]);
        return;
      }

      const data: TurnResponse = await res.json();
      setMessages(data.events);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(false);
      setProgress([]);
    }
  }

  async function stopTurn() {
    if (!docId || !sessionId) return;
    setRunning(false);
    try {
      const res = await fetch(apiPath(docId, `/sessions/${encodeURIComponent(sessionId)}/stop`), {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await parseError(res));
      const events = await loadTranscript(sessionId);
      setMessages(events);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProgress([]);
    }
  }

  async function refetchSessions(): Promise<ChatSessionInfo[]> {
    if (!docId) return [];
    const res = await fetch(apiPath(docId, '/sessions'));
    if (!res.ok) return [];
    const data: SessionsResponse = await res.json();
    setAllSessions(data.sessions);
    return data.sessions;
  }

  function openPicker() {
    setError(null);
    setPickerOpen(true);
    void refetchSessions(); // fresh titles — agent naming lands between opens
  }

  function handleOpenSession(sessionId: string) {
    const s = allSessions.find((x) => x.sessionId === sessionId);
    setPickerOpen(false);
    setSessionId(sessionId);
    setProgress([]);
    setError(null);
    setRunning(false);
    setSessionEnded(Boolean(s?.ended));
    setMessages([]);
    loadTranscript(sessionId)
      .then(setMessages)
      .catch((err: any) => setError(err.message));
  }

  async function handleRename(sid: string, title: string): Promise<boolean> {
    if (!docId) return false;
    try {
      const res = await fetch(apiPath(docId, `/sessions/${encodeURIComponent(sid)}/title`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      const body = await res.json();
      setAllSessions((prev) => prev.map((s) => (s.sessionId === sid ? { ...s, title: body.title } : s)));
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  function handleNewChat() {
    if (!docId) return;
    setError(null);
    setPickerOpen(false);
    setSessionEnded(false);
    // Lazy: no session exists until the first message sends (sendText mints it).
    setSessionId(null);
    setMessages([]);
    setProgress([]);
  }

  // Clicking into the composer while the editor holds a selection attaches
  // that selection as a quote — the highlight itself dies on the click, but
  // the chip carries it so the writer can still "tell the agent what I
  // selected". Only a LIVE editor selection counts (hasFocus guards against
  // ProseMirror's stale internal selection after blur); ✕ clears.
  function handleComposerMouseDown() {
    const ed = editors[0];
    if (!ed || !ed.view.hasFocus() || !onAttachChatQuote) return;
    const quote = collectSelectionQuote(ed);
    if (!quote) return;
    if (chatQuote && chatQuote.text === quote.text && chatQuote.paraIds.join() === quote.paraIds.join()) return;
    onAttachChatQuote(quote);
  }

  // New quote (toolbar Discuss or composer click) → ready to type the ask.
  useEffect(() => {
    if (chatQuote) inputRef.current?.focus();
  }, [chatQuote]);

  /** Writer's instruction + the quoted selection (blockquote) + the node ids
   *  the companion's propose_edits can anchor to. Quote-less sends pass through. */
  function composedText(raw: string): string {
    if (!chatQuote) return raw;
    const quoted = chatQuote.text.split('\n').map((l) => `> ${l}`).join('\n');
    const ids = chatQuote.paraIds.length > 0 ? `\n(selected paragraphs: ${chatQuote.paraIds.join(', ')})` : '';
    return `${raw}\n\n${quoted}${ids}`;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = input.trim();
      if (trimmed && !running && docId) {
        setInput('');
        const text = composedText(trimmed);
        onClearChatQuote?.();
        sendText(text);
      }
    }
  }

  const currentSession = allSessions.find((s) => s.sessionId === sessionId) ?? null;
  const composerDisabled = !docId || running || sessionEnded;

  return (
    <div className="chat-tab">
      <div className="chat-tab__header">
        <button
          type="button"
          className="chat-tab__header-btn"
          onClick={handleNewChat}
          disabled={!docId}
        >
          New chat
        </button>
        <button
          type="button"
          className={`chat-tab__header-btn chat-tab__header-btn--secondary${pickerOpen ? ' chat-tab__header-btn--compact' : ''}`}
          onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
          disabled={!docId}
        >
          {pickerOpen
            ? 'Back to chat'
            : currentSession
              ? displayName(currentSession)
              : 'Chats'}
        </button>
      </div>

      {!pickerOpen && docId && autoAccept !== null && (
        <label
          className="chat-tab__auto-accept"
          title="When on, the companion's changes apply to the page immediately — you edit afterwards as usual. When off, every change waits for your approval."
        >
          <input
            type="checkbox"
            checked={autoAccept}
            onChange={(e) => toggleAutoAccept(e.target.checked)}
          />
          Let the companion edit directly
        </label>
      )}

      {pickerOpen ? (
        <SessionPicker
          sessions={allSessions}
          currentSessionId={sessionId}
          onOpen={handleOpenSession}
          onRename={handleRename}
        />
      ) : (
        <>
        <div className="chat-tab__messages">
          {!docId ? (
            <div className="chat-tab__empty">
              <p>Open a document to start chatting.</p>
            </div>
          ) : loading ? (
            <div className="chat-tab__empty">
              <p>Loading…</p>
            </div>
          ) : messages.length === 0 && progress.length === 0 ? (
            <div className="chat-tab__empty">
              <p>Start a conversation</p>
            </div>
          ) : (
            messages.map((ev, i) => {
              switch (ev.type) {
                case 'writer-message':
                  return (
                    <div key={`${ev.ts}-${i}`} className="chat-tab__message chat-tab__message--writer">
                      <div className="chat-tab__bubble chat-tab__bubble--writer">
                        <div className="chat-tab__meta">{formatTime(ev.ts)} · You</div>
                        <div className="chat-tab__text">{ev.text}</div>
                      </div>
                    </div>
                  );
                case 'assistant-message':
                  return (
                    <div key={`${ev.ts}-${i}`} className="chat-tab__message chat-tab__message--assistant">
                      <div className="chat-tab__bubble chat-tab__bubble--assistant">
                        <div className="chat-tab__meta">{formatTime(ev.ts)} · Assistant</div>
                        <div className="chat-tab__text">{ev.text}</div>
                      </div>
                    </div>
                  );
                case 'tool-call':
                  return (
                    <div key={`${ev.ts}-${i}`} className="chat-tab__tool-call">
                      <span className={`chat-tab__tool-dot${ev.ok ? '' : ' chat-tab__tool-dot--error'}`} />
                      <span className="chat-tab__tool-text">{ev.summary}</span>
                    </div>
                  );
                case 'session-ended':
                  return (
                    <div key={`${ev.ts}-${i}`} className="chat-tab__ended">
                      <span className="chat-tab__ended-line" />
                      <span className="chat-tab__ended-text">
                        Session ended: {ev.reason}{ev.summary ? ` — ${ev.summary}` : ''}
                      </span>
                      <span className="chat-tab__ended-line" />
                    </div>
                  );
                case 'error':
                  return (
                    <div key={`${ev.ts}-${i}`} className="chat-tab__message chat-tab__message--system">
                      <div className="chat-tab__bubble chat-tab__bubble--system">
                        {ev.message}
                      </div>
                    </div>
                  );
                default:
                  return null;
              }
            })
          )}

          {progress.length > 0 && (
            <div className="chat-tab__progress">
              {progress.map((line, i) => (
                <div key={`${line}-${i}`} className="chat-tab__progress-line">
                  <span className="chat-tab__progress-dot" />
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>

        {sessionEnded ? (
          <div className="chat-ended-note">Session ended — start a new chat to continue.</div>
        ) : (
          <div className="chat-tab__composer">
            {chatQuote && (
              <div className="chat-tab__quote" title="This selection rides along with your next message">
                <span className="chat-tab__quote-label">Selected:</span>
                <span className="chat-tab__quote-text">"{chatQuote.text.length > 80 ? `${chatQuote.text.slice(0, 80)}…` : chatQuote.text}"</span>
                <button
                  type="button"
                  className="chat-tab__quote-clear"
                  onClick={onClearChatQuote}
                  title="Remove the selection from your next message"
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              className="chat-tab__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onMouseDown={handleComposerMouseDown}
              placeholder={docId ? 'Ask the assistant… (Enter to send, Shift+Enter for newline)' : 'Open a document to chat'}
              disabled={composerDisabled}
              rows={3}
            />
            <div className="chat-tab__actions">
              {running ? (
                <button type="button" className="chat-tab__send-btn chat-tab__send-btn--stop" onClick={stopTurn}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-tab__send-btn"
                  onClick={() => {
                    const trimmed = input.trim();
                    if (trimmed && docId) {
                      setInput('');
                      const text = composedText(trimmed);
                      onClearChatQuote?.();
                      sendText(text);
                    }
                  }}
                  disabled={!input.trim() || !docId}
                >
                  Send
                </button>
              )}
            </div>
            {error && !running && (
              <div className="chat-tab__composer-error">{error}</div>
            )}
          </div>
        )}
        </>
      )}
    </div>
  );
}
