// 비밀번호 해시 — 목업과 같은 솔트 SHA-256(Web Crypto: 브라우저·Node ≥20 공용). 형식 "sha256$<salt>$<hex>".
// ponytail: 서버는 argon2id(0001_init.sql). 브라우저 안의 목이라 상수 시간 비교도 하지 않는다.
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const digest = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export async function hashPassword(pw: string, salt = randomHex(16)): Promise<string> {
  return `sha256$${salt}$${await digest(`${salt}:${pw}`)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, salt] = stored.split('$');
  return salt !== undefined && (await hashPassword(pw, salt)) === stored;
}
