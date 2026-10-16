/**
 * Вход по паролю и ключ кнопки на сайтах.
 *
 * - Cookie "tl_session": base64url(JSON {v:1, iat}) + "." + HMAC-SHA256.
 *   Ключ HMAC = HMAC(APP_PASSWORD, "tolmach-session-v1"): смена пароля
 *   разлогинивает все устройства. HttpOnly; Secure (кроме localhost);
 *   SameSite=Lax; Max-Age = год. Только Web Crypto — работает и в proxy.ts.
 * - Пароль сравнивается в постоянное время по хешу; кириллица допустима.
 * - Ключ кнопки: случайные 32 байта base64url; в базе хранится SHA-256.
 *   Проверка: заголовок Authorization: Bearer <ключ> или сегмент /u/<ключ>/.
 * - Секрет эстафеты: случайный, хранится в settings.
 */

export const SESSION_COOKIE = "tl_session";
export const SESSION_MAX_AGE = 365 * 24 * 60 * 60;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

async function sessionKey(password: string): Promise<Uint8Array> {
  return hmac(enc.encode(password), "tolmach-session-v1");
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSession(password: string, iat: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ v: 1, iat })));
  const sig = await hmac(await sessionKey(password), payload);
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(password: string, cookie: string | undefined | null): Promise<boolean> {
  if (!cookie || !password) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return false;
  const payload = cookie.slice(0, dot);
  let given: Uint8Array;
  try {
    given = fromB64url(cookie.slice(dot + 1));
  } catch {
    return false;
  }
  const expected = await hmac(await sessionKey(password), payload);
  if (!equalBytes(given, expected)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { v?: number; iat?: number };
    if (data.v !== 1 || typeof data.iat !== "number") return false;
    return Date.now() / 1000 - data.iat < SESSION_MAX_AGE;
  } catch {
    return false;
  }
}

export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  // Сравниваем хеши одинаковой длины — время не зависит от того, где расхождение.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(input.normalize("NFC"))),
    crypto.subtle.digest("SHA-256", enc.encode(expected.normalize("NFC"))),
  ]);
  return equalBytes(new Uint8Array(a), new Uint8Array(b));
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Пароль приложения из окружения; null — не задан (вход невозможен, показать подсказку). */
export function appPassword(): string | null {
  const v = process.env.APP_PASSWORD;
  return v && v.trim() ? v.trim() : null;
}

/** Атрибуты cookie входа: Secure везде, кроме localhost (там его не примет браузер по http). */
export function sessionCookieOptions(host: string | null): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number } {
  const local = !host || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return { httpOnly: true, secure: !local, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE };
}
