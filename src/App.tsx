import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import PadEditor from './editor/PadEditor';
import FormatToolbar from './editor/FormatToolbar';
import Sidebar from './sidebar/Sidebar';
import './sidebar/sidebar-styles.css';
import { useRightRail } from './right-rail/RightRailContext';
import RightRail from './right-rail/RightRail';
import Titlebar from './titlebar/Titlebar';
import { useWebSocket, type PendingDocsPayload, type NodeChange, type IdRewrite, type DocumentReloadedPayload } from './ws/client';
import { applyNodeChangesToEditor, applyIdRewritesToEditor } from './decorations/bridge';
import './decorations/styles.css';
import TourOverlay from './tour/TourOverlay';
import { hasSeenTour } from './tour/tour-state';
import { showToast } from './utils/toast';

export default function App() {
  const editorRef = useRef<Editor | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [title, setTitle] = useState('Untitled');
  const [initialContent, setInitialContent] = useState<any>(undefined);
  const [activeFilename, setActiveFilename] = useState('');
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  // M4c: physician-gate visibility (spec §App rendering). The gate state and
  // findings note come from one local route; the client only renders. The
  // orchestrator's stamp write on the doc file triggers the reload that
  // refreshes metadata — its JSON signature is the fetch trigger, so the
  // refetch fires exactly on stamp changes (and once on load), never on
  // unrelated re-renders, and a setState from the fetch can't loop the effect.
  type ReviewGateState = { phase: 'submitted' | 'in-review' | 'published' | 'returned' | 'conflict'; since: string };
  const [gateState, setGateState] = useState<{ gate: ReviewGateState | null; note: string | null }>({ gate: null, note: null });
  const reviewSig = JSON.stringify((metadata as any)?.review ?? null);
  useEffect(() => {
    let live = true;
    fetch('/api/review-gate', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (live) setGateState({ gate: d.gate ?? null, note: d.note ?? null }); })
      .catch(() => { if (live) setGateState({ gate: null, note: null }); });
    return () => { live = false; };
  }, [reviewSig]);
  const reviewGate = gateState.gate;
  const reviewNote = reviewGate?.phase === 'returned' || reviewGate?.phase === 'conflict' ? gateState.note : null;
  const [pendingDocs, setPendingDocs] = useState<PendingDocsPayload>({ filenames: [], counts: {} });
  const [refreshKey, setRefreshKey] = useState(0);
  // The Library shelf is a second listing the sidebar renders; the server
  // pushes `library-changed` on every shelf change (mirror write, adopt,
  // restore), which bumps this key and re-reads /api/library.
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [showToolbar, setShowToolbar] = useState(() => localStorage.getItem('ow-toolbar') !== 'hidden');
  const [pendingTitle, setPendingTitle] = useState<{ from: string; to: string } | null>(null);
  // Text the writer selected in the editor and wants the companion to see.
  // Set by the floating toolbar's Discuss button or by clicking into the chat
  // composer with a live selection; cleared by the chip's ✕ or on send.
  // Owned by App so the editor-side button and the chat-side chip stay in sync.
  const [chatQuote, setChatQuote] = useState<{ text: string; paraIds: string[] } | null>(null);
  const [writing, setWriting] = useState<{ title: string; target: { wsFilename: string; containerId: string | null; parentDocId?: string } | null } | null>(null);

  // Shell state from the openwriter fork (Task 3). Width is persisted so the
  // sidebar column keeps its size across reloads; focus mode snapshots the
  // sidebar + toolbar intent and restores it on exit.
  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_MAX_WIDTH = 600;
  const SIDEBAR_DEFAULT_WIDTH = 260;
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [tourUserId, setTourUserId] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(false);

  // Stable identity: TourOverlay's per-step setup effect depends on
  // onEnsureSidebar, so a fresh arrow here would re-run the effect (and, on
  // step 5, re-call openTab) on every App render.
  const ensureSidebar = useCallback(() => setSidebarOpen(true), []);

  useEffect(() => {
    fetch('/api/session').then(r => r.ok ? r.json() : null).then(j => {
      const uid = j?.user?.id;
      if (!uid) return;
      setTourUserId(uid);
      if (!hasSeenTour(uid)) setTourOpen(true);
    }).catch(() => { /* session unavailable — no tour */ });
  }, []);

  // Help tab "Replay the tour" (Task 4 dispatches this).
  useEffect(() => {
    const replay = () => {
      // Session fetch failed earlier → tourUserId is null and the overlay
      // would silently no-op (final-review minor). Surface it instead.
      if (!tourUserId) { showToast('Tour unavailable — session not loaded. Try reloading.', 'error'); return; }
      setTourOpen(true);
    };
    window.addEventListener('ow-replay-tour', replay);
    return () => window.removeEventListener('ow-replay-tour', replay);
  }, [tourUserId]);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('ow-sidebar-width');
      if (saved) {
        const n = parseInt(saved, 10);
        if (!isNaN(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) return n;
      }
    } catch { /* storage denied */ }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [focusMode, setFocusMode] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const markSaved = useCallback(() => {
    setSaveState('saved');
    setLastSavedAt(new Date().toISOString());
  }, []);
  const focusSnapshotRef = useRef<{ sidebarOpen: boolean; showToolbar: boolean } | null>(null);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((cur) => {
      if (!cur) {
        // Entering focus mode — snapshot sidebar + toolbar, close both.
        focusSnapshotRef.current = { sidebarOpen, showToolbar };
        setSidebarOpen(false);
        setShowToolbar(false);
        return true;
      }
      // Exiting — restore snapshot if we have one.
      const snap = focusSnapshotRef.current;
      if (snap) {
        setSidebarOpen(snap.sidebarOpen);
        setShowToolbar(snap.showToolbar);
        focusSnapshotRef.current = null;
      }
      return false;
    });
  }, [sidebarOpen, showToolbar]);

  const chatSubscribersRef = useRef<Set<(payload: { docId: string; sessionId: string; line: string }) => void>>(new Set());
  const subscribeChatProgress = useCallback((callback: (payload: { docId: string; sessionId: string; line: string }) => void) => {
    chatSubscribersRef.current.add(callback);
    return () => { chatSubscribersRef.current.delete(callback); };
  }, []);

  const { setOverlay: setRailOverlay, openTab: openRailTab } = useRightRail();

  const discussSelection = useCallback((quote: { text: string; paraIds: string[] }) => {
    setChatQuote(quote);
    openRailTab('chat');
  }, [openRailTab]);

  const lastDocJson = useRef<any>(null);
  const lastSentDocJson = useRef<string | null>(null);
  const docUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentFilename = useRef<string>('');

  useEffect(() => {
    setRailOverlay(false);
  }, [setRailOverlay]);

  useEffect(() => {
    fetch('/api/document', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.document) {
          setInitialContent(data.document);
          lastDocJson.current = data.document;
          lastSentDocJson.current = JSON.stringify(data.document);
        }
        if (data.title) setTitle(data.title);
        if (data.metadata) setMetadata(data.metadata);
        if (data.filename) {
          currentFilename.current = data.filename;
          setActiveFilename(data.filename);
        }
      })
      .catch(() => {
        setInitialContent(undefined);
      });

    fetch('/api/pending-docs')
      .then((res) => res.json())
      .then((data) => setPendingDocs(data))
      .catch(() => {});
  }, []);

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorInstance(editor);
  }, []);

  const handleDocumentSwitched = useCallback((payload: { document: any; title: string; filename: string; docId?: string; metadata?: Record<string, any>; pendingMetadata?: { title?: { from: string; to: string } } | null }) => {
    lastDocJson.current = payload.document;
    lastSentDocJson.current = JSON.stringify(payload.document);
    currentFilename.current = payload.filename;
    setActiveFilename(payload.filename);
    setInitialContent(payload.document);
    setTitle(payload.title);
    setMetadata(payload.metadata || {});
    setPendingTitle(payload.pendingMetadata?.title ?? null);
    if (expectingCreateRef.current) {
      expectingCreateRef.current = false;
      setRefreshKey(k => k + 1);
    }
  }, []);

  // Mid-turn pushes from the conductor. The appliers are batched
  // (single transaction = one decoration rebuild = one DOM render) and
  // never throw; the server only emits node-changes for the server-active
  // doc, so application is inherently active-doc-scoped. The editor is
  // read through the ref, not state, to avoid stale closures.
  // adr: adr/node-identity-matcher.md
  const handleNodeChanges = useCallback((changes: NodeChange[]) => {
    if (editorRef.current) applyNodeChangesToEditor(editorRef.current, changes);
  }, []);

  const handleIdRewrites = useCallback((rewrites: IdRewrite[]) => {
    if (editorRef.current) applyIdRewritesToEditor(editorRef.current, rewrites);
  }, []);

  // External write detected: the server reloaded the active doc from disk
  // and broadcast the new state. Adopt wholesale — same shape as
  // handleDocumentSwitched. DocumentReloadedPayload carries no
  // pendingMetadata, so pendingTitle is left alone. orphanCount /
  // staleBaselineCount are informational — no toast this pass (YAGNI).
  // adr: adr/active-doc-watcher.md
  const handleDocumentReloaded = useCallback((payload: DocumentReloadedPayload) => {
    lastDocJson.current = payload.document;
    lastSentDocJson.current = JSON.stringify(payload.document);
    currentFilename.current = payload.filename;
    setActiveFilename(payload.filename);
    setInitialContent(payload.document);
    setTitle(payload.title);
    setMetadata(payload.metadata || {});
    // The reload's new review metadata also changes the docs list's
    // reviewGate (sidebar lifecycle chip) — bump the refetch so the chip
    // keeps pace with the banner on orchestrator stamps.
    setRefreshKey(k => k + 1);
  }, []);

  const { connected, sendMessage, docVersionRef } = useWebSocket({
    onDocumentSwitched: handleDocumentSwitched,
    onNodeChanges: handleNodeChanges,
    onIdRewrites: handleIdRewrites,
    onDocumentReloaded: handleDocumentReloaded,
    onDocumentsChanged: () => setRefreshKey(k => k + 1),
    onLibraryChanged: () => setLibraryRefreshKey(k => k + 1),
    onPendingDocsChanged: setPendingDocs,
    onTitleChanged: setTitle,
    onMetadataChanged: setMetadata,
    onWritingStarted: (title, target) => setWriting({ title, target }),
    onWritingFinished: () => setWriting(null),
    onChatProgress: useCallback((payload: { docId: string; sessionId: string; line: string }) => {
      chatSubscribersRef.current.forEach((cb) => cb(payload));
    }, []),
  });

  const flushCurrentDoc = useCallback(() => {
    if (docUpdateTimer.current) {
      clearTimeout(docUpdateTimer.current);
      docUpdateTimer.current = null;
    }
    const doc = lastDocJson.current || editorRef.current?.getJSON();
    if (!doc) return;
    const docStr = JSON.stringify(doc);
    if (docStr === lastSentDocJson.current) return;
    sendMessage({ type: 'doc-update', document: doc, filename: currentFilename.current, version: docVersionRef.current });
    markSaved();
    lastSentDocJson.current = docStr;
  }, [sendMessage, docVersionRef, markSaved]);

  const handleDocUpdate = useCallback((json: any) => {
    lastDocJson.current = json;
    if (lastSentDocJson.current === null) return;
    if (JSON.stringify(json) === lastSentDocJson.current) return;
    setSaveState('saving');
    if (docUpdateTimer.current) clearTimeout(docUpdateTimer.current);
    docUpdateTimer.current = setTimeout(() => {
      const fresh = lastDocJson.current || json;
      const freshStr = JSON.stringify(fresh);
      if (freshStr === lastSentDocJson.current) return;
      sendMessage({ type: 'doc-update', document: fresh, filename: currentFilename.current, version: docVersionRef.current });
      markSaved();
      lastSentDocJson.current = freshStr;
    }, 1000);
  }, [sendMessage, docVersionRef, markSaved]);

  const handleTitleChange = useCallback((newTitle: string) => {
    setTitle(newTitle);
    sendMessage({ type: 'title-update', title: newTitle });
  }, [sendMessage]);

  const expectingCreateRef = useRef(false);

  const handleCreateDocument = useCallback(() => {
    flushCurrentDoc();
    expectingCreateRef.current = true;
    sendMessage({ type: 'create-document' });
  }, [flushCurrentDoc, sendMessage]);

  const handleSwitchDocument = useCallback((filename: string) => {
    if (filename === currentFilename.current) return;
    flushCurrentDoc();
    sendMessage({ type: 'switch-document', filename });
  }, [flushCurrentDoc, sendMessage]);

  const toggleToolbar = useCallback(() => {
    setShowToolbar(v => {
      localStorage.setItem('ow-toolbar', v ? 'hidden' : 'visible');
      return !v;
    });
  }, []);

  // An adopt/restore changes both listings — a desk doc appears/disappears AND
  // a shelf mirror leaves/returns — so bump both keys in one shot. (The server
  // also broadcasts documents-changed + library-changed, but the writer should
  // not wait a round-trip for the desk to acknowledge their own action.)
  const handleLibraryMutated = useCallback(() => {
    setRefreshKey(k => k + 1);
    setLibraryRefreshKey(k => k + 1);
  }, []);

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        onSwitchDocument={handleSwitchDocument}
        onCreateDocument={handleCreateDocument}
        refreshKey={refreshKey}
        libraryRefreshKey={libraryRefreshKey}
        onLibraryMutated={handleLibraryMutated}
        pendingDocs={pendingDocs}
        pendingWriteFilenames={new Set(pendingDocs.filenames)}
        writingTitle={writing?.title ?? null}
        writingTarget={writing?.target ?? null}
        activeFilename={activeFilename}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        onActiveDocRenamed={setTitle}
      />
      <div className="app-main">
        <Titlebar
          title={title}
          onTitleChange={handleTitleChange}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          editor={editorInstance}
          onToggleToolbar={toggleToolbar}
          toolbarOpen={showToolbar}
          focusMode={focusMode}
          onToggleFocusMode={toggleFocusMode}
          saveState={saveState}
          lastSavedAt={lastSavedAt}
          pendingTitle={pendingTitle}
          docId={(metadata?.docId as string) || undefined}
        />
        {showToolbar && editorInstance && (
          <FormatToolbar editor={editorInstance} />
        )}
        {!connected && (
          <div className="connection-banner">
            <span>Reconnecting to server...</span>
          </div>
        )}
        <div className="editor-container">
          <PadEditor
            initialContent={initialContent}
            onUpdate={handleDocUpdate}
            onReady={handleEditorReady}
            onDiscussSelection={discussSelection}
          />
        </div>
      </div>
      <RightRail
        editors={editorInstance ? [editorInstance] : []}
        pendingDocs={pendingDocs}
        currentFilename={activeFilename}
        docId={(metadata?.docId as string) || null}
        docTitle={title}
        pendingTitle={pendingTitle}
        chatQuote={chatQuote}
        onAttachChatQuote={setChatQuote}
        onClearChatQuote={() => setChatQuote(null)}
        onSwitchDocument={handleSwitchDocument}
        sendMessage={sendMessage}
        getDocument={() => lastDocJson.current}
        docVersionRef={docVersionRef}
        onToggleToolbar={toggleToolbar}
        toolbarOpen={showToolbar}
        subscribeChatProgress={subscribeChatProgress}
        reviewGate={reviewGate}
        reviewNote={reviewNote}
      />
      {tourOpen && tourUserId && (
        <TourOverlay
          userId={tourUserId}
          onEnsureSidebar={ensureSidebar}
          onFinish={() => setTourOpen(false)}
        />
      )}
    </div>
  );
}
