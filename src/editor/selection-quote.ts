/**
 * Selection → chat quote. Shared by the two entry points that hand the
 * writer's selection to the companion: the floating toolbar's Discuss button
 * and the chat composer's click-into-focus capture. Text is read with
 * paragraph breaks; paraIds are the node ids the companion's propose_edits
 * targets (the node-id map it reads via read_document).
 */
import type { Editor } from '@tiptap/react';

export interface ChatQuote {
  text: string;
  paraIds: string[];
}

export function collectSelectionQuote(editor: Editor): ChatQuote | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, '\n');
  if (!text.trim()) return null;
  const paraIds = new Set<string>();
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.attrs?.id) paraIds.add(String(node.attrs.id));
    return true; // descend into wrappers so list items etc. are collected too
  });
  return { text, paraIds: [...paraIds] };
}