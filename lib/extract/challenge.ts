/**
 * Заглушка «вы не робот?» (Cloudflare и подобные) вместо страницы.
 * Признаки: заголовок cf-mitigated: challenge; 403/503 с title «Just a moment…»;
 * характерные маркеры в HTML (challenge-platform, cf-chl, turnstile) при
 * малом количестве текста.
 */
export function isChallengePage(input: { status?: number; headers?: Record<string, string | null | undefined>; html: string }): boolean {
  throw new Error("not implemented");
}
