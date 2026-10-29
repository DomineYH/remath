import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, parseSecret, seal, VaultError } from './vault.ts';

const S1 = randomBytes(32).toString('base64'), S2 = randomBytes(32).toString('hex');
const KEY = 'sk-proj-abcdefghijklmnopqrstuv9876';

describe('key vault (Q6): AES-256-GCM, base64(iv‖tag‖ct)', () => {
  it('seal → open round-trips, with a base64 or a hex secret', () => {
    expect(open(seal(KEY, S1), S1)).toBe(KEY);
    expect(open(seal(KEY, S2), S2)).toBe(KEY);
  });
  it('the same plaintext seals differently every time (random 12-byte iv), and never contains the key', () => {
    const a = seal(KEY, S1), b = seal(KEY, S1);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').length).toBe(12 + 16 + Buffer.byteLength(KEY));
    expect(a).not.toContain(KEY);
  });
  it('another secret, a tampered or garbage ciphertext → VaultError vault_decrypt_failed', () => {
    const c = seal(KEY, S1), bytes = Buffer.from(c, 'base64');
    bytes[bytes.length - 1] ^= 1;
    for (const bad of [() => open(c, S2), () => open(bytes.toString('base64'), S1), () => open('AAAA', S1)])
      expect(bad).toThrow(expect.objectContaining({ name: 'VaultError', code: 'vault_decrypt_failed' }));
    expect(() => open(c, S2)).toThrow(VaultError);
  });
  it('secrets that are not exactly 32 bytes are refused (31, 33, empty, junk)', () => {
    for (const s of [randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), randomBytes(31).toString('hex'), randomBytes(33).toString('hex'), '', 'not a secret'])
      expect(() => parseSecret(s), s).toThrow(/32 bytes/);
    expect(() => seal(KEY, randomBytes(31).toString('base64'))).toThrow(/32 bytes/);
    expect(parseSecret(S1)).toHaveLength(32);
    expect(parseSecret(S2)).toHaveLength(32);
  });
});
