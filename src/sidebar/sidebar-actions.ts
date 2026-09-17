import { useCallback } from 'react';
import type { DocumentInfo, SidebarActions } from './sidebar-types';

export function useSidebarActions(
  fetchDocs: () => void,
  setDocs: React.Dispatch<React.SetStateAction<DocumentInfo[]>>,
  docs: DocumentInfo[],
  markPendingDelete?: (filename: string) => void,
  unmarkPendingDelete?: (filename: string) => void,
  onActiveDocRenamed?: (title: string) => void,
): SidebarActions {

  const handleDelete = useCallback((filename: string) => {
    setDocs(prev => prev.filter(d => d.filename !== filename));
    markPendingDelete?.(filename);
    fetch(`/api/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          let message = text;
          try {
            const parsed = JSON.parse(text);
            if (parsed.error) message = parsed.error;
          } catch { /* use raw text */ }
          window.alert(message);
          unmarkPendingDelete?.(filename);
          fetchDocs();
        }
      })
      .catch(() => {
        unmarkPendingDelete?.(filename);
        fetchDocs();
      });
  }, [setDocs, fetchDocs, markPendingDelete, unmarkPendingDelete]);

  const handleRename = useCallback((filename: string, originalTitle: string, newTitle: string) => {
    if (!newTitle.trim() || newTitle.trim() === originalTitle) return;
    setDocs(prev => prev.map(d => d.filename === filename ? { ...d, title: newTitle.trim() } : d));
    if (docs.find(d => d.isActive)?.filename === filename) onActiveDocRenamed?.(newTitle.trim());
    fetch(`/api/documents/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() }),
    }).then(r => {
      if (!r.ok) throw new Error(`rename failed (${r.status})`);
    }).catch(() => {
      // Optimistic-surface rollback: the eager title updates above must not
      // outlive their PUT (final-review minor). fetchDocs() heals the sidebar
      // rows; the titlebar needs the explicit restore.
      fetchDocs();
      if (docs.find(d => d.isActive)?.filename === filename) onActiveDocRenamed?.(originalTitle);
    });
  }, [setDocs, fetchDocs, docs, onActiveDocRenamed]);

  const getDocTags = useCallback((docFile: string): string[] => {
    const doc = docs.find(d => d.filename === docFile);
    return doc?.tags ?? [];
  }, [docs]);

  const handleAddTag = useCallback((docFile: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setDocs(prev => prev.map(d => {
      if (d.filename !== docFile) return d;
      const existing = d.tags ?? [];
      if (existing.includes(trimmed)) return d;
      return { ...d, tags: [...existing, trimmed] };
    }));
    fetch(`/api/doc-tags/${encodeURIComponent(docFile)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: trimmed }),
    }).catch(() => {});
  }, [setDocs]);

  const handleRemoveTag = useCallback((docFile: string, tag: string) => {
    setDocs(prev => prev.map(d => {
      if (d.filename !== docFile) return d;
      const existing = d.tags ?? [];
      const filtered = existing.filter(t => t !== tag);
      if (filtered.length === existing.length) return d;
      return filtered.length > 0 ? { ...d, tags: filtered } : { ...d, tags: undefined };
    }));
    fetch(`/api/doc-tags/${encodeURIComponent(docFile)}/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }, [setDocs]);

  return {
    fetchDocs,
    handleDelete,
    handleRename,
    getDocTags,
    handleAddTag,
    handleRemoveTag,
  };
}
