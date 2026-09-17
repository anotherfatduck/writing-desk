import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentInfo, LibraryListing } from './sidebar-types';
import type { PendingDocsPayload } from '../ws/client';

// writer-app adapter: one endpoint serves the whole tree. /api/documents has
// no workspace field (server-side workspaces are config-managed and unrouted),
// so workspaces is empty and every doc renders in the loose-docs section —
// the same information today's WorkspaceList showed, in openwriter's tree.
// Spec §4 (resolved open item 1). Grouping lands when the payload exposes it.
export function useSidebarData(refreshKey: number, _pendingDocs: PendingDocsPayload) {
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingDeletesRef = useRef<Set<string>>(new Set());
  const markPendingDelete = useCallback((filename: string) => { pendingDeletesRef.current.add(filename); }, []);
  const unmarkPendingDelete = useCallback((filename: string) => { pendingDeletesRef.current.delete(filename); }, []);

  const fetchDocs = useCallback(() => {
    fetch('/api/documents')
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        const pending = pendingDeletesRef.current;
        if (pending.size > 0) {
          const fresh = new Set(data.map((d: DocumentInfo) => d.filename));
          for (const fn of [...pending]) if (!fresh.has(fn)) pending.delete(fn);
        }
        setDocs(pending.size > 0 ? data.filter((d: DocumentInfo) => !pending.has(d.filename)) : data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs, refreshKey]);

  const workspaces = useMemo(() => [] as never[], []);
  return { docs, setDocs, workspaces, scrollRef, markPendingDelete, unmarkPendingDelete, fetchDocs };
}

/**
 * The Library shelf listing (spec §3). The server does the derivation — this
 * hook only reads and renders its payload. Refetch fires on the `refreshKey`
 * bump (the App bumps it on the `library-changed` WS push) and on demand via
 * `refresh` (the librarian writes the shelf out of band, so a manual re-read
 * is a normal thing to want).
 */
export function useLibraryData(refreshKey: number) {
  const [data, setData] = useState<LibraryListing | null>(null);

  const refresh = useCallback(() => {
    fetch('/api/library')
      .then((res) => res.json())
      .then((d) => {
        if (d && Array.isArray(d.articles) && d.categories) setData(d);
      })
      .catch(() => { /* no shelf endpoint — leave the section empty */ });
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  return { data, refresh };
}
