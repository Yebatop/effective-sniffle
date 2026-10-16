/**
 * Адреса глав: нормализация, ключ книги, номер главы.
 *
 * Ключ книги — самое дорогое место для ошибки: по нему у книги один
 * глоссарий. В «Толмаче» все книги Royal Road и AO3 сводились в один ключ:
 * exttran:src/book.ts шёл по пути с конца и отрезал всё от самого левого
 * «похожего на главу» сегмента, а голое число (id книги) тоже считалось
 * главой — /fiction/21220/… превращалось в «royalroad.com/fiction». Здесь
 * у известных сайтов свои правила, а в общем случае отрезается только
 * хвост: последний сегмент-глава и маркеры прямо перед ним.
 */

/** Метки рассылок и соцсетей — у одной главы не должно быть двух адресов. */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "yclid", "msclkid", "twclid",
  "mc_cid", "mc_eid", "igshid", "_ga", "_gl", "ref", "ref_src", "ref_url",
]);

function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Канон Royal Road: /fiction/{id}/chapter/{chapterId}, без слагов (ARCH «Идентичность главы»). */
function royalRoadPath(path: string): string {
  const chapter = /^\/fiction\/(\d+)(?:\/[^/]+)?\/chapter\/(\d+)(?:\/.*)?$/i.exec(path);
  if (chapter) return `/fiction/${chapter[1]}/chapter/${chapter[2]}`;
  const fiction = /^\/fiction\/(\d+)(?:\/[^/]+)?$/i.exec(path);
  if (fiction) return `/fiction/${fiction[1]}`;
  return path;
}

/**
 * Разбор адреса без правил сайтов: схема дописывается к «www.site.com/…»,
 * пускаются только http и https. Нужен отдельно от normalizeUrl: номер главы
 * Royal Road живёт в слаге, который канон выбрасывает.
 */
function parseLoose(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (s.startsWith("//")) s = `https:${s}`;
  else if (!/^https?:\/\//i.test(s)) {
    // Адрес без схемы — частый случай при копировании: «www.royalroad.com/fiction/…».
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(s)) return null;
    s = `https://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u;
}

/** https, хост в нижнем регистре, без #, без utm_* и прочих меток, без / в конце. Не URL — null. */
export function normalizeUrl(raw: string): string | null {
  const u = parseLoose(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";

  let path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (bareHost(host) === "royalroad.com") path = royalRoadPath(path);

  // Параметры фильтруются как есть, без перекодирования — остальное в адресе
  // не должно меняться (иначе один адрес даст две записи).
  const query = u.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !isTracking(decodeSafe(pair.split("=")[0])))
    .join("&");

  return `https://${host}${port}${path}${query ? `?${query}` : ""}`;
}

/** Хост без www. и m. — для ключа книги и показа. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^(?:www\d*|m)\./, "");
}

function pathSegments(u: URL): string[] {
  return u.pathname
    .split("/")
    .filter((seg) => seg !== "")
    .map((seg) => decodeSafe(seg));
}

function isSite(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// Признаки главы в сегменте пути.
const MARKER_WORDS = "chapters?|chap|ch|c|episodes?|ep|glava|глава|part";
/** Глава внутри сегмента: novel-name-chapter-12, sn-chapter-12. Номер — в группе 1. */
const CHAPTER_INSIDE = /(?:^|[-_.])(?:chapters?|chap|ch|episodes?|ep|glava|глава)[-_.]?(\d{1,5})(?!\d)/gi;
/** Только маркер или том, без номера главы: /chapter/12, /vol-2/chapter-5. */
const MARKER_SEGMENT = new RegExp(`^(?:${MARKER_WORDS}|read|(?:vol|volume|v|book|tom|том)[-_.]?\\d+)$`, "i");

/** Сегмент, который сам по себе означает «дальше идёт адрес главы»: /chapter/…, /episodes/…. */
const PURE_CHAPTER_MARKER = /^(?:chapters?|chap|ch|episodes?|ep|glava|глава)$/i;

