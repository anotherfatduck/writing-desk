import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentInfo, DraggedItem, DropIndicator } from './sidebar-types';

interface UseSidebarDragOptions {
  docs: DocumentInfo[];
  scrollRef: React.RefObject<HTMLDivElement>;
  setCollapsedSections: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectionRef?: React.RefObject<Set<string>>;
  onBulkMoved?: () => void;
}

export function useSidebarDrag({ docs, scrollRef, setCollapsedSections, selectionRef, onBulkMoved }: UseSidebarDragOptions) {
  const [draggedItem, setDraggedItem] = useState<DraggedItem>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const pendingDrag = useRef<DraggedItem>(null);
  const edgeScrollRaf = useRef<number | null>(null);
  const dragExpandTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DRAG_THRESHOLD = 5;

  const endDrag = useCallback(() => {
    setDraggedItem(null);
    setDropIndicator(null);
    pendingDrag.current = null;
    dragStartPos.current = null;
    if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
    if (dragExpandTimeout.current) { clearTimeout(dragExpandTimeout.current); dragExpandTimeout.current = null; }
    if (edgeScrollRaf.current) { cancelAnimationFrame(edgeScrollRaf.current); edgeScrollRaf.current = null; }
    document.body.style.userSelect = '';
  }, []);

  const executeDrop = useCallback((dragged: DraggedItem, indicator: DropIndicator | null) => {
    if (!dragged || dragged.type !== 'doc' || !indicator) return;
    const file = dragged.file;
    const afterId = indicator.afterId;

    const selected = selectionRef?.current;
    const isBulk = selected && selected.has(file) && selected.size > 1;

    const allFilenames = docs.map(d => d.filename);
    const reordered = [...allFilenames];
    const fromIdx = reordered.indexOf(file);
    if (fromIdx < 0) return;
    reordered.splice(fromIdx, 1);
    let toIdx = afterId ? reordered.indexOf(afterId) : -1;
    if (toIdx >= 0) toIdx += 1; else toIdx = 0;
    reordered.splice(toIdx, 0, file);

    if (isBulk) {
      // Cluster the rest of the selection immediately after the grabbed doc.
      let cursor = file;
      for (const other of selected) {
        if (other === file) continue;
        const idx = reordered.indexOf(other);
        if (idx < 0) continue;
        reordered.splice(idx, 1);
        const insertAt = reordered.indexOf(cursor) + 1;
        reordered.splice(insertAt, 0, other);
        cursor = other;
      }
      onBulkMoved?.();
    }

    fetch('/api/documents/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: reordered }),
    }).catch(() => {});
  }, [docs, selectionRef, onBulkMoved]);

  const resolveDropTarget = useCallback((x: number, y: number): DropIndicator | null => {
    const ghost = ghostRef.current;
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (ghost) ghost.style.display = '';
    if (!el) return null;

    const item = el.closest('[data-drag-id]') as HTMLElement | null;
    if (!item) {
      const section = el.closest('[data-drop-ws]') as HTMLElement | null;
      if (section) {
        return {
          itemId: '__section__', position: 'inside',
          wsFilename: section.dataset.dropWs === '__docs__' ? null : section.dataset.dropWs!,
          containerId: section.dataset.dropContainer || null, afterId: null,
        };
      }
      return null;
    }

    const targetId = item.dataset.dragId!;
    const rect = item.getBoundingClientRect();
    const ratio = (y - rect.top) / rect.height;
    const position = ratio < 0.5 ? 'before' : 'after';

    const siblings = docs.map(d => d.filename);
    const index = siblings.indexOf(targetId);
    let afterId: string | null = null;
    if (position === 'before') {
      afterId = index > 0 ? siblings[index - 1] : null;
    } else {
      afterId = index >= 0 ? siblings[index] : null;
    }

    return { itemId: targetId, position, wsFilename: null, containerId: null, afterId };
  }, [docs]);

  const updateEdgeScroll = useCallback((clientY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const EDGE = 80, MAX_SPEED = 18;
    let speed = 0;
    if (clientY < rect.top + EDGE) speed = -MAX_SPEED * Math.max(0, 1 - (clientY - rect.top) / EDGE);
    else if (clientY > rect.bottom - EDGE) speed = MAX_SPEED * Math.max(0, 1 - (rect.bottom - clientY) / EDGE);
    if (edgeScrollRaf.current) { cancelAnimationFrame(edgeScrollRaf.current); edgeScrollRaf.current = null; }
    if (speed !== 0) {
      const tick = () => { el.scrollTop += speed; edgeScrollRaf.current = requestAnimationFrame(tick); };
      edgeScrollRaf.current = requestAnimationFrame(tick);
    }
  }, [scrollRef]);

  const updateDragExpand = useCallback((x: number, y: number) => {
    const ghost = ghostRef.current;
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (ghost) ghost.style.display = '';
    const header = el?.closest('[data-section-key]') as HTMLElement | null;
    if (!header) {
      if (dragExpandTimeout.current) { clearTimeout(dragExpandTimeout.current); dragExpandTimeout.current = null; }
      return;
    }
    const key = header.dataset.sectionKey!;
    if (dragExpandTimeout.current) clearTimeout(dragExpandTimeout.current);
    dragExpandTimeout.current = setTimeout(() => {
      setCollapsedSections(prev => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 500);
  }, [setCollapsedSections]);

  useEffect(() => {
    if (!draggedItem) return;
    const onPointerMove = (e: PointerEvent) => {
      if (ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX + 12}px`;
        ghostRef.current.style.top = `${e.clientY - 8}px`;
      }
      setDropIndicator(resolveDropTarget(e.clientX, e.clientY));
      updateEdgeScroll(e.clientY);
      updateDragExpand(e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      executeDrop(draggedItem, resolveDropTarget(e.clientX, e.clientY));
      endDrag();
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [draggedItem, resolveDropTarget, executeDrop, endDrag, updateEdgeScroll, updateDragExpand]);

  const handlePointerDown = useCallback((e: React.PointerEvent, item: DraggedItem, label: string) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, button, .sidebar-tag-remove, .sidebar-tag-add, .sidebar-delete-btn, .sidebar-confirm-delete, .sidebar-inline-confirm')) return;

    dragStartPos.current = { x: e.clientX, y: e.clientY };
    pendingDrag.current = item;

    const onMove = (me: PointerEvent) => {
      if (!dragStartPos.current || !pendingDrag.current) return;
      const dx = me.clientX - dragStartPos.current.x;
      const dy = me.clientY - dragStartPos.current.y;
      if (Math.abs(dx) + Math.abs(dy) >= DRAG_THRESHOLD) {
        document.body.style.userSelect = 'none';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDraggedItem(pendingDrag.current);
        pendingDrag.current = null;
        const ghost = document.createElement('div');
        ghost.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;padding:4px 10px;background:var(--bg-surface, white);border:1px solid var(--border, #cbd5e1);border-radius:6px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.12);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-dark, #334155);';
        ghost.textContent = label;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
        ghost.style.left = `${me.clientX + 12}px`;
        ghost.style.top = `${me.clientY - 8}px`;
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragStartPos.current = null;
      pendingDrag.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const dropClass = (itemId: string): string => {
    if (!dropIndicator || dropIndicator.itemId !== itemId) return '';
    if (dropIndicator.position === 'before') return 'drop-before';
    if (dropIndicator.position === 'after') return 'drop-after';
    if (dropIndicator.position === 'inside') return 'drop-inside';
    return '';
  };

  const isDragging = (id: string): boolean => {
    if (!draggedItem) return false;
    if (draggedItem.type === 'doc') return draggedItem.file === id;
    return false;
  };

  return { draggedItem, dropIndicator, handlePointerDown, dropClass, isDragging };
}
