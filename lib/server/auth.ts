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

export async function signSession(password: string, iat?: number): Promise<string> {
  throw new Error("not implemented");
}
export async function verifySession(password: string, cookie: string | undefined | null): Promise<boolean> {
  throw new Error("not implemented");
}
export async function passwordMatches(input: string, expected: string): Promise<boolean> {
  throw new Error("not implemented");
}
export function newToken(): string {
  throw new Error("not implemented");
}
export async function sha256Hex(s: string): Promise<string> {
  throw new Error("not implemented");
}
/** Пароль приложения из окружения; null — не задан (вход невозможен, показать подсказку). */
export function appPassword(): string | null {
  throw new Error("not implemented");
}
