import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateManifest } from '../../packaging/lib/validate-manifest.mjs';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

function goodStage() {
  const s = mkdtempSync(join(tmpdir(), 'content-repo-stage-'));
  for (const d of ['DEBIAN', 'opt/writing-desk/dist/bin', 'opt/writing-desk/dist-orchestrator/bin', 'opt/writing-desk/lib',
    'opt/writing-desk/node_modules/express', 'opt/writing-desk/node_modules/ws', 'opt/writing-desk/node_modules/zod',
    'opt/writing-desk/node_modules/gray-matter', 'etc/writing-desk', 'etc/nginx/conf.d', 'usr/lib/systemd/system',
    'usr/lib/writing-desk/templates', 'var/lib/writing-desk']) mkdirSync(join(s, d), { recursive: true });
  writeFileSync(join(s, 'DEBIAN/control'), 'Package: writing-desk\nVersion: 0.1.0\nArchitecture: all\nDepends: nodejs (>= 22)\n');
  writeFileSync(join(s, 'DEBIAN/postinst'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(s, 'DEBIAN/postinst'), 0o755);
  writeFileSync(join(s, 'DEBIAN/conffiles'), '/etc/writing-desk/orchestrator.config.json\n/etc/writing-desk/upstream\n');
  writeFileSync(join(s, 'opt/writing-desk/dist/bin/front-door.js'), '// stub');
  writeFileSync(join(s, 'opt/writing-desk/dist-orchestrator/bin/orchestrator.js'), '// stub');
  for (const d of ['express', 'ws', 'zod', 'gray-matter']) writeFileSync(join(s, `opt/writing-desk/node_modules/${d}/package.json`), '{}');
  writeFileSync(join(s, 'opt/writing-desk/lib/render.mjs'), 'export {}');
  writeFileSync(join(s, 'opt/writing-desk/lib/nginx-splice.mjs'), 'export {}');
  writeFileSync(join(s, 'etc/writing-desk/orchestrator.config.json'), '{}');
  writeFileSync(join(s, 'etc/writing-desk/upstream'), 'http://127.0.0.1:5051\n');
  writeFileSync(join(s, 'etc/writing-desk/app.env'), 'AGENT_MODEL=local-model-xhigh\n');
  writeFileSync(join(s, 'etc/nginx/conf.d/writing-desk-map.conf'), 'map $http_upgrade $connection_upgrade {}\n');
  writeFileSync(join(s, 'usr/lib/systemd/system/writing-desk.service'), '[Service]\n');
  writeFileSync(join(s, 'usr/lib/systemd/system/writing-desk-orchestrator.service'), '[Service]\n');
  writeFileSync(join(s, 'usr/lib/systemd/system/writing-desk-cloudflared.service'), '[Service]\n');
  writeFileSync(join(s, 'usr/lib/writing-desk/templates/writer.env.example'), 'OW_PORT=5051\n');
  return s;
}

{
  const s = goodStage();
  const r = validateManifest(s);
  assert(r.ok === true, `good stage validates (errors: ${r.errors.join('; ')})`);
}
{
  const s = goodStage();
  chmodSync(join(s, 'DEBIAN/postinst'), 0o644); // lost exec bit
  const r = validateManifest(s);
  assert(r.ok === false && r.errors.some((e) => e.includes('postinst')), 'non-executable postinst caught');
}
{
  const s = goodStage();
  writeFileSync(join(s, 'DEBIAN/control'), 'Package: writing-desk\n'); // no Version/Depends
  const r = validateManifest(s);
  assert(r.ok === false && r.errors.some((e) => e.includes('Version')) && r.errors.some((e) => e.includes('Depends')), 'missing control fields caught');
}
{
  const s = goodStage();
  rmSync(join(s, 'opt/writing-desk/node_modules/ws'), { recursive: true });
  const r = validateManifest(s);
  assert(r.ok === false && r.errors.some((e) => e.includes('ws')), 'missing runtime dep caught');
}
{
  const s = goodStage();
  rmSync(join(s, 'etc/writing-desk/upstream'));
  const r = validateManifest(s);
  assert(r.ok === false && r.errors.some((e) => e.includes('conffile')), 'dangling conffile caught');
}

console.log(failed ? `test-manifest: ${failed} FAILURES` : 'test-manifest: all ok');
process.exit(failed ? 1 : 0);
