import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';

import { padExtensions } from './extensions';
import type { Extensions } from '@tiptap/react';
import FloatingToolbar from './FloatingToolbar';
import { createPendingDecorationPlugin, isPreviewActive } from '../decorations/plugin';
import { cleanPastedHTML } from './pasteCleanup';
import { parseLinkHref, type ParsedLinkHref } from './link-href';
import './footnotes.css';

interface PadEditorProps {
  initialContent?: any;
  extensions?: Extensions;
  onUpdate?: (json: any) => void;
  onReady?: (editor: Editor) => void;
  onLinkClick?: (target: ParsedLinkHref) => void;
  /** Writer picked "Discuss with agent" on a selection — hand the quote up. */
  onDiscussSelection?: (quote: { text: string; paraIds: string[] }) => void;
}

export default function PadEditor({ initialContent, extensions, onUpdate, onReady, onLinkClick, onDiscussSelection }: PadEditorProps) {
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const onDiscussSelectionRef = useRef(onDiscussSelection);
  onDiscussSelectionRef.current = onDiscussSelection;

  // The editor instance is stable across doc-switches. Content updates land
  // via the setContent effect below, not by destroying and recreating the
  // editor. Empty deps means useEditor runs once on mount; the editor
  // persists for the component lifetime, avoiding per-switch ProseMirror
  // teardown + decoration-rebuild latency.
  // adr: adr/0005-pending-overlay-model.md
  const editor = useEditor({
    extensions: extensions || padExtensions,
    content: initialContent || '<p></p>',
    onUpdate: ({ editor }) => {
      if (isPreviewActive()) return; // Skip sync during original/modified preview
      onUpdate?.(editor.getJSON());
    },
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
      transformPastedHTML: cleanPastedHTML,
    },
  }, []);

  // Content-prop watcher: when `initialContent` changes (doc-switch,
  // external-write reload, restore_version), swap content via setContent
  // instead of remounting. emitUpdate=false suppresses the onUpdate that
  // would otherwise round-trip back as a spurious doc-update — the client
  // diff-gate would catch it, but cheaper to skip the round-trip entirely.
  // Strict equality on the reference is enough: the WS layer hands us the
  // same object across re-renders unless the doc actually changed.
  const lastContentRef = useRef<any>(initialContent);
  useEffect(() => {
    if (!editor || !initialContent) return;
    if (lastContentRef.current === initialContent) return;
    lastContentRef.current = initialContent;
    const tStart = performance.now();
    editor.commands.setContent(initialContent, { emitUpdate: false });
    const tEnd = performance.now();
    const ls = (window as any).__lastSwitch;
    if (ls && ls.tClick) {
      console.log(`[Editor] setContent t=${tEnd.toFixed(0)} duration=${(tEnd - tStart).toFixed(1)}ms fromClick=${(tEnd - ls.tClick).toFixed(1)}ms fromReceive=${ls.tReceive ? (tEnd - ls.tReceive).toFixed(1) : '?'}ms`);
    } else {
      console.log(`[Editor] setContent t=${tEnd.toFixed(0)} duration=${(tEnd - tStart).toFixed(1)}ms (no matching switch)`);
    }
  }, [editor, initialContent]);

  // First-mount log (for correlation with [Switch] CLICK on initial page load).
  useEffect(() => {
    if (!editor) return;
    console.log(`[Editor] first mount t=${performance.now().toFixed(0)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Intercept link clicks directly on the DOM (bypasses ProseMirror event chain).
  // Internal doc: links route to onLinkClick; external http/https/mailto open in
  // a new tab. PadLink is configured with openOnClick:false so TipTap won't do it.
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Internal doc: link
      const docLink = target.closest('span.doc-link[data-doc]');
      if (docLink) {
        const dataDoc = docLink.getAttribute('data-doc')!;
        // data-doc is everything after `doc:` — re-parse via the canonical helper.
        const parsed = parseLinkHref(`doc:${dataDoc}`);
        if (!parsed) return;
        onLinkClickRef.current?.(parsed);
        return;
      }
      // External link — open in new tab. Skip Cmd/Ctrl/middle clicks; the
      // browser handles those itself (and cmd-click already opens in new tab).
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      // Only open links whose protocol the browser can navigate to
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    el.addEventListener('click', handleClick, true); // capture phase
    return () => el.removeEventListener('click', handleClick, true);
  }, [editor]);

  // Register the pending decoration plugin (guard against double-add in React strict mode)
  useEffect(() => {
    if (!editor) return;
    const { state } = editor.view;
    if (state.plugins.some((p: any) => p.key === 'pendingDecoration$')) return;
    const plugin = createPendingDecorationPlugin();
    const newState = state.reconfigure({ plugins: [...state.plugins, plugin] });
    editor.view.updateState(newState);
  }, [editor]);

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  if (!editor) return null;

  return (
    <>
      <EditorContent editor={editor} />
      <FloatingToolbar
        editor={editor}
        onDiscuss={(quote) => onDiscussSelectionRef.current?.(quote)}
      />
    </>
  );
}
