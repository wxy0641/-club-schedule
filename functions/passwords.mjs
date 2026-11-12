// 口令派生与校验：服务端 WebCrypto PBKDF2-HMAC-SHA256。
// 只保存 salt / 派生结果 / 迭代次数，任何情况下都不保存或记录明文口令。

export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_HASH = 'SHA-256';
const KEY_BITS = 256;
const SALT_BYTES = 16;

// 未知用户名也付出同等代价，避免用响应时间判断账号是否存在。
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const DUMMY_EXPECTED = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await derive(password, salt, iterations);
  return { salt: toBase64(salt), hash: toBase64(derived), iterations };
}

export async function verifyPassword(password, record) {
  const iterations = Number.isSafeInteger(record?.iterations) ? record.iterations : PBKDF2_ITERATIONS;
  if (typeof record?.salt !== 'string' || typeof record?.hash !== 'string') return false;
  let salt;
  try {
    salt = fromBase64(record.salt);
  } catch {
    return false;
  }
  const derived = await derive(password, salt, iterations);
  return timingSafeEqual(toBase64(derived), record.hash);
}

export async function verifyPasswordAgainstDummy(password) {
  const derived = await derive(password, DUMMY_SALT, PBKDF2_ITERATIONS);
  return timingSafeEqual(toBase64(derived), DUMMY_EXPECTED);
}