/** Последний номер главы из «chapter-N» внутри сегмента или null. */
function chapterNumberInSegment(seg: string): number | null {
  let last: number | null = null;
  for (const m of seg.matchAll(CHAPTER_INSIDE)) last = Number(m[1]);
  if (last !== null) return last;
  const short = /^(?:c|ch)[-_.]?(\d{1,5})(?!\d)/i.exec(seg);
  return short ? Number(short[1]) : null;
}

/** Срезать номер главы с конца одиночного сегмента: martial-peak-chapter-12 → martial-peak. */
function stripChapterSuffix(seg: string): string {
  return seg
    .replace(new RegExp(`(?:^|[-_.])(?:${MARKER_WORDS})[-_.]?\\d+.*$`, "i"), "")
    .replace(/(?:^|[-_.])\d+(?:\.html?)?$/i, "")
    .replace(/[-_.]+$/, "");
}

/**
 * Ключ книги по адресу главы. Правила для сайтов:
 * royalroad.com/fiction/{id}/... → "royalroad.com/fiction/{id}";
 * scribblehub.com/read/{id}-slug/chapter/{c} и /series/{id}/... → "scribblehub.com/series/{id}";
 * webnovel.com/book/{slug_or_id}/... → "webnovel.com/book/{id}";
 * archiveofourown.org/works/{id}/chapters/{c} → "archiveofourown.org/works/{id}";
 * wuxiaworld.com/novel/{slug}/{chapter} → "wuxiaworld.com/novel/{slug}";
 * прочие: хост + путь без последнего сегмента-главы (chapter-12, ch-12, 12, c12, glava-12 …);
 * если путь из одного сегмента — хост + этот сегмент без номера главы.
 *
 * У известных сайтов адрес непривычной формы (например, RR /fiction/chapter/…
 * без id книги) даёт null, а не общий разбор: лучше спросить книгу при
 * импорте, чем склеить чужие глоссарии. Ключ — в нижнем регистре.
 */
export function bookKeyFromUrl(url: string): string | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const u = new URL(normalized);
  const host = bareHost(u.hostname);
  const segs = pathSegments(u);
  const lower = segs.map((s) => s.toLowerCase());

  if (isSite(host, "royalroad.com")) {
    return lower[0] === "fiction" && /^\d+$/.test(lower[1] ?? "") ? `royalroad.com/fiction/${lower[1]}` : null;
  }
  if (isSite(host, "scribblehub.com")) {
    const read = lower[0] === "read" ? /^(\d+)(?:-|$)/.exec(lower[1] ?? "") : null;
    if (read) return `scribblehub.com/series/${read[1]}`;
    return lower[0] === "series" && /^\d+$/.test(lower[1] ?? "") ? `scribblehub.com/series/${lower[1]}` : null;
  }
  if (isSite(host, "webnovel.com")) {
    if (lower[0] !== "book" || !lower[1]) return null;
    const id = /(?:^|_)(\d{5,})$/.exec(lower[1])?.[1] ?? lower[1];
    return `webnovel.com/book/${id}`;
  }
  if (isSite(host, "archiveofourown.org")) {
    const at = lower.indexOf("works");
    return at >= 0 && /^\d+$/.test(lower[at + 1] ?? "") ? `archiveofourown.org/works/${lower[at + 1]}` : null;
  }
  if (isSite(host, "wuxiaworld.com")) {
    return lower[0] === "novel" && lower[1] ? `wuxiaworld.com/novel/${lower[1]}` : null;
  }

  return [host, ...genericBookPath(lower)].join("/");
}

