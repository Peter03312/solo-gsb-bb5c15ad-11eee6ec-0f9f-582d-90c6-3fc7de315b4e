import crypto from 'node:crypto';

// scrypt 口令哈希，每条记录独立 salt
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 岗位稳定标识
export function generatePositionKey(): string {
  return crypto.randomBytes(8).toString('hex');
}

// 场次入场码：6 位大写字母数字（去除易混字符）
export function generateShowCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
