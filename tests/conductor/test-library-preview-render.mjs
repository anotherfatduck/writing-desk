// Library preview renderer — mirror body markdown → HTML for the preview panel.
// House pattern: conductor tests import the compiled dist (build if missing).
// adr: none (spec: docs/superpowers/specs/2026-09-17-library-preview-and-version-design.md)
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const distPath = fileURLToPath(new URL('../../dist/server/library-render.js', import.meta.url));
if (!existsSync(distPath)) {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { cwd: REPO, stdio: 'ignore' });
}
const { renderLibraryPreview } = await import(pathToFileURL(distPath).href);

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)})`);

// headings/bold/paragraphs render as HTML, not source
eq(renderLibraryPreview('## Head\n\nSome **bold** text.\n'),
   '<h2>Head</h2>\n<p>Some <strong>bold</strong> text.</p>\n', 'headings/bold render as HTML');
// lists
assert(renderLibraryPreview('- one\n- two\n').includes('<ul>'), 'lists render as ul');
// footnote syntax (the corpus uses it; the editor parses it too)
const fn = renderLibraryPreview('A claim.[^1]\n\n[^1]: The note.\n');
assert(fn.includes('footnote'), 'footnotes render footnote markup');
// raw HTML is escaped — shows as text, never runs (html:false is the point)
const esc = renderLibraryPreview('Hello <script>alert(1)</script>\n');
assert(!esc.includes('<script>'), 'raw HTML never reaches the output');
assert(esc.includes('&lt;script&gt;'), 'raw HTML shows as escaped text');
// other raw HTML — attributes and void tags alike — never reaches the output
const img = renderLibraryPreview('<img src=x onerror=alert(1)> and <b>raw</b>\n');
assert(!img.includes('<img') && !img.includes('<b>'), 'other raw HTML (img/b) escaped to text');
// empty body → empty string (the panel falls back to <pre>/Loading…)
eq(renderLibraryPreview(''), '', 'empty body renders empty');

if (failed) { console.error(`test-library-preview-render: ${failed} failing`); process.exit(1); }
console.log('test-library-preview-render: ok');
