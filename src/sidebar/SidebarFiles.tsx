import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { SidebarModeProps, DocumentInfo, LibraryArticleInfo } from './sidebar-types';
import { useSidebarDrag } from './sidebar-drag';
import { useRevealActiveDoc } from './use-reveal-active-doc';
import { showToast } from '../utils/toast';
import SidebarContextMenu from './SidebarContextMenu';
import CreateDocDropdown from './CreateDocDropdown';
import SearchResults from './SearchResults';
import './SidebarFiles.css';

const DocIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);

/** Shelf article — an open book, so a library row never reads as a desk doc. */
const BookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
);

export default function SidebarFiles({
  docs, pendingDocs,
  onSwitchDocument, onCreateDocument, actions, scrollRef,
  pendingWriteFilenames,
  writingTitle, writingTarget,
  searchQuery, searchResults, onSearchChange,
  library,
}: SidebarModeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('ow-files-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  const selectionRef = useRef<Set<string>>(new Set());
  const clearSelectionRef = useRef<() => void>(() => {});

  const { draggedItem, dropIndicator, handlePointerDown, dropClass, isDragging } = useSidebarDrag({
    docs, scrollRef, setCollapsedSections: setCollapsed,
    selectionRef, onBulkMoved: () => clearSelectionRef.current(),
  });

  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filename: string; title: string } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [createDropdown, setCreateDropdown] = useState<{ anchor: DOMRect } | null>(null);
  const [clearedPending, setClearedPending] = useState<Set<string>>(new Set());

  useEffect(() => { setClearedPending(new Set()); }, [pendingDocs]);

  selectionRef.current = selection;
  clearSelectionRef.current = () => { setSelection(new Set()); setAnchor(null); };

  const activeDoc = docs.find(d => d.isActive);

  const visibleDocs = docs;
  const isPending = (filename: string) => !!pendingWriteFilenames && pendingWriteFilenames.has(filename);

  const orderedFilenames = useMemo(() => visibleDocs.map(d => d.filename), [visibleDocs]);

  const handleDocContextMenu = useCallback((e: React.MouseEvent, doc: DocumentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    if (selection.has(doc.filename) && selection.size > 1) {
      setCtxMenu({ x: e.clientX, y: e.clientY, filename: doc.filename, title: doc.title });
      return;
    }
    if (selection.size > 0 && !selection.has(doc.filename)) setSelection(new Set());
    setCtxMenu({ x: e.clientX, y: e.clientY, filename: doc.filename, title: doc.title });
  }, [selection]);

  const handleDuplicate = useCallback((filename: string) => {
    fetch('/api/documents/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) }).catch(() => {});
  }, []);

  // ── Library shelf ────────────────────────────────────────────────────────
  // The section is read-only by construction: rows carry Adopt + preview and
  // nothing else (no rename, no context menu, no drag, no save path). The one
  // write out of the library area is the adopted doc's "Return to library"
  // item in the Documents section menu, below. spec §3/§7.
  const libraryFolders = useMemo((): { key: string; label: string; articles: LibraryArticleInfo[] }[] => {
    const data = library.data;
    if (!data) return [];
    const folders = data.categories.series.map(series => ({
      key: `lib:${series}`,
      label: series,
      articles: data.articles.filter(a => a.series === series),
    }));
    const unfiled = data.articles.filter(a => !a.series);
    if (unfiled.length > 0) folders.push({ key: 'lib:__unfiled__', label: 'Unfiled', articles: unfiled });
    return folders.filter(f => f.articles.length > 0);
  }, [library.data]);

  const [preview, setPreview] = useState<{ docId: string; body: string | null } | null>(null);

  const handlePreview = useCallback((docId: string) => {
    if (preview?.docId === docId) { setPreview(null); return; }
    setPreview({ docId, body: null });
    fetch(`/api/library/${encodeURIComponent(docId)}`)
      .then(res => res.ok ? res.json() : null)
      .then(d => {
        if (d && typeof d.body === 'string') setPreview(cur => cur?.docId === docId ? { docId, body: d.body } : cur);
        else setPreview(cur => cur?.docId === docId ? null : cur);
      })
      .catch(() => setPreview(cur => cur?.docId === docId ? null : cur));
  }, [preview?.docId]);

  const handleAdopt = useCallback((docId: string) => {
    fetch('/api/library/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId }),
    }).then(async res => {
      if (res.ok) {
        const info = await res.json().catch(() => null);
        library.onMutated();
        showToast('Adopted to your desk', 'info');
        if (info?.filename) onSwitchDocument(info.filename);
        return;
      }
      let message = 'Adopt failed';
      try {
        const parsed = await res.json();
        if (parsed.code === 'already-adopted') message = 'Already on your desk';
        else if (parsed.error) message = parsed.error;
      } catch { /* keep default */ }
      showToast(message, 'error');
    }).catch(() => showToast('Adopt failed', 'error'));
  }, [library, onSwitchDocument]);

  const handleRestoreFromLibrary = useCallback((docId: string) => {
    fetch(`/api/library/${encodeURIComponent(docId)}/restore`, { method: 'POST' })
      .then(async res => {
        if (res.ok) { library.onMutated(); return; }
        let message = 'Restore failed';
        try { const parsed = await res.json(); if (parsed.error) message = parsed.error; } catch { /* keep default */ }
        showToast(message, 'error');
      })
      .catch(() => showToast('Restore failed', 'error'));
  }, [library]);

  const toggle = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('ow-files-collapsed', JSON.stringify([...next]));
      return next;
    });
  };

  const startRename = (filename: string, value: string) => {
    setRenaming({ key: filename, value });
  };

  const commitRename = () => {
    if (!renaming) return;
    actions.handleRename(renaming.key, '', renaming.value);
    setRenaming(null);
  };

  useRevealActiveDoc(scrollRef, docs, docs.length, undefined);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
  }, []);

  const handleDocClick = useCallback((e: React.MouseEvent, filename: string) => {
    if (draggedItem) return;
    const isShift = e.shiftKey;
    const isMod = e.ctrlKey || e.metaKey;

    if (isShift) {
      const anchorFile = anchor || activeDoc?.filename || filename;
      const ia = orderedFilenames.indexOf(anchorFile);
      const ib = orderedFilenames.indexOf(filename);
      if (ia < 0 || ib < 0) {
        setSelection(new Set([filename]));
        setAnchor(filename);
        return;
      }
      const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
      setSelection(new Set(orderedFilenames.slice(lo, hi + 1)));
      return;
    }

    if (isMod) {
      setSelection(prev => {
        const next = new Set(prev);
        if (next.has(filename)) next.delete(filename); else next.add(filename);
        return next;
      });
      setAnchor(filename);
      return;
    }

    setSelection(new Set());
    setAnchor(filename);
    const doc = docs.find(d => d.filename === filename);
    if (doc && !doc.isActive) onSwitchDocument(filename);
  }, [draggedItem, anchor, activeDoc?.filename, orderedFilenames, onSwitchDocument, docs]);

  useEffect(() => {
    if (selection.size === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selection.size, clearSelection]);

  const handleBulkDelete = useCallback(() => {
    for (const fn of selection) actions.handleDelete(fn);
    setSelection(new Set());
    setAnchor(null);
  }, [selection, actions]);

  if (searchResults !== null) {
    return <SearchResults results={searchResults} query={searchQuery} onSwitchDocument={onSwitchDocument} />;
  }

  const renderRenameInput = (onCommit: () => void) => (
    <input
      className="sidebar-rename-input"
      value={renaming!.value}
      onChange={e => setRenaming(prev => prev ? { ...prev, value: e.target.value } : null)}
      onBlur={onCommit}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') setRenaming(null); }}
      autoFocus
      onClick={e => e.stopPropagation()}
    />
  );

  return (
    <div className="files-scroll" ref={scrollRef}>
      <div className="files-section">
        <div className={`files-row is-section${collapsed.has('docs') ? '' : ''}`} data-section-key="docs" onClick={() => toggle('docs')}>
          <span className={`files-row-chevron leading${collapsed.has('docs') ? ' collapsed' : ''}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
          <span className="files-row-label">Documents</span>
          <button className="files-section-btn" data-tour-id="create" onClick={(e) => { e.stopPropagation(); setCreateDropdown({ anchor: (e.target as HTMLElement).getBoundingClientRect() }); }} title="New document">+</button>
        </div>
        <div className={`files-section-list files-children${collapsed.has('docs') ? ' collapsed' : ''}`} data-drop-ws="__docs__">
          {writingTitle && !writingTarget?.parentDocId && (
            <div className="sidebar-item sidebar-writing-placeholder" style={{ paddingLeft: 28 }}>
              <div className="sidebar-item-title">
                <span className="sidebar-writing-spinner" />
                <span className="sidebar-item-title-text">{writingTitle}</span>
              </div>
              <div className="sidebar-item-meta">Writing...</div>
            </div>
          )}
          {visibleDocs.map(doc => (
            <React.Fragment key={doc.filename}>
              <div
                className={`files-row${doc.isActive ? ' active' : ''}${selection.has(doc.filename) ? ' selected' : ''} ${isDragging(doc.filename) ? 'dragging' : ''} ${dropClass(doc.filename)}`}
                data-drag-id={doc.filename}
                data-drag-type="doc"
                data-drag-ws="__docs__"
                onPointerDown={e => handlePointerDown(e, { type: 'doc', file: doc.filename, sourceWs: null }, selection.has(doc.filename) && selection.size > 1 ? `${selection.size} docs` : doc.title)}
                onClick={e => handleDocClick(e, doc.filename)}
                onDoubleClick={() => startRename(doc.filename, doc.title)}
                onContextMenu={e => handleDocContextMenu(e, doc)}
              >
                <span className="files-row-icon"><DocIcon /></span>
                {renaming?.key === doc.filename ? (
                  renderRenameInput(commitRename)
                ) : (
                  <span className="files-row-label">{doc.title}</span>
                )}
                {doc.reviewGate && (() => {
                  const adopted = !!doc.libraryKey && doc.reviewGate.phase === 'published';
                  const since = new Date(doc.reviewGate.since).toLocaleString();
                  // T6: the checked-out chip's tooltip is the ADOPT time — the
                  // published time was the wrong fact (brief-mandated then).
                  const adoptedAt = doc.libraryAdoptedAt
                    ? new Date(doc.libraryAdoptedAt).toLocaleString()
                    : since;
                  const label = adopted
                    ? 'Checked out'
                    : doc.reviewGate.phase === 'submitted' ? 'sent'
                      : doc.reviewGate.phase === 'in-review' ? 'in review'
                        : doc.reviewGate.phase === 'published' ? 'in library'
                          : doc.reviewGate.phase === 'conflict' ? 'needs attention'
                            : 'returned with notes';
                  const tip = adopted
                    ? `Adopted from the library — ${adoptedAt}`
                    : doc.reviewGate.phase === 'submitted' ? `Sent for review at ${since}`
                      : doc.reviewGate.phase === 'in-review' ? `In review since ${since}`
                        : doc.reviewGate.phase === 'published' ? `In the library since ${since}`
                          : doc.reviewGate.phase === 'conflict' ? `Needs attention since ${since}`
                            : `Returned with notes since ${since}`;
                  const visual = adopted ? 'adopted' : doc.reviewGate.phase === 'submitted' ? 'in-review' : doc.reviewGate.phase;
                  return (
                    <span className={`wa-lifecycle wa-lifecycle--${visual}`} title={tip}>
                      {label}
                    </span>
                  );
                })()}
                {isPending(doc.filename) && !clearedPending.has(doc.filename) && <span className="files-badge-pending" />}
              </div>
              {writingTitle && writingTarget?.parentDocId && writingTarget.parentDocId === doc.docId && (
                <div className="sidebar-item sidebar-writing-placeholder" style={{ paddingLeft: 28 }}>
                  <div className="sidebar-item-title">
                    <span className="sidebar-writing-spinner" />
                    <span className="sidebar-item-title-text">{writingTitle}</span>
                  </div>
                  <div className="sidebar-item-meta">Writing...</div>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="files-section files-library">
        <div className="files-row is-section" data-section-key="library" onClick={() => toggle('library')}>
          <span className={`files-row-chevron leading${collapsed.has('library') ? ' collapsed' : ''}`}>
            <ChevronIcon />
          </span>
          <span className="files-row-label">Library</span>
          <button className="files-section-btn" onClick={(e) => { e.stopPropagation(); library.refresh(); }} title="Refresh library">⟳</button>
        </div>
        <div className={`files-section-list files-children${collapsed.has('library') ? ' collapsed' : ''}`}>
          {libraryFolders.map(folder => (
            <React.Fragment key={folder.key}>
              <div className="files-row is-container library-folder" data-section-key={folder.key} onClick={() => toggle(folder.key)}>
                <span className={`files-row-chevron leading${collapsed.has(folder.key) ? ' collapsed' : ''}`}>
                  <ChevronIcon />
                </span>
                <span className="files-row-label">{folder.label}</span>
                <span className="files-row-count">{folder.articles.length}</span>
              </div>
              <div className={`files-section-list files-children${collapsed.has(folder.key) ? ' collapsed' : ''}`}>
                {folder.articles.map(a => (
                  <React.Fragment key={a.docId}>
                    {/* Read-only row: the click expends the preview, the two
                        affordances are Adopt and (via the row) preview — no
                        rename, no context menu, no drag, no save path. */}
                    <div
                      className="files-row library-row"
                      data-library-docid={a.docId}
                      onClick={() => handlePreview(a.docId)}
                      title={a.title}
                    >
                      <span className="files-row-icon"><BookIcon /></span>
                      <span className="files-row-label">{a.title}</span>
                      {a.topics.map(t => <span key={t} className="library-tag">{t}</span>)}
                      {!a.checkedOut && a.publishedAt && (
                        <span
                          className="wa-lifecycle wa-lifecycle--published"
                          title={`In the library since ${new Date(a.publishedAt).toLocaleDateString()}`}
                        >
                          in library
                        </span>
                      )}
                      {a.checkedOut && (
                        <span className="wa-lifecycle wa-lifecycle--adopted" title="Already on your desk">Checked out</span>
                      )}
                      <button
                        className="library-adopt"
                        disabled={!a.key || a.checkedOut}
                        title={a.checkedOut ? 'Already on your desk' : a.key ? 'Adopt — check this article out to your desk' : "Can't adopt this article"}
                        onClick={(e) => { e.stopPropagation(); handleAdopt(a.docId); }}
                      >
                        Adopt
                      </button>
                      <span className={`files-row-chevron${preview?.docId === a.docId ? '' : ' collapsed'}`}>
                        <ChevronIcon />
                      </span>
                    </div>
                    {preview?.docId === a.docId && (
                      <div className="library-preview">
                        <pre>{preview?.body ?? 'Loading…'}</pre>
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </React.Fragment>
          ))}
          {libraryFolders.length === 0 && (
            <div className="files-row library-empty">
              <span className="files-row-label">{library.data ? 'The shelf is empty' : 'Loading…'}</span>
            </div>
          )}
        </div>
      </div>

      {ctxMenu && (() => {
        // Return-to-library: the one write out of the library area, and it
        // lives on the adopted DESK doc's menu (its libraryKey is non-null).
        const ctxDoc = docs.find(d => d.filename === ctxMenu.filename);
        const restore = ctxDoc?.libraryKey && ctxDoc.docId
          ? () => handleRestoreFromLibrary(ctxDoc.docId as string)
          : undefined;
        return (
          <SidebarContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            filename={ctxMenu.filename}
            title={ctxMenu.title}
            bulkCount={selection.size > 1 ? selection.size : undefined}
            onBulkDelete={handleBulkDelete}
            onClose={() => setCtxMenu(null)}
            onDuplicate={() => handleDuplicate(ctxMenu.filename)}
            onRename={() => { startRename(ctxMenu.filename, ctxMenu.title); setCtxMenu(null); }}
            onDelete={() => actions.handleDelete(ctxMenu.filename)}
            onRestoreFromLibrary={restore}
          />
        );
      })()}

      {createDropdown && (
        <CreateDocDropdown
          anchorRect={createDropdown.anchor}
          onClose={() => setCreateDropdown(null)}
          onSelect={() => { setCreateDropdown(null); onCreateDocument(); }}
        />
      )}
    </div>
  );
}
