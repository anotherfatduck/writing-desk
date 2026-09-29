/**
 * Library preview renderer — mirror body markdown → HTML for the sidebar
 * preview panel. Separate from markdown-parse.ts (that one feeds the editor's
 * node model and renders raw HTML inside it): this one produces HTML for
 * innerHTML directly, so raw HTML is ESCAPED (html:false) — pasted tags show
 * as text, never run. Same plugin set as the editor parser so the footnote /
 * highlight syntax writers actually use renders.
 */
import MarkdownIt from 'markdown-it';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import markdownItFootnote from 'markdown-it-footnote';

const md = new MarkdownIt({ linkify: false, html: false });
md.use(markdownItIns);
md.use(markdownItMark);
md.use(markdownItSub);
md.use(markdownItSup);
md.use(markdownItFootnote);

/** Render a library preview body to HTML. Empty body → empty string. */
export function renderLibraryPreview(body: string): string {
  return md.render(body ?? '');
}
