/** Render the writing-desk managed nginx location block (pure). The installed
 *  postinst renders at claim time from the installed /etc/writing-desk/upstream
 *  (single source — ops edits and package upgrades follow the conffile, never a
 *  build-time bake), then splices it into the infra default_server vhost.
 *  adr: docs/adr/0001-*.md */
export function renderNginxBlock({ upstream }) {
  if (!upstream || !/^https?:\/\//.test(upstream)) throw new Error(`renderNginxBlock: bad upstream ${JSON.stringify(upstream)}`);
  return [
    '## writing-desk BEGIN — managed block; edits between markers are overwritten on upgrade',
    'location / {',
    `  proxy_pass ${upstream};`,
    '  proxy_http_version 1.1;',
    // Chat turns are a synchronous POST awaiting the full agent turn; the local
    // reasoning route can exceed the 60s nginx default (504 "Gateway Time-out"),
    // and idle WS connections were dying on the same default. Generous ceiling.
    '  proxy_read_timeout 600s;',
    '  proxy_set_header Host $host;',
    '  proxy_set_header X-Forwarded-Proto $scheme;',
    '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '  proxy_set_header Upgrade $http_upgrade;',
    '  proxy_set_header Connection $connection_upgrade;',
    '}',
    '## writing-desk END',
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [upstreamFile] = process.argv.slice(2);
  if (!upstreamFile) { console.error('usage: render.mjs <upstream-file>  (prints the managed block)'); process.exit(2); }
  const { readFileSync } = await import('fs');
  process.stdout.write(renderNginxBlock({ upstream: readFileSync(upstreamFile, 'utf8').trim() }));
}
