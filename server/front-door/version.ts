import { readFileSync } from 'fs';

/** The deployed app version — read from the package.json beside the compiled
 *  dist (in the deb: /opt/writing-desk/package.json, the value the .deb is
 *  named after; in dev, the repo root). 'unknown' when unreadable — the login
 *  footer degrades, never errors. */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
