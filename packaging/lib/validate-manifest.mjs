/** Stage-manifest validator (pure): the exact contract scripts/build-deb assembles.
 *  Returns { ok, errors[] }; build-deb gates the dpkg-deb call on ok. */
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

export function validateManifest(stageRoot) {
  const errors = [];
  const controlPath = join(stageRoot, 'DEBIAN/control');
  if (!existsSync(controlPath)) {
    errors.push('missing DEBIAN/control');
  } else {
    const control = readFileSync(controlPath, 'utf8');
    for (const field of ['Package: writing-desk', 'Version:', 'Architecture: all', 'Depends: nodejs']) {
      if (!control.includes(field)) errors.push(`control missing ${field.replace(/:$/, '')}`);
    }
  }
  const postinst = join(stageRoot, 'DEBIAN/postinst');
  if (!existsSync(postinst)) errors.push('missing DEBIAN/postinst');
  else if (!(statSync(postinst).mode & 0o111)) errors.push('postinst not executable');
  if (existsSync(join(stageRoot, 'DEBIAN/conffiles'))) {
    for (const line of readFileSync(join(stageRoot, 'DEBIAN/conffiles'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const rel = line.replace(/^\//, '');
      if (!existsSync(join(stageRoot, rel))) errors.push(`conffile target missing: ${line}`);
    }
  } else errors.push('missing DEBIAN/conffiles');
  for (const p of ['opt/writing-desk/dist/bin/front-door.js', 'opt/writing-desk/dist-orchestrator/bin/orchestrator.js',
    'opt/writing-desk/lib/render.mjs', 'opt/writing-desk/lib/nginx-splice.mjs',
    'usr/lib/systemd/system/writing-desk.service', 'usr/lib/systemd/system/writing-desk-orchestrator.service',
    'usr/lib/systemd/system/writing-desk-cloudflared.service', 'usr/lib/writing-desk/templates/writer.env.example',
    'etc/writing-desk/orchestrator.config.json', 'etc/writing-desk/app.env', 'etc/writing-desk/upstream',
    'etc/nginx/conf.d/writing-desk-map.conf']) {
    if (!existsSync(join(stageRoot, p))) errors.push(`missing payload: ${p}`);
  }
  for (const dep of ['express', 'ws', 'zod', 'gray-matter']) {
    if (!existsSync(join(stageRoot, `opt/writing-desk/node_modules/${dep}/package.json`))) errors.push(`missing runtime dep: ${dep}`);
  }
  return { ok: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = validateManifest(process.argv[2] || '.');
  console.log(r.ok ? 'manifest ok' : r.errors.join('\n'));
  process.exit(r.ok ? 0 : 1);
}
