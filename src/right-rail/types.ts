/**
 * Tab registry types. One entry per right-rail tab.
 * adr: adr/right-rail.md
 */
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { PendingDocsPayload } from '../ws/client';

/** Tab id — narrow string union so the registry can be exhaustively typed. */
export type TabId = 'review' | 'chat' | 'history' | 'help' | 'appearance';

/**
 * Scope determines which app state a tab reads from. The rail container does
 * NOT remount tab bodies on doc switch — doc-scoped tabs receive the new
 * filename/docId via props and decide whether to refetch.
 */
export type TabScope = 'doc' | 'workspace' | 'settings';

/** Props the rail container passes to every tab body. Each tab uses what it needs. */
export interface RightRailTabProps {
  editors: Editor[];
  pendingDocs: PendingDocsPayload;
  currentFilename: string;
  docId: string | null;
  /** Active doc's display title (App's title state) — for copy that names the article. */
  docTitle?: string;
  /** Agent-staged title rename for the active doc, or null if none staged.
   *  Owned by App so the value is consistent across surfaces (article title,
   *  Review panel). adr: adr/0005-pending-overlay-model.md */
  pendingTitle?: { from: string; to: string } | null;
  /** Text the writer selected in the editor and wants the companion to see.
   *  Set by the floating toolbar's Discuss button (via onDiscussSelection) or
   *  by clicking into the composer with a live selection; cleared by the
   *  chip's ✕ or consumed on send. Owned by App so the editor-side button and
   *  the chat-side chip stay in sync. */
  chatQuote?: { text: string; paraIds: string[] } | null;
  /** Attach a quote from the chat side (composer click captures the live editor selection). */
  onAttachChatQuote?: (quote: { text: string; paraIds: string[] }) => void;
  /** Remove the attached selection (chip ✕). */
  onClearChatQuote?: () => void;
  onSwitchDocument: (filename: string) => void;
  sendMessage: (msg: Record<string, any>) => void;
  getDocument: () => any;
  docVersionRef: React.RefObject<number>;
  /** Active doc's resolved content_type — lets the Review tab show controls for the active manuscript. */
  contentType?: string;
  /** Active manuscript's paragraph style ('spaced' | 'indented') from manuscriptContext. */
  manuscriptStyle?: string;
  /** Subscribe to live chat-progress lines from the server. App owns the single WS connection; tabs subscribe via this callback. */
  subscribeChatProgress?: (callback: (payload: { docId: string; sessionId: string; line: string }) => void) => () => void;
  /** Physician-gate state for the active doc, derived server-side from
   *  review.* frontmatter (M4c). Null = draft (no banner). The orchestrator
   *  is the only writer. */
  reviewGate?: { phase: 'submitted' | 'in-review' | 'published' | 'returned' | 'conflict'; since: string } | null;
  /** Findings text from the gate's return or conflict note — non-null while returned or conflict. */
  reviewNote?: string | null;
}

export interface TabDefinition {
  id: TabId;
  label: string;
  scope: TabScope;
  /** 16x16 inline SVG rendered in the tab strip. Tooltip uses `label`. */
  icon: ReactNode;
  /** The tab body. Receives the full prop bag; uses what it needs. */
  Component: (props: RightRailTabProps) => JSX.Element | null;
}
