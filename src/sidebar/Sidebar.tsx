import { useState, useEffect, useRef, useCallback } from 'react';
import type { PendingDocsPayload } from '../ws/client';
import { useSidebarData, useLibraryData } from './sidebar-data';
import { useSidebarActions } from './sidebar-actions';
import type { SearchResult } from './sidebar-types';
import SidebarFiles from './SidebarFiles';
import './Sidebar.css';

interface SidebarProps {
  open: boolean;
  onSwitchDocument: (filename: string) => void;
  onCreateDocument: () => void;
  refreshKey: number;
  /** Bumped by the App on the `library-changed` WS push — re-reads the shelf. */
  libraryRefreshKey: number;
  /** An adopt/restore succeeded — the App bumps both refresh keys. */
  onLibraryMutated: () => void;
  pendingDocs: PendingDocsPayload;
  pendingWriteFilenames?: Set<string>;
  writingTitle?: string | null;
  writingTarget?: { wsFilename: string; containerId: string | null; parentDocId?: string } | null;
  activeFilename?: string;
  onClose?: () => void;
  width: number;
  onWidthChange: (w: number) => void;
  floating?: boolean;
  onActiveDocRenamed?: (title: string) => void;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 600;
export const SIDEBAR_DEFAULT_WIDTH = 260;

export default function Sidebar({ open, onSwitchDocument, onCreateDocument, refreshKey, libraryRefreshKey, onLibraryMutated, pendingDocs, pendingWriteFilenames, writingTitle, writingTarget, activeFilename, onClose, width, onWidthChange, floating, onActiveDocRenamed }: SidebarProps) {
  const { docs, setDocs, workspaces, scrollRef, markPendingDelete, unmarkPendingDelete, fetchDocs } = useSidebarData(refreshKey, pendingDocs);
  const actions = useSidebarActions(fetchDocs, setDocs, docs, markPendingDelete, unmarkPendingDelete, onActiveDocRenamed);
  const { data: libraryData, refresh: refreshLibrary } = useLibraryData(libraryRefreshKey);

  const resizingRef = useRef(false);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let latest = width;
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      latest = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, ev.clientX));
      onWidthChange(latest);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem('ow-sidebar-width', String(latest)); } catch {}
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width, onWidthChange]);

  useEffect(() => {
    if (!activeFilename) return;
    setDocs(prev => {
      if (prev.some(d => d.filename === activeFilename ? !d.isActive : d.isActive)) {
        return prev.map(d => ({ ...d, isActive: d.filename === activeFilename }));
      }
      return prev;
    });
  }, [activeFilename, setDocs, refreshKey]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Admin settings gear + logout — the front door owns /api/session. Gear is
  // admin-only; logout is for everyone with a session (hidden in a bare dev
  // slot, where the endpoint is absent). The writer's name labels the desk:
  // "Doc Carol's Writing Desk" — the chrome must say who is logged in
  // (M4e UAT review: the only identity surface was the admin roster).
  const [isAdmin, setIsAdmin] = useState(false);
  const [canLogout, setCanLogout] = useState(false);
  const [writerName, setWriterName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/session').then(r => r.ok ? r.json() : null).then(j => {
      if (live && j) {
        if (j?.user?.isAdmin) setIsAdmin(true);
        if (j?.user?.name) setWriterName(j.user.name);
        setCanLogout(true);
      }
    }).catch(() => { /* no front door — no gear, no logout */ });
    return () => { live = false; };
  }, []);

  const onLogout = useCallback(() => {
    fetch('/api/logout', { method: 'POST' }).catch(() => { /* dead session is fine */ }).finally(() => {
      window.location.assign('/login');
    });
  }, []);

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/documents/search?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) setSearchResults(await res.json());
      } catch { /* ignore */ }
    }, 250);
  }, []);

  const optimisticSwitchDocument = useCallback((filename: string) => {
    setDocs(prev => prev.map(d => ({ ...d, isActive: d.filename === filename })));
    onSearchChange('');
    onSwitchDocument(filename);
  }, [setDocs, onSwitchDocument, onSearchChange]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const sidebarStyle = open ? { width: `${width}px`, minWidth: `${width}px` } : undefined;
  const resizeHandle = open && !floating ? (
    <div
      className="sidebar-resize-handle"
      onPointerDown={startResize}
      onDoubleClick={() => { onWidthChange(SIDEBAR_DEFAULT_WIDTH); try { localStorage.setItem('ow-sidebar-width', String(SIDEBAR_DEFAULT_WIDTH)); } catch {} }}
      title="Drag to resize · double-click to reset"
    />
  ) : null;

  return (
    <div className={`sidebar ${open ? 'open' : ''}`} style={sidebarStyle}>
      <div className="sidebar-topbar">
        <div className="sidebar-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 5l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="sidebar-logo-text" title={writerName ?? undefined}>
            {writerName ? `${writerName}'s Writing Desk` : 'Writing Desk'}
          </span>
        </div>
        <div className="sidebar-topbar-actions">
          {isAdmin && (
            <a className="sidebar-gear-btn" href="/admin" title="Settings">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
              </svg>
            </a>
          )}
          {canLogout && (
            <button className="sidebar-logout-btn" onClick={onLogout} title="Log out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          )}
          {onClose && (
            <button className="sidebar-collapse-btn" onClick={onClose} title="Close sidebar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M9 3v18" stroke="currentColor" strokeWidth="2" />
                <path d="M15 10l-2 2 2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-search">
        <svg className="sidebar-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10.5" cy="10.5" r="7" />
          <path d="m20 20-4.5-4.5" />
        </svg>
        <input
          ref={searchInputRef}
          className="sidebar-search-input"
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchQuery && (
          <button className="sidebar-search-clear" onClick={() => onSearchChange('')} title="Clear search">
            ×
          </button>
        )}
      </div>

      <SidebarFiles
        docs={docs}
        archivedDocs={[]}
        workspaces={workspaces}
        pendingDocs={pendingDocs}
        onSwitchDocument={optimisticSwitchDocument}
        onCreateDocument={onCreateDocument}
        actions={actions}
        scrollRef={scrollRef}
        pendingWriteFilenames={pendingWriteFilenames}
        writingTitle={writingTitle}
        writingTarget={writingTarget}
        searchQuery={searchQuery}
        searchResults={searchResults}
        onSearchChange={onSearchChange}
        library={{ data: libraryData, refresh: refreshLibrary, onMutated: onLibraryMutated }}
      />
      {resizeHandle}
    </div>
  );
}
