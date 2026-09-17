// tests/packaging/test-render-splice.mjs — pure render + splice idempotency.
import { renderNginxBlock } from '../../packaging/lib/render.mjs';
import { spliceManagedBlock } from '../../packaging/lib/nginx-splice.mjs';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const UPSTREAM = 'http://127.0.0.1:5051';

// Render: markers, proxy_pass, WS headers, forwarded headers.
const block = renderNginxBlock({ upstream: UPSTREAM });
assert(block.includes('## writing-desk BEGIN') && block.includes('## writing-desk END'), 'render has both markers');
assert(block.includes('proxy_pass http://127.0.0.1:5051;'), 'render carries the upstream');
for (const want of ['proxy_http_version 1.1', 'Upgrade $http_upgrade', 'Connection $connection_upgrade', 'X-Forwarded-Proto', 'X-Forwarded-For', 'proxy_set_header Host', 'proxy_read_timeout 600s']) {
  assert(block.includes(want), `render carries ${want}`);
}
assert(block.split('## writing-desk BEGIN').length === 2, 'exactly one BEGIN marker');

// Splice: insert → replace → idempotent → half-marker refusal.
const vhost = '# infra vhost\nserver {\n  server_name _;\n  location /healthz { return 200; }\n}\n';
const first = spliceManagedBlock(vhost, block);
assert(!first.error && first.out.includes('location / {') && first.out.includes('# infra vhost'), 'insert keeps infra content + adds block');
const second = spliceManagedBlock(first.out, renderNginxBlock({ upstream: 'http://127.0.0.1:6061' }));
assert(!second.error && second.out.includes('proxy_pass http://127.0.0.1:6061;'), 'replace updates between markers');
assert(!second.out.includes('proxy_pass http://127.0.0.1:5051;'), 'replace removes the old block');
const third = spliceManagedBlock(second.out, renderNginxBlock({ upstream: 'http://127.0.0.1:6061' }));
assert(!third.error && third.changed === false && third.out === second.out, 'idempotent re-splice is a no-op');
const half = vhost + '## writing-desk BEGIN\n';
assert(spliceManagedBlock(half, block).error, 'half-managed (one marker) refused');

// Placement: the claim must land INSIDE the server block — replacing the
// placeholder's `location /` (a second one is a duplicate-location error);
// appending at file scope is invalid nginx. Real infra placeholder shape:
const infraVhost = [
  'server {',
  '    listen 443 ssl default_server;',
  '    server_name _;',
  '',
  '    ssl_certificate /etc/step/certs/writer-host-01.crt;',
  '    ssl_certificate_key /etc/step/certs/writer-host-01.key;',
  '    ssl_protocols TLSv1.2 TLSv1.3;',
  '',
  '    root /srv/writer-app/placeholder;',
  '    index index.html;',
  '',
  '    location / {',
  '        try_files $uri $uri/ =404;',
  '    }',
  '}',
  '',
].join('\n');
const claim = spliceManagedBlock(infraVhost, block);
assert(!claim.error, 'infra-shape claim has no error');
const beginIdx = claim.out.indexOf('## writing-desk BEGIN');
const closeIdx = claim.out.lastIndexOf('}');
assert(beginIdx > -1 && beginIdx < closeIdx, 'managed block lands inside the server block');
assert(claim.out.trimEnd().endsWith('}'), 'file still closes with the server block');
assert(claim.out.split('location / {').length === 2, 'exactly one location / (claim replaced the placeholder)');
assert(!claim.out.includes('try_files'), 'placeholder try_files location is replaced');
assert(claim.out.includes('listen 443 ssl default_server;'), 'infra content preserved');
const reClaim = spliceManagedBlock(claim.out, renderNginxBlock({ upstream: 'http://127.0.0.1:6061' }));
assert(!reClaim.error && reClaim.out.includes('proxy_pass http://127.0.0.1:6061;'), 're-claim on claimed vhost updates in place');
assert(reClaim.out.split('location / {').length === 2, 're-claim leaves exactly one location /');
// Fallback: no `location /` (only /healthz) — block must still land inside the server block.
const noSlash = spliceManagedBlock(vhost, block);
const nb = noSlash.out.indexOf('## writing-desk BEGIN');
assert(nb > -1 && nb < noSlash.out.lastIndexOf('}'), 'fallback insert lands inside the server block');

// CLI splice follows a symlinked vhost and edits the real file (Debian sites-enabled convention).
{
  const d = mkdtempSync(join(tmpdir(), 'content-repo-splice-'));
  const real = join(d, 'real.conf');
  const link = join(d, 'link.conf');
  const blockFile = join(d, 'block.conf');
  const vhostSrc = '# infra vhost\nserver {\n  server_name _;\n  location /healthz { return 200; }\n}\n';
  writeFileSync(real, vhostSrc);
  symlinkSync(real, link);
  writeFileSync(blockFile, renderNginxBlock({ upstream: UPSTREAM }));
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packaging', 'lib', 'nginx-splice.mjs');
  const run = spawnSync('node', [script, link, blockFile], { encoding: 'utf8' });
  assert(run.status === 0, 'CLI splice against symlink exits 0');
  const after = readFileSync(real, 'utf8');
  assert(after.includes('## writing-desk BEGIN'), 'symlink splice edits the real file behind the link');
  assert(lstatSync(link).isSymbolicLink(), 'symlink entry is still a symlink');
  assert(realpathSync(link) === real, 'symlink still resolves to the real file after splice');
  rmSync(d, { recursive: true });
}

console.log(failed ? `test-render-splice: ${failed} FAILURES` : 'test-render-splice: all ok');
process.exit(failed ? 1 : 0);