function genericBookPath(segs: string[]): string[] {
  if (segs.length === 0) return [];
  if (segs.length === 1) {
    const rest = stripChapterSuffix(segs[0]);
    return rest ? [rest] : [];
  }
  // Последний сегмент — глава, даже если не похож на неё (слаг без номера):
  // так устроено большинство сайтов, и ошибиться тут дешевле, чем считать
  // книгой весь сайт. Маркеры и тома прямо перед ним — тоже часть адреса главы.
  let cut = segs.length - 1;
  // Клоны Royal Road: /fiction/{id}/{slug}/chapter/{chapterId}/{slug-главы}.
  // Всё начиная с голого «chapter» — адрес главы, иначе id главы попал бы
  // в ключ, и каждая глава завела бы свою книгу со своим глоссарием.
  for (let i = segs.length - 2; i >= 1; i -= 1) {
    if (PURE_CHAPTER_MARKER.test(segs[i])) {
      cut = i;
      break;
    }
  }
  while (cut > 0 && MARKER_SEGMENT.test(segs[cut - 1])) cut -= 1;
  return segs.slice(0, cut);
}

// Номер в заголовке: «Chapter 12», «Ch. 12», «Глава 12», «Episode 3», «#12», «12. Название».
const TITLE_PATTERNS: RegExp[] = [
  /(?<![\p{L}\p{N}])(?:chapter|chap|ch)\.?\s*[#№]?\s*(\d{1,5}(?:\.\d{1,2})?)(?![\d\p{L}])/iu,
  /(?<![\p{L}\p{N}])глава\s*[#№]?\s*(\d{1,5})(?!\d)/iu,
  /(?<![\p{L}\p{N}])(?:episode|ep)\.?\s*[#№]?\s*(\d{1,5})(?!\d)/iu,
  /(?<![\p{L}\p{N}])[#№]\s*(\d{1,5})(?!\d)/u,
  /^\s*(\d{1,4})\s*[.:\-–—)]\s+\S/u,
];

function chapterNumberFromTitle(title: string): number | null {
  for (const re of TITLE_PATTERNS) {
    const m = re.exec(title);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Номер из адреса. У RR, ScribbleHub, AO3 и Webnovel числа в пути — внутренние
 * id (RR /chapter/301778 — это не глава 301 778), поэтому там номер берётся
 * только из слага вида «chapter-12-…». В общем случае — последний сегмент
 * с маркером главы, иначе голое короткое число последним сегментом.
 */
function chapterNumberFromUrl(url: string): number | null {
  const u = parseLoose(url);
  if (!u) return null;
  const host = bareHost(u.hostname);
  const segs = pathSegments(u);

  const idSites = ["royalroad.com", "scribblehub.com", "archiveofourown.org", "webnovel.com"];
  const internalIds = idSites.some((d) => isSite(host, d));

  for (let i = segs.length - 1; i >= 0; i -= 1) {
    // У сайтов с id номер ищется только в последнем сегменте-слаге главы.
    if (internalIds && i !== segs.length - 1) break;
    const seg = internalIds ? segs[i].replace(/_\d+$/, "") : segs[i];
    const n = chapterNumberInSegment(seg);
    if (n !== null) return n;
  }
  if (internalIds) return null;

  for (const key of ["chapter", "ch", "c", "глава"]) {
    const v = u.searchParams.get(key);
    if (v && /^\d{1,5}$/.test(v)) return Number(v);
  }

  // Голое число: /novel/name/116. Длинное (5+ цифр) — скорее id, а не номер.
  const last = segs[segs.length - 1];
  const bare = last ? /^(\d{1,4})(?:\.html?)?$/i.exec(last) : null;
  return bare && segs.length > 1 ? Number(bare[1]) : null;
}

/** Номер главы: из заголовка («Chapter 12», «Ch. 12», «Глава 12», «#12»), иначе из адреса (последнее число в пути, не id книги). */
export function chapterNumberFrom(title: string | null, url: string | null): number | null {
  if (title) {
    const n = chapterNumberFromTitle(title);
    if (n !== null) return n;
  }
  return url ? chapterNumberFromUrl(url) : null;
}

/** Хост для показа: "royalroad.com". */
export function siteOf(url: string | null): string | null {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  return bareHost(new URL(normalized).hostname);
}
