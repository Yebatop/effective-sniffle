/**
 * Сервер пробует сам открыть страницу главы (тихая первая попытка).
 * Таймаут 10 с, предел 3 МБ, кодировка из charset, User-Agent латиницей.
 * Заглушка «вы не робот?» → { ok:false, code:"site_blocked" } сразу.
 * Разбор — linkedom + extractFromDocument.
 * Только http(s) и только наружу: внутренние адреса (localhost, 10.x, 192.168.x,
 * 169.254.x, ::1 …) отклоняются.
 *
 * Проверка идёт по имени хоста и не ловит подмену DNS между проверкой и
 * запросом (DNS rebinding) — это вне задачи; настоящая защита была бы на
 * уровне сети. Записано, чтобы никто не принял проверку за неё.
 */

import { parseHTML } from "linkedom";
import type { ErrorCode, FetchResponse } from "../types";
import { decodeHtml } from "./charset";
import { isChallengePage } from "./challenge";
import { extractFromDocument } from "./dom";
import { chapterFromPastedText } from "./text";

/**
 * ТОЛЬКО ЛАТИНИЦА: заголовки HTTP — байты 0–255, кириллица роняет запрос
 * ещё до отправки (exttran:src/config.ts:110-119).
 */
export { decodeHtml };

export const USER_AGENT = "Mozilla/5.0 (compatible; TolmachReader/0.1; personal use)";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export const SITE_BLOCKED_MESSAGE =
  "Сайт не пускает сервер Толмача (проверка «вы не робот?»). Откройте главу в браузере и нажмите там кнопку «Т» Толмача — или поделитесь страницей в Толмач.";

export async function fetchChapter(url: string, opts?: { fetchImpl?: typeof fetch }): Promise<FetchResponse> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const checked = checkFetchUrl(url);
  if (!checked.ok) return fail("unknown", checked.reason);

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = checked.url;
  let response: Response | null = null;
  try {
    // Переадресации — вручную: иначе fetch сам ушёл бы по Location во
    // внутреннюю сеть, минуя проверку адреса.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const r = await doFetch(current, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal,
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        if (hop === MAX_REDIRECTS) return fail("network", "Сайт слишком много раз переадресовал запрос.");
        let next: string;
        try {
          next = new URL(r.headers.get("location") as string, current).toString();
        } catch {
          return fail("network", "Сайт переадресовал на непонятный адрес.");
        }
        const again = checkFetchUrl(next);
        if (!again.ok) return fail("unknown", again.reason);
        current = again.url;
        try {
          await r.body?.cancel();
        } catch {
          // тело переадресации не нужно
        }
        continue;
      }
      response = r;
      break;
    }
  } catch (error) {
    return fail("network", describeNetworkError(error, current));
  }
  if (!response) return fail("network", "Сайт не ответил.");

  const headers = headerRecord(response.headers);
  const status = response.status;

  if (headers["cf-mitigated"] && /challenge/i.test(headers["cf-mitigated"])) {
    await cancelBody(response);
    return fail("site_blocked", SITE_BLOCKED_MESSAGE);
  }

  const type = headers["content-type"] || "";
  if (type && !/html|xml|text\/plain/i.test(type)) {
    await cancelBody(response);
    return fail("not_chapter", "По ссылке не страница, а файл (" + type.split(";")[0] + "). Нужна ссылка на главу.");
  }

  let bytes: Uint8Array;
  try {
    const read = await readCapped(response, MAX_BYTES);
    if (!read) return fail("too_large", "Страница больше 3 МБ — это не похоже на главу. Сохраните её браузером и добавьте файлом.");
    bytes = read;
  } catch (error) {
    return fail("network", describeNetworkError(error, current));
  }
  const html = decodeHtml(bytes, type);

  if (isChallengePage({ status, headers, html })) return fail("site_blocked", SITE_BLOCKED_MESSAGE);
  if (status === 403 || status === 429 || status === 503) return fail("site_blocked", SITE_BLOCKED_MESSAGE);
  if (status === 404 || status === 410) return fail("not_chapter", "Такой страницы на сайте нет (ответ " + status + "). Проверьте ссылку.");
  if (status < 200 || status >= 300) return fail("network", "Сайт ответил ошибкой " + status + ". Попробуйте позже или нажмите кнопку Толмача на странице.");

  // Голый текст (.txt) разбирается как вставка, а не как HTML.
  const chapter = /text\/plain/i.test(type)
    ? chapterFromPastedText(html, { url: current })
    : extractFromDocument(parseHtml(html, current), { url: current });
  if (chapter.looksLikeIndex) {
    return fail("not_chapter", "Это похоже на оглавление или страницу книги, а не на главу. Откройте саму главу и пришлите её ссылку.");
  }
  if (chapter.paragraphs.length === 0) {
    return fail("not_chapter", "На странице не нашлось текста главы. Возможно, текст рисует скрипт — нажмите кнопку Толмача на самой странице.");
  }
  return { ok: true, chapter };
}

