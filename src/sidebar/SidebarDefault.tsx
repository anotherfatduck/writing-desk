import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SidebarModeProps, DocumentInfo } from './sidebar-types';
import { useSidebarDrag } from './sidebar-drag';
import { useRevealActiveDoc } from './use-reveal-active-doc';
import { formatDate, isExternal, parentDir } from './sidebar-utils';
import SidebarContextMenu from './SidebarContextMenu';
import SearchResults from './SearchResults';
import CreateDocDropdown from './CreateDocDropdown';
import { getSidebarDensity, setSidebarDensity } from '../themes/appearance-store';
import type { SidebarDensity } from '../themes/appearance-store';

const DENSITY_OPTIONS: { id: SidebarDensity; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'compact', label: 'Compact' },
  { id: 'minimal', label: 'Minimal' },
];

// Trimmed copy of openwriter SidebarDefault.tsx per spec §4 cut seams.
// Removed: workspaces, containers, variants, plugins, schedule/post, analytics,
// auto-accept, assignedFiles, lastSent/postedUrl/isNewsletter, batch-resolve,
// and workspace/container folder actions. What survives is the flat "Documents"
// section, inline rename, tags, delete confirm, density menu, drag-to-reorder,
// and search results. This mode is currently inert — Sidebar.tsx collapses the
// mode switch to SidebarFiles, so this file is kept only to match the port list.
export default function SidebarDefault({
  docs, pendingDocs, onSwitchDocument, onCreateDocument, actions, scrollRef,
  pendingWriteFilenames, searchQuery, searchResults, onSearchChange,
}: SidebarModeProps) {
  const isPending = (filename: string) => !!pendingWriteFilenames && pendingWriteFilenames.has(filename);
  const [editingFilename, setEditingFilename] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('ow-collapsed-sections');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [tagInputFile, setTagInputFile] = useState<string | null>(null);
  const [tagInputValue, setTagInputValue] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filename: string; title: string } | null>(null);
  const [createDropdown, setCreateDropdown] = useState<{ anchor: DOMRect } | null>(null);
  const [densityMenu, setDensityMenu] = useState<{ x: number; y: number } | null>(null);
  const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
  const densityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!densityMenu) return;
    const handler = (e: MouseEvent) => {
      if (densityRef.current && !densityRef.current.contains(e.target as Node)) setDensityMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [densityMenu]);

  const handleDensitySelect = (id: SidebarDensity) => {
    setDensity(id);
    setSidebarDensity(id);
    setDensityMenu(null);
  };

  const handleSectionContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setDensityMenu({ x: e.clientX, y: e.clientY });
  };

  const { draggedItem, dropIndicator, handlePointerDown, dropClass, isDragging } = useSidebarDrag({
    docs, scrollRef, setCollapsedSections,
  });

  const handleDocContextMenu = useCallback((e: React.MouseEvent, doc: DocumentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, filename: doc.filename, title: doc.title });
  }, []);

  const handleDuplicate = useCallback((filename: string) => {
    fetch('/api/documents/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    }).catch(() => {});
  }, []);

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('ow-collapsed-sections', JSON.stringify([...next]));
      return next;
    });
  };

  useRevealActiveDoc(scrollRef, docs, docs.length, undefined);

  if (searchResults !== null) {
    return <SearchResults results={searchResults} query={searchQuery} onSwitchDocument={onSwitchDocument} />;
  }

  const renderDocItem = (doc: DocumentInfo, index: number) => (
    <div
      key={doc.filename}
      className={`sidebar-item ${doc.isActive ? 'active' : ''} ${isDragging(doc.filename) ? 'dragging' : ''} ${dropClass(doc.filename)}`}
      data-drag-id={doc.filename}
      data-drag-type="doc"
      data-drag-ws="__docs__"
      onPointerDown={(e) => handlePointerDown(e, { type: 'doc', file: doc.filename, sourceWs: null }, doc.title)}
      onClick={() => !doc.isActive && !draggedItem && onSwitchDocument(doc.filename)}
      onDoubleClick={() => { setEditingFilename(doc.filename); setEditValue(doc.title); }}
      onContextMenu={(e) => handleDocContextMenu(e, doc)}
    >
      {editingFilename === doc.filename ? (
        <input
          className="sidebar-rename-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => { actions.handleRename(doc.filename, doc.title, editValue); setEditingFilename(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { actions.handleRename(doc.filename, doc.title, editValue); setEditingFilename(null); }
            if (e.key === 'Escape') setEditingFilename(null);
          }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <div className="sidebar-item-title">
            <span className="sidebar-item-title-text">{doc.title}</span>
            {pendingDocs.filenames.includes(doc.filename) && <span className="sidebar-pending-dot" />}
          </div>
          {isExternal(doc.filename) && <div className="sidebar-item-context">{parentDir(doc.filename)}</div>}
          <div className="sidebar-item-meta">
            {doc.wordCount.toLocaleString()} words &middot; {formatDate(doc.lastModified)}
          </div>
          <div className="sidebar-tags">
            {actions.getDocTags(doc.filename).map(tag => (
              <span key={tag} className="sidebar-tag" onClick={(e) => e.stopPropagation()}>
                {tag}
                <span className="sidebar-tag-remove" onClick={(e) => { e.stopPropagation(); actions.handleRemoveTag(doc.filename, tag); }}>&times;</span>
              </span>
            ))}
            {tagInputFile === doc.filename ? (
              <input
                className="sidebar-tag-input"
                value={tagInputValue}
                onChange={(e) => setTagInputValue(e.target.value)}
                onBlur={() => { if (tagInputValue.trim()) actions.handleAddTag(doc.filename, tagInputValue); setTagInputFile(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { actions.handleAddTag(doc.filename, tagInputValue); setTagInputFile(null); setTagInputValue(''); }
                  if (e.key === 'Escape') { setTagInputFile(null); setTagInputValue(''); }
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                placeholder="tag..."
              />
            ) : (
              <button className="sidebar-tag-add" onClick={(e) => { e.stopPropagation(); setTagInputFile(doc.filename); setTagInputValue(''); }}>+</button>
            )}
          </div>
        </>
      )}
      {confirmDelete === doc.filename ? (
        <div className="sidebar-confirm-delete" onClick={(e) => e.stopPropagation()}>
          <span>{isExternal(doc.filename) ? 'Remove?' : 'Delete?'}</span>
          <button onClick={() => { actions.handleDelete(doc.filename); setConfirmDelete(null); }}>Yes</button>
          <button onClick={() => setConfirmDelete(null)}>No</button>
        </div>
      ) : (
        <button className="sidebar-delete-btn" onClick={(e) => { e.stopPropagation(); setConfirmDelete(doc.filename); }} title={isExternal(doc.filename) ? 'Remove document' : 'Delete document'}>&times;</button>
      )}
    </div>
  );

  const unassignedDocs = useMemo(() => docs.filter((d) => !isPending(d.filename)), [docs, pendingWriteFilenames]);

  return (
    <div className="sidebar-scroll" ref={scrollRef}>
      <div className={`sidebar-section sidebar-docs-section ${collapsedSections.has('docs') ? 'docs-collapsed' : ''}`}>
        <div
          className="sidebar-section-header"
          data-section-key="docs"
          onClick={() => toggleSection('docs')}
          onContextMenu={handleSectionContextMenu}
        >
          <span className={`sidebar-chevron ${collapsedSections.has('docs') ? 'collapsed' : ''}`}>&#9662;</span>
          <span className="sidebar-label">Documents</span>
          <button className="sidebar-new-btn" data-tour-id="create" onClick={(e) => { e.stopPropagation(); setCreateDropdown({ anchor: (e.target as HTMLElement).getBoundingClientRect() }); }} title="New document">+</button>
        </div>
        {!collapsedSections.has('docs') && (
          <div className="sidebar-section-list" data-drop-ws="__docs__">
            {unassignedDocs.map((doc, i) => renderDocItem(doc, i))}
            {unassignedDocs.length === 0 && <div className="sidebar-empty">{draggedItem ? 'Drop here' : 'No documents'}</div>}
          </div>
        )}
      </div>

      {ctxMenu && (
        <SidebarContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          filename={ctxMenu.filename}
          title={ctxMenu.title}
          onClose={() => setCtxMenu(null)}
          onDuplicate={() => handleDuplicate(ctxMenu.filename)}
          onRename={() => { setEditingFilename(ctxMenu.filename); setEditValue(ctxMenu.title); setCtxMenu(null); }}
          onDelete={() => actions.handleDelete(ctxMenu.filename)}
        />
      )}

      {createDropdown && (
        <CreateDocDropdown
          anchorRect={createDropdown.anchor}
          onClose={() => setCreateDropdown(null)}
          onSelect={() => { setCreateDropdown(null); onCreateDocument(); }}
        />
      )}

      {densityMenu && (
        <div
          ref={densityRef}
          className="sidebar-density-dropdown"
          style={{ position: 'fixed', left: densityMenu.x, top: densityMenu.y, zIndex: 200 }}
        >
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              className={`sidebar-density-option ${density === opt.id ? 'active' : ''}`}
              onClick={() => handleDensitySelect(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
