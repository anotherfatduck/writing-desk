import { useEffect, useRef, useState } from 'react';

/** Mirror of ChatSessionInfo (server/chat-sessions.ts) — picker needs only these. */
export interface PickerSession {
  sessionId: string;
  startedAt: string;
  ended: boolean;
  title: string | null;
  preview: string;
}

interface SessionPickerProps {
  sessions: PickerSession[]; // newest-first (server order)
  currentSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<boolean>;
}

export function displayName(s: PickerSession): string {
  return s.title || s.preview || 'Untitled chat';
}

/** Codex-style relative age: "12h", "2d", locale date beyond a week. */
function relativeAge(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/** Chats panel for the article: title left, relative age right, rename on
 *  hover, current row highlighted. Replaces the messages area while open. */
export function SessionPicker({ sessions, currentSessionId, onOpen, onRename }: SessionPickerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  async function saveRename(sessionId: string) {
    const next = draft;
    setEditingId(null);
    if (!next.trim()) return; // blank edit = cancel
    await onRename(sessionId, next);
  }

  return (
    <div className="chat-picker">
      <div className="chat-picker__top">
        <span className="chat-picker__label">Chats</span>
      </div>
      {sessions.length === 0 ? (
        <div className="chat-tab__empty">
          <p>No chats yet.</p>
        </div>
      ) : (
        <div className="chat-picker__list">
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`chat-picker__row${s.sessionId === currentSessionId ? ' chat-picker__row--current' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => { if (editingId !== s.sessionId) onOpen(s.sessionId); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && editingId !== s.sessionId) onOpen(s.sessionId); }}
            >
              {editingId === s.sessionId ? (
                <input
                  ref={inputRef}
                  className="chat-picker__rename"
                  value={draft}
                  autoFocus
                  maxLength={80}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void saveRename(s.sessionId); }
                    if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                  }}
                  onBlur={() => void saveRename(s.sessionId)}
                />
              ) : (
                <>
                  <span className="chat-picker__title" title={displayName(s)}>{displayName(s)}</span>
                  <span className="chat-picker__meta">
                    {s.ended && <span className="chat-picker__ended">ended</span>}
                    <span className="chat-picker__age">{relativeAge(s.startedAt)}</span>
                    <button
                      type="button"
                      className="chat-picker__rename-btn"
                      title="Rename this chat"
                      onClick={(e) => { e.stopPropagation(); setEditingId(s.sessionId); setDraft(displayName(s)); }}
                    >
                      ✎
                    </button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
