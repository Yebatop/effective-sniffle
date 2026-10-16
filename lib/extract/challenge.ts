/**
 * Заглушка «вы не робот?» (Cloudflare и подобные) вместо страницы.
 * Признаки: заголовок cf-mitigated: challenge; 403/503 с title «Just a moment…»;
 * характерные маркеры в HTML (challenge-platform, cf-chl, turnstile) при
 * малом количестве текста.
 */
export function isChallengePage(input: { status?: number; headers?: Record<string, string | null | undefined>; html: string }): boolean {
  const mitigated = header(input.headers, "cf-mitigated");
  if (mitigated && /challenge/i.test(mitigated)) return true;

  const html = input.html || "";
  const status = input.status ?? 200;
  const blockedStatus = status === 403 || status === 503 || status === 429;
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = titleMatch ? decodeBasicEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  const challengeTitle = CHALLENGE_TITLE.test(title);
  const markers = CHALLENGE_MARKERS.test(html);

  if (challengeTitle && (blockedStatus || markers)) return true;
  // Главу с маркерами (скрипт Turnstile под формой комментариев) не путаем
  // с заглушкой: у заглушки текста почти нет.
  if ((markers || challengeTitle) && visibleWords(html) < 120) return true;
  if (blockedStatus && markers) return true;
  return false;
}

/** «Just a moment...», «Attention Required! | Cloudflare», «DDoS-Guard» и т. п. — заголовок целиком. */
const CHALLENGE_TITLE =
  /^(?:just a moment|attention required|checking your browser|please wait|one more step|access denied|ddos-guard|security check|verifying you are human|are you a robot)[.…!?]*(?:\s*[|\-–]\s*(?:cloudflare|ddos-guard))?$/i;

const CHALLENGE_MARKERS =
  /challenge-platform|cdn-cgi\/challenge|cf-chl-|cf_chl_|__cf_chl|_cf_chl_opt|cf-browser-verification|cf-turnstile|challenges\.cloudflare\.com\/turnstile|id="challenge-(?:form|running|stage|body)"|ddos-guard\.net|\/_guard\/|hcaptcha\.com\/1\/api\.js.{0,200}challenge/i;

/** Заголовок без учёта регистра имени. */
function header(headers: Record<string, string | null | undefined> | undefined, name: string): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key] ?? null;
  }
  return null;
}

/** Грубый счёт видимых слов без DOM: выкинуть скрипты, стили и теги. */
function visibleWords(html: string): number {
  const text = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words ? words.length : 0;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Сырые заголовки ответа (GM_xmlhttpRequest отдаёт их строкой) → объект. */
export function parseRawHeaders(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    out[key] = out[key] ? out[key] + ", " + value : value;
  }
  return out;
}
