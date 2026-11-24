// Verschlüsselung von Geheimnissen der Kunden (Meta-Access-Tokens) mit AES-256-GCM.
// Format: "v1.<iv>.<authTag>.<ciphertext>", jeweils Base64url.
// Das Präfix "v1" erlaubt später einen Schlüsselwechsel, ohne alte Werte unlesbar zu machen.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function parseKey(base64: string | undefined): Buffer {
  if (!base64) throw new Error('TOKEN_ENCRYPTION_KEY fehlt (siehe .env.example)');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY muss 32 Byte (Base64) lang sein');
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Unbekanntes Format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
