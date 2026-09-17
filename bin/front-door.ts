/**
 * writing-desk front door entrypoint (M4d, ADR-0008). Public port;
 * nginx/cloudflared point here. Editor slots are children (see slots.ts).
 */
import { createServer } from 'node:http';
import { createFrontDoor } from '../server/front-door/app.js';
import { resolveListenHost } from '../server/deploy-env.js';
import { wireUpgrade } from '../server/front-door/proxy.js';

const port = parseInt(process.env.OW_PORT ?? '5051', 10);
const fd = createFrontDoor();
const server = createServer(fd.app);
wireUpgrade(server, fd.resolveUpgrade, (userId, open) => open ? fd.slotManager.connOpen(userId) : fd.slotManager.connClose(userId));
server.listen(port, resolveListenHost() || '127.0.0.1', () => {
  console.error(`[front-door] listening on ${resolveListenHost() || '127.0.0.1'}:${port}`);
});

async function gracefulShutdown(signal: string) {
  console.error(`[front-door] received ${signal}, stopping slots...`);
  try {
    await fd.slotManager.stopAll();
  } catch (e) {
    console.error('[front-door] error stopping slots:', e);
  }
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
