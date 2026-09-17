import type { PendingDocsPayload } from '../ws/client';

export interface DocumentInfo {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  archivedAt?: string;
  docId?: string;
  tags?: string[];
  /** Non-null when this desk doc was adopted (checked out) from the library —
   *  the library key (`<writerId>/<docId>`) the app-server stamped on it.
   *  Gates the "Return to library" affordance. */
  libraryKey?: string | null;
  /** ISO timestamp stamped at adopt; null for docs adopted before the stamp existed. */
  libraryAdoptedAt?: string | null;
  reviewGate?: { phase: 'submitted' | 'in-review' | 'published' | 'returned' | 'conflict'; since: string } | null;
}

/** One shelf article as `GET /api/library` serves it. The server derives the
 *  taxonomy ∪ (spec §3) — the client renders, it does not re-derive. */
export interface LibraryArticleInfo {
  docId: string;
  /** Library key (`<writerId>/<docId>`); null when the mirror is absent from
   *  the index (not adoptable). */
  key: string | null;
  title: string;
  /** Series name — the folder this article files under (null = unfiled). */
  series: string | null;
  /** Topics render as tags on the row, not as folders (spec §3). */
  topics: string[];
  publishedAt: string | null;
  /** A desk doc on this writer's desk holds this docId (the adopt guard's
   *  409 test) — the shelf row shows the "checked out" chip and Adopt
   *  disables. */
  checkedOut: boolean;
}

export interface LibraryListing {
  articles: LibraryArticleInfo[];
  categories: { series: string[]; topics: string[] };
}

/** Everything the Library section needs — one prop threaded App → Sidebar →
 *  SidebarFiles, rather than three. */
export interface LibrarySectionProps {
  data: LibraryListing | null;
  /** Manual re-read of the shelf (the librarian writes it out of band). */
  refresh: () => void;
  /** An adopt/restore succeeded — bump both refresh keys (the desk and the
   *  shelf both changed). */
  onMutated: () => void;
}

export interface DocItem { type: 'doc'; file: string; title: string; }

export interface WorkspaceInfo { filename: string; title: string; docCount: number }
export interface WorkspaceFull {
  version: 2;
  title: string;
  root: DocItem[];
}

export type WorkspaceWithData = WorkspaceInfo & { workspace?: WorkspaceFull };

export type DraggedItem =
  | { type: 'doc'; file: string; sourceWs: string | null }
  | { type: 'workspace'; filename: string }
  | null;

export interface DropIndicator {
  itemId: string;
  position: 'before' | 'after' | 'inside';
  wsFilename: string | null;
  containerId: string | null;
  afterId: string | null;
}

export interface SearchResult {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  matchType: 'title' | 'tag' | 'content';
  snippet: string | null;
  matchedTag: string | null;
  isArchived?: boolean;
}

export interface SidebarModeProps {
  docs: DocumentInfo[];
  archivedDocs: DocumentInfo[];
  workspaces: WorkspaceWithData[];
  pendingDocs: PendingDocsPayload;
  onSwitchDocument: (filename: string) => void;
  onCreateDocument: () => void;
  actions: SidebarActions;
  scrollRef: React.RefObject<HTMLDivElement>;
  pendingWriteFilenames?: Set<string>;
  writingTitle?: string | null;
  writingTarget?: { wsFilename: string; containerId: string | null; parentDocId?: string } | null;
  searchQuery: string;
  searchResults: SearchResult[] | null;
  onSearchChange: (query: string) => void;
  /** The Library shelf (second section) — read-only rows + adopt/preview. */
  library: LibrarySectionProps;
}

export interface SidebarActions {
  fetchDocs: () => void;
  handleDelete: (filename: string) => void;
  handleRename: (filename: string, originalTitle: string, newTitle: string) => void;
  getDocTags: (docFile: string) => string[];
  handleAddTag: (docFile: string, tag: string) => void;
  handleRemoveTag: (docFile: string, tag: string) => void;
}
