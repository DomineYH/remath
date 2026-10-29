// 키 금고 (Q6·Q25): AES-256-GCM, 12바이트 랜덤 iv, 암호문 = base64(iv‖tag‖ct) → ai_settings.key_ciphertext. 비밀 교체(재암호화)는 범위 밖.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class VaultError extends Error {
  readonly code = 'vault_decrypt_failed';
  constructor() { super('vault_decrypt_failed'); this.name = 'VaultError'; }
}

/** KEY_VAULT_SECRET(base64 또는 hex 64자) → 32바이트. 길이가 다르면 throw. */
export function parseSecret(secret: string): Buffer {
  const s = secret.trim(), b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (b.length !== 32) throw new Error('KEY_VAULT_SECRET must be 32 bytes (base64 or hex); make one with: openssl rand -base64 32');
  return b;
}

export function seal(plain: string, secret: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', parseSecret(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function open(ciphertext: string, secret: string): string {
  const key = parseSecret(secret), b = Buffer.from(ciphertext, 'base64');
  try {
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { throw new VaultError(); }
}
