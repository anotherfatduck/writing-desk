/** Splice the writing-desk managed block into an nginx vhost file.
 *  Pure core (spliceManagedBlock) + CLI wrapper the installed postinst calls:
 *  node nginx-splice.mjs <vhost-file> <block-file>. Atomic replace, preserves
 *  surrounding infra content, refuses half-managed states. A fresh claim lands
 *  INSIDE the server block — replacing the placeholder's `location /` (a second
 *  one is a duplicate-location error; file scope is invalid nginx), falling
 *  back to inserting before the file's last `}` when the vhost has no
 *  `location /`. nginx -t in postinst is the safety net. */
import { readFileSync, writeFileSync, renameSync, realpathSync } from 'fs';

export function spliceManagedBlock(src, block) {
  const BEGIN = '## writing-desk BEGIN';
  const END = '## writing-desk END';
  const hasBegin = src.includes(BEGIN);
  const hasEnd = src.includes(END);
  if (hasBegin !== hasEnd) return { out: src, changed: false, error: 'half-managed block (exactly one marker) — refusing' };
  if (hasBegin) {
    const start = src.indexOf(BEGIN);
    const end = src.indexOf(END);
    if (end < start) return { out: src, changed: false, error: 'markers out of order — refusing' };
    const out = src.slice(0, start) + block.trimEnd() + src.slice(end + END.length);
    return { out, changed: out !== src };
  }
  // Fresh claim: the managed block must live INSIDE the server block. Replace
  // the placeholder's `location /` when present (a second one is a
  // duplicate-location error; file scope is invalid nginx); otherwise insert
  // before the file's last `}` (single-server vhost). nginx -t in postinst is
  // the safety net.
  const m = /\blocation\s+\/\s*\{/.exec(src);
  if (m) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          const out = src.slice(0, m.index) + block.trimEnd() + src.slice(i + 1);
          return { out, changed: out !== src };
        }
      }
    }
    return { out: src, changed: false, error: 'unbalanced braces around location / — refusing' };
  }
  const last = src.lastIndexOf('}');
  if (last === -1) return { out: src, changed: false, error: 'no server block to claim inside — refusing' };
  const out = src.slice(0, last) + block.trimEnd() + '\n' + src.slice(last);
  return { out, changed: out !== src };
}

export function main(argv) {
  const [vhostPath, blockPath] = argv;
  if (!vhostPath || !blockPath) { console.error('usage: nginx-splice.mjs <vhost> <block-file>'); return 2; }
  const realVhost = realpathSync(vhostPath);
  const src = readFileSync(realVhost, 'utf8');
  const block = readFileSync(blockPath, 'utf8');
  const r = spliceManagedBlock(src, block);
  if (r.error) { console.error(`nginx-splice: ${r.error}`); return 1; }
  if (!r.changed) { console.log('nginx-splice: no change'); return 0; }
  const tmp = `${realVhost}.content-repo.tmp`;
  writeFileSync(tmp, r.out);
  renameSync(tmp, realVhost); // same dir → atomic on the LXC's ext4; tmp inherits perms via umask
  console.log(`nginx-splice: managed block written to ${realVhost}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
