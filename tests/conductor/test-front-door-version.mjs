// Login footer version — pages.login renders the app version; the boot read
// degrades to 'unknown' rather than erroring (spec: login footer, quiet fail).
// The pages module is template strings with no side effects — dist import.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const pagesPath = fileURLToPath(new URL('../../dist/server/front-door/pages.js', import.meta.url));
if (!existsSync(pagesPath)) {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { cwd: REPO, stdio: 'ignore' });
}
const { pages } = await import(pathToFileURL(pagesPath).href);
const { readAppVersion } = await import(new URL('../../dist/server/front-door/version.js', import.meta.url).href);

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const html = pages.login('Test Site', '9.9.9');
assert(html.includes('writer app v9.9.9'), 'login footer carries the version line');
// Default param keeps the single-arg call sites valid: no version → no line.
const bare = pages.login('Test Site');
assert(!bare.includes('writer app v'), 'login without a version renders no version line');
// The real read: the repo's own package.json, or 'unknown' — both fine.
assert(/^(unknown|\d+\.\d+\.\d+)$/.test(readAppVersion()), `readAppVersion is a version or 'unknown' (got ${readAppVersion()})`);
// The version text is escaped before interpolation (house rule for pages.ts).
// (The page legitimately contains <script> for its form — check the version
// text itself was not injected raw.)
const sneaky = pages.login('Test Site', '9.9.9<script>');
assert(!sneaky.includes('v9.9.9<script>'), 'version text is escaped in the footer');

if (failed) { console.error(`test-front-door-version: ${failed} failing`); process.exit(1); }
console.log('test-front-door-version: ok');
