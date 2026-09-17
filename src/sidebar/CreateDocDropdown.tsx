import { useEffect, useLayoutEffect, useRef } from 'react';
import './CreateDocDropdown.css';

interface CreateDocDropdownProps {
  anchorRect: DOMRect;
  onSelect: (metadata?: Record<string, any>) => void;
  onClose: () => void;
}

export default function CreateDocDropdown({ anchorRect, onSelect, onClose }: CreateDocDropdownProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;
    if (top + rect.height + pad > window.innerHeight) top = anchorRect.top - rect.height - 4;
    if (left + rect.width + pad > window.innerWidth) left = anchorRect.right - rect.width;
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [anchorRect]);

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

  return (
    <div ref={menuRef} className="create-doc-dropdown">
      <button className="create-doc-dropdown-item" onClick={() => onSelect()}>
        New Document
      </button>
    </div>
  );
}
