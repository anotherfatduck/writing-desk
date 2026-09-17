/**
 * Encrypted settings store — schema + crypto + paths. adr: 0009 (M4d).
 * One file (WRITER_STORE, default /var/lib/writing-desk/settings.enc):
 * whole-payload AES-256-GCM under a 32-byte master key at
 * WRITER_RUNTIME_DIR/master.key (default /etc/writing-desk/runtime),
 * minted by the app at init. Disposable secrets: the collab credential and
 * VKs are revocable; the work lives in git — key loss costs a re-init, not
 * data. Consumers: front door (read/write — the ONLY writer), slot (read:
 * own user's VK), orchestrator (read: creds + roster). Env path overrides
 * are for tests/dev only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export const STORE_VERSION = 1;

/** Tab-title name for the deployment. Set at first-claim init; unset stores
 *  (and pre-siteName hosts) fall back to this. */
export const DEFAULT_SITE_NAME = 'Writing Desk';

export interface StoreUser { id: string; name: string; isAdmin: boolean; vk: string | null; loginTokenHash: string; createdAt: string; }
export interface StoreGitea { repoUrl: string; username: string; password: string; }
export interface StoreSession { idHash: string; userId: string; createdAt: string; expiresAt: string; }
export interface SettingsStore { v: typeof STORE_VERSION; createdAt: string; siteName?: string;
  /** Per-deployment chat persona (the agent's character block). Unset → the
   *  neutral default in shared/chat-persona.ts. Admin-editable; survives
   *  redeploys (store ≠ package — the siteName precedent). */
  chatPersona?: string; users: StoreUser[]; gitea: StoreGitea; sessions: StoreSession[]; }

export function resolveRuntimeDir(): string {
  return process.env.WRITER_RUNTIME_DIR || '/etc/writing-desk/runtime';
}
export function resolveStoreFile(): string {
  return process.env.WRITER_STORE || '/var/lib/writing-desk/settings.enc';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function mintMasterKey(runtimeDir: string): Buffer {
  const p = `${runtimeDir}/master.key`;
  if (existsSync(p)) throw new Error('master key already exists');
  mkdirSync(runtimeDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(p, `${key.toString('base64')}\n`, { mode: 0o640 });
  return key;
}

export function loadMasterKey(runtimeDir: string): Buffer | null {
  const p = `${runtimeDir}/master.key`;
  if (!existsSync(p)) return null;
  return Buffer.from(readFileSync(p, 'utf-8').trim(), 'base64');
}

export function writeStore(storeFile: string, key: Buffer, s: SettingsStore): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(s), 'utf-8'), cipher.final()]);
  const envelope = JSON.stringify({
    v: STORE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  });
  const tmp = `${storeFile}.tmp`;
  mkdirSync(dirname(storeFile), { recursive: true });
  writeFileSync(tmp, `${envelope}\n`, { mode: 0o640 });
  renameSync(tmp, storeFile);
}

export function readStore(storeFile: string, key: Buffer | null): SettingsStore | null {
  if (!existsSync(storeFile)) return null;
  if (!key) throw new Error('store corrupt: settings file exists but the master key is missing');
  let envelope: { v: number; iv: string; tag: string; ct: string };
  try {
    envelope = JSON.parse(readFileSync(storeFile, 'utf-8'));
  } catch (e) {
    throw new Error(`store corrupt: unreadable envelope (${e instanceof Error ? e.message : e})`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  let parsed: SettingsStore;
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]); // wrong key throws here (GCM auth)
    parsed = JSON.parse(plain.toString('utf-8')); // truncated/tampered ct throws here too
  } catch (e) {
    throw new Error(`store corrupt: decrypt failed (${e instanceof Error ? e.message : e})`);
  }
  if (parsed.v !== STORE_VERSION) throw new Error(`store corrupt: schema v${parsed.v}, expected v${STORE_VERSION}`);
  return parsed as SettingsStore;
}

export function pruneSessions(s: SettingsStore, now: number = Date.now()): SettingsStore {
  return { ...s, sessions: s.sessions.filter((x) => Date.parse(x.expiresAt) > now) };
}
