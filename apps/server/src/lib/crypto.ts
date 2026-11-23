import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM envelope for secrets at rest (datasource passwords, webhook URLs).
 * Format: v1.<iv b64>.<authTag b64>.<ciphertext b64>
 * The version prefix allows key rotation / algorithm upgrades later.
 */
const KEY = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, 'base64');
const ALGO = 'aes-256-gcm';

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(obj: unknown): string {
  return encrypt(JSON.stringify(obj));
}

export function decryptJson<T>(payload: string | null | undefined): T | undefined {
  if (!payload) return undefined;
  return JSON.parse(decrypt(payload)) as T;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
