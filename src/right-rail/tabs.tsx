/**
 * Right-rail tab registry. Order here is the order tabs render in the strip.
 *
 * writer-app keeps the openwriter rail shell but registers only the tabs we
 * use: Review, Chat, History, Appearance. The settings-scope divider sits
 * before Appearance, matching the fork's structure.
 *
 * adr: adr/right-rail.md
 */
import type { TabDefinition, TabId } from './types';
import { ReviewIcon, ChatIcon, VersionsIcon, HelpIcon, AppearanceIcon } from './icons';
import ReviewTab from './tabs/ReviewTab';
import { ChatTab } from './tabs/ChatTab';
import VersionsTab from './tabs/VersionsTab';
import HelpTab from './tabs/HelpTab';
import AppearanceTab from './tabs/AppearanceTab';

export const TAB_REGISTRY: TabDefinition[] = [
  { id: 'review',    label: 'Review',  scope: 'doc',      icon: <ReviewIcon />,    Component: ReviewTab },
  { id: 'chat',      label: 'Chat',    scope: 'doc',      icon: <ChatIcon />,      Component: ChatTab },
  { id: 'history',   label: 'History', scope: 'doc',      icon: <VersionsIcon />,  Component: VersionsTab },
  { id: 'help',     label: 'Help',    scope: 'settings', icon: <HelpIcon />,      Component: HelpTab },
  { id: 'appearance', label: 'Appearance', scope: 'settings', icon: <AppearanceIcon />, Component: AppearanceTab },
];

export function findTab(id: TabId | null): TabDefinition | null {
  if (!id) return null;
  return TAB_REGISTRY.find((t) => t.id === id) ?? null;
}
