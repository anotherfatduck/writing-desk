/** Per-user slot proxy (ADR-0008): HTTP + WS upgrade, bearer injected upstream. */
import http from 'http';
import type { Request, Response } from 'express';
import type { Slot } from './slots.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function stripHopByHop(headers: Record<string, any>) {
  for (const h of HOP_BY_HOP) delete headers[h];
  const conn = headers['connection'];
  if (conn && typeof conn === 'string') {
    const tokens = conn.split(/,?\s*/);
    tokens.forEach(t => { if (HOP_BY_HOP.has(t.toLowerCase())) {
      // To be fully spec-compliant, we should remove the token from the comma-separated list.
      // But the simplest safe action is to delete the connection header if it contains hop-by-hop tokens.
      delete headers['connection'];
    } });
  }
  return headers;
}

export function proxyToSlot(req: Request, res: Response, slot: Slot): void {
  const headers = { ...req.headers, authorization: `Bearer ${slot.bearer}` };
  delete (headers as any).host;
  stripHopByHop(headers);

  const up = http.request({ host: '127.0.0.1', port: slot.port, method: req.method, path: req.originalUrl, headers }, (upRes) => {
    const resHeaders = { ...upRes.headers };
    stripHopByHop(resHeaders);
    res.writeHead(upRes.statusCode ?? 502, resHeaders);
    upRes.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Editor not available — try again in a moment.' }); else res.destroy(); });
  req.pipe(up);
}

export function wireUpgrade(server: http.Server, resolveSlot: (req: http.IncomingMessage) => Slot | null,
                            notify?: (userId: string, open: boolean) => void): void {
  server.on('upgrade', (req, socket, head) => {
    const slot = resolveSlot(req);
    if (!slot) { socket.destroy(); return; }
    const headers = { ...req.headers, authorization: `Bearer ${slot.bearer}` };
    stripHopByHop(headers);
    headers['connection'] = 'Upgrade';
    headers['upgrade'] = req.headers['upgrade'];

    const up = http.request({ host: '127.0.0.1', port: slot.port, path: req.url, headers });
    up.end();
    up.on('response', (upRes) => {
      if (upRes.statusCode !== 101) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      const resHeaders = { ...upRes.headers };
      // Preserve upgrade handshake headers for the client
      delete resHeaders['transfer-encoding'];
      for (const [k, v] of Object.entries(resHeaders)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : (v ?? '')}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) upSocket.unshift(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);

      let notifiedOpen = false;
      const __notifyOpen = () => { if (!notifiedOpen) { notify?.(slot.userId, true); notifiedOpen = true; } };
      __notifyOpen();

      let notifiedClose = false;
      const close = () => {
        if (!notifiedClose) { notify?.(slot.userId, false); notifiedClose = true; }
        upSocket.destroy();
        socket.destroy();
      };

      socket.on('error', close);
      socket.on('close', close);
      upSocket.on('error', close);
      upSocket.on('close', close);
      upSocket.on('end', close);
    });
    up.on('error', () => socket.destroy());
  });
}
