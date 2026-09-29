import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Secrets the server must be able to read back (for example the key another application gave us to call
 * it). Unlike the hashed machine keys, these cannot be one-way, so they are sealed with AES-256-GCM.
 * The sealing key is MIZAN_SECRET_KEY (64 hex characters) when set, else a random key kept in
 * <data folder>/secret.key (created on first use, readable by the server account only). It never lives in
 * the database, so a copy of the database file alone does not reveal the secrets. An in-memory database
 * gets a throw-away key.
 */
export interface Secrets {
  seal(plain: string): string;
  open(sealed: string): string;
}

const PREFIX = 'v1:';

export function createSecrets(dbFile: string, dataDir: string): Secrets {
  let key: Buffer | null = null;
  const load = (): Buffer => {
    if (key) return key;
    const env = process.env.MIZAN_SECRET_KEY?.trim();
    if (env) {
      if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error('MIZAN_SECRET_KEY must be 64 hex characters');
      return (key = Buffer.from(env, 'hex'));
    }
    if (dbFile === ':memory:') return (key = randomBytes(32));
    const file = join(dataDir, 'secret.key');
    if (existsSync(file)) return (key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
    mkdirSync(dirname(file), { recursive: true });
    key = randomBytes(32);
    writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    return key;
  };
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', load(), iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    open(sealed) {
      if (!sealed.startsWith(PREFIX)) throw new Error('not a sealed secret');
      const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
      const d = createDecipheriv('aes-256-gcm', load(), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
