import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isExternal } from './sidebar-utils';

export interface SidebarMenuItem {
  label: string;
  action: string;
  promptForFocus?: boolean;
  pluginDisplayName?: string;
  folderCapable?: boolean;
}

interface SidebarContextMenuProps {
  x: number;
  y: number;
  filename: string;
  title: string;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
  bulkCount?: number;
  onBulkDelete?: () => void;
  /** Present only when the doc was adopted from the library — discards the
   *  adopted desk copy so the librarian re-seeds the shelf article. */
  onRestoreFromLibrary?: () => void;
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onDuplicate, onRename, onDelete, bulkCount, onBulkDelete, onRestoreFromLibrary }: SidebarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [adjustedPos, setAdjustedPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (y + rect.height + pad > window.innerHeight) top = y - rect.height;
    if (x + rect.width + pad > window.innerWidth) left = x - rect.width;
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    setAdjustedPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (bulkCount && bulkCount > 1 && onBulkDelete) {
    return (
      <div ref={menuRef} className="context-menu" style={{ left: adjustedPos.left, top: adjustedPos.top }}>
        <div className="context-menu-section-header">{bulkCount} selected</div>
        {confirmDelete ? (
          <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
            <span>Delete {bulkCount}?</span>
            <button onClick={() => { onBulkDelete(); onClose(); }}>Yes</button>
            <button onClick={() => setConfirmDelete(false)}>No</button>
          </div>
        ) : (
          <button className="context-menu-item sidebar-ctx-delete" onClick={() => setConfirmDelete(true)}>
            <span>Delete ({bulkCount})</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={menuRef} className="context-menu" style={{ left: adjustedPos.left, top: adjustedPos.top }}>
      <button className="context-menu-item" onClick={() => { onDuplicate(); onClose(); }}>
        <span>Duplicate</span>
      </button>
      <button className="context-menu-item" onClick={() => { onRename(); onClose(); }}>
        <span>Rename</span>
      </button>
      {onRestoreFromLibrary && (confirmReturn ? (
        <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
          <span>Return this book to the library? Your desk copy is discarded — your text stays in History.</span>
          <button onClick={() => { onRestoreFromLibrary(); onClose(); }}>Yes</button>
          <button onClick={() => setConfirmReturn(false)}>No</button>
        </div>
      ) : (
        <button className="context-menu-item" onClick={() => setConfirmReturn(true)}>
          <span>Return to library</span>
        </button>
      ))}
      {confirmDelete ? (
        <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
          <span>{isExternal(filename) ? 'Remove?' : 'Delete?'}</span>
          <button onClick={() => { onDelete(); onClose(); }}>Yes</button>
          <button onClick={() => setConfirmDelete(false)}>No</button>
        </div>
      ) : (
        <button className="context-menu-item sidebar-ctx-delete" onClick={() => { setConfirmDelete(true); }}>
          <span>{isExternal(filename) ? 'Remove' : 'Delete'}</span>
        </button>
      )}
    </div>
  );
}
