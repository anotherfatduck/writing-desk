/**
 * Tour state — framework-free core of the first-run tutorial.
 * Spec: docs/superpowers/specs/2026-09-13-tour-content-design.md
 *
 * The flag is per-WRITER (userId from /api/session), not per-browser —
 * ux-findings F6: a browser-global flag means writer #2 on a shared
 * machine never sees the tour. Storage denied → hasSeenTour() returns
 * true so a broken-store browser is never nagged on every reload.
 */

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector for the spotlight target. Unresolvable target → centered card + phantom dim. */
  target: string;
  /** Declarative setup the overlay interprets before the step renders. */
  ensureSidebar?: boolean;
  /** Sidebar section key whose header is clicked open if collapsed (e.g. 'library', 'docs'). */
  expandSection?: string;
  openRailTab?: 'review' | 'chat' | 'history' | 'help' | 'appearance';
}

// Copy verbatim from the tour-content spec's step script (titles = bold labels,
// bodies = quoted copy). Create-first re-order per the shape ruling (c) 2026-09-13.
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    body: 'Welcome to your writing desk. This is your personal space for drafts — everything you write lives here. The tour takes a minute and walks the whole flow.',
    target: '',
  },
  {
    id: 'create',
    title: 'Start a piece',
    body: 'The + button opens a fresh document on your desk. Name it by double-clicking its title at the top.',
    target: '[data-tour-id="create"]',
    ensureSidebar: true,
    expandSection: 'docs',
  },
  {
    id: 'editor',
    title: 'The editor',
    body: 'This is where you write. Everything saves as you type.',
    target: '.tiptap',
  },
  {
    id: 'review',
    title: 'Review tab',
    body: 'When the article is done, submit it for approval here.',
    target: '[data-tour-id="review"]',
    openRailTab: 'review',
  },
  {
    id: 'chips',
    title: 'Lifecycle chips',
    body: 'These chips track your article: in review → returned with notes → in library.',
    target: '.files-section-list[data-drop-ws="__docs__"]',
    ensureSidebar: true,
    expandSection: 'docs',
  },
  {
    id: 'library',
    title: 'Library shelf',
    body: 'The library holds approved articles — when one of yours is published, it lands here.',
    target: '.files-library .files-row.is-section',
    ensureSidebar: true,
    expandSection: 'library',
  },
  {
    id: 'adopt',
    title: 'Adopt',
    body: 'Adopt checks an article out to your desk. Your copy is yours to edit.',
    target: '.library-adopt',
    ensureSidebar: true,
    expandSection: 'library',
  },
  {
    id: 'chat',
    title: 'Your agent',
    body: 'Your writing agent. Ask for a change and it proposes edits right on your draft — you approve before anything sticks.',
    target: '[data-tour-id="chat"]',
    openRailTab: 'chat',
  },
  {
    id: 'history',
    title: 'Snapshots',
    body: 'History keeps a snapshot of your work automatically. Every version is saved — you can always look back or restore one.',
    target: '[data-tour-id="history"]',
    openRailTab: 'history',
  },
  {
    id: 'appearance',
    title: 'Make it yours',
    body: 'Light or dark, typeface, spacing — set the desk up the way you like to write.',
    target: '[data-tour-id="appearance"]',
    openRailTab: 'appearance',
  },
  {
    id: 'help',
    title: 'Help',
    body: "The Help tab is this desk's guide — with a button to replay this tour anytime.",
    target: '[data-tour-id="help"]',
    openRailTab: 'help',
  },
  {
    id: 'done',
    title: 'Done',
    body: "That's the flow: create, write, submit, return. Details live in the Help tab (the ? icon).",
    target: '',
  },
];

export const tourFlagKey = (userId: string): string => `ow-tour-seen:${userId}`;

export function hasSeenTour(userId: string): boolean {
  try { return !!localStorage.getItem(tourFlagKey(userId)); } catch { return true; }
}

export function markTourSeen(userId: string): void {
  try { localStorage.setItem(tourFlagKey(userId), '1'); } catch { /* storage denied — tour may replay; never nag */ }
}