/** HTML-строка → Document (linkedom) — для сервера и тестов. */
export function parseHtml(html: string, url?: string | null): Document {
  void url; // адрес передаётся в extractFromDocument отдельно; linkedom его не хранит
  const { document } = parseHTML(html);
  return document as unknown as Document;
}

// ── Проверка адреса ─────────────────────────────────────────────────────

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Только http(s) и только наружу. Ловит имена и IP-литералы, но не DNS rebinding. */
export function checkFetchUrl(raw: string): UrlCheck {
  const trimmed = (raw || "").trim();
  if (trimmed === "") return { ok: false, reason: "Ссылка пустая." };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Это не похоже на ссылку. Нужен полный адрес главы, вместе с https://" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "Открываем только ссылки http и https." };
  if (u.username || u.password) return { ok: false, reason: "Ссылки с логином и паролем внутри не открываем." };
  if (u.port && u.port !== "80" && u.port !== "443" && u.port !== "8080" && u.port !== "8443") {
    return { ok: false, reason: "По этому адресу мы не ходим." };
  }
  if (isPrivateHost(u.hostname)) return { ok: false, reason: "По этому адресу мы не ходим: он ведёт во внутреннюю сеть." };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return true;
  if (host.charAt(0) === "[" || host.indexOf(":") >= 0) return isPrivateV6(host.replace(/^\[|\]$/g, ""));
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  if (host === "localhost" || /\.(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/.test(host)) return true;
  // Имя без точки (intranet, metadata) резолвится по search-доменам внутрь сети.
  if (host.indexOf(".") < 0) return true;
  return false;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.some((n) => n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // мультикаст и зарезервированное
  );
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  // IPv4 внутри IPv6 (::ffff:7f00:1, ::ffff:127.0.0.1) — смотрим на вложенный IPv4.
  const mapped = v.match(/^::ffff:(?:0:)?(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateV4(tail);
    const hex = tail.split(":");
    if (hex.length === 2) {
      const hi = parseInt(hex[0], 16);
      const lo = parseInt(hex[1], 16);
      return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
    return true;
  }
  const first = parseInt(v.split(":")[0] || "0", 16);
  // Наружу — только глобальные 2000::/3; прочее (fe80::, fc00::, 64:ff9b:: …) — нет.
  return !(first >= 0x2000 && first <= 0x3fff);
}

// ── Тело ответа ─────────────────────────────────────────────────────────

/** Прочитать тело не больше limit байт; больше — null (и чтение прерывается). */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > limit) {
    await cancelBody(response);
    return null;
  }
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.length > limit ? null : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // уже неважно
      }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // тело не нужно
  }
}

function headerRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Почему не удалось соединиться — по-человечески (exttran:src/extract.ts
 * describeNetworkError). fetch бросает одно «fetch failed», причина — в cause.
 */
export function describeNetworkError(error: unknown, url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // оставим как есть
  }
  const e = error as { name?: string; cause?: { code?: string; name?: string } } | undefined;
  const name = e?.name ?? "";
  const code = e?.cause?.code ?? "";
  let reason: string;
  if (name === "TimeoutError" || name === "AbortError" || e?.cause?.name === "TimeoutError") {
    reason = `${host} не ответил за 10 секунд`;
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    reason = `адрес ${host} не находится — возможно, в нём опечатка`;
  } else if (code === "ECONNREFUSED") {
    reason = `${host} отказал в соединении`;
  } else if (code === "ECONNRESET") {
    reason = `${host} оборвал соединение`;
  } else if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    reason = `${host} не ответил вовремя`;
  } else if (code.indexOf("ERR_TLS") === 0 || code.indexOf("CERT_") === 0 || code.indexOf("UNABLE_TO_") === 0) {
    reason = `у ${host} не в порядке сертификат`;
  } else {
    reason = `до ${host} не достучались`;
  }
  return `Страница не открылась: ${reason}. Проверьте ссылку или попробуйте позже.`;
}

function fail(code: ErrorCode, message: string): FetchResponse {
  return { ok: false, code, message };
}
