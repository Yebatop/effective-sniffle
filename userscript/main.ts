/**
 * Кнопка «Толмач» на сайтах и мост для «Дальше» (docs/CONTRACTS.md «Кнопка на
 * сайтах и мост»). Собирается esbuild в один IIFE (es2019) вместе с
 * lib/extract/dom.ts и Readability — без @require с CDN.
 *
 * Маршрут /u/<ключ>/tolmach.user.js приклеивает шапку метаданных и подменяет
 * две заглушки ниже настоящими адресом приложения и ключом кнопки.
 *
 * Браузер владельца — старый Chromium (Kiwi): никаких structuredClone, at,
 * Object.hasOwn, replaceAll, верхнеуровневого await.
 */

import { isProbablyReaderable } from "@mozilla/readability";
import { isChallengePage, parseRawHeaders } from "../lib/extract/challenge";
import { decodeHtml } from "../lib/extract/charset";
import { countWords } from "../lib/extract/clean";
import { HIDDEN_ATTR, extractFromDocument, markHiddenByStyles, markHiddenLive } from "../lib/extract/dom";
import type { ErrorCode, ExtractedChapter, ImportRequest, ImportResponse, RefBookItem, RefImportRequest, RefImportResponse } from "../lib/types";

// Подменяются маршрутом при отдаче скрипта. Сравнивать с ними целиком нельзя:
// подмена заменит и строку в сравнении, поэтому проверка — по префиксу.
const APP_ORIGIN_RAW = "__TOLMACH_APP_ORIGIN__";
const IMPORT_TOKEN = "__TOLMACH_IMPORT_TOKEN__";

const APP_ORIGIN = APP_ORIGIN_RAW.replace(/\/+$/, "");
const BRIDGE_VERSION = 1;
const LOOP_KEY = "tolmach:loop";
/** Глав в одном запросе импорта и предел его размера (~100 КБ у маршрута). */
const GROUP_SIZE = 5;
const GROUP_MAX_CHARS = 90000;
/** Незаконченный цикл старше этого не продолжаем — читатель о нём забыл. */
const LOOP_STALE_MS = 30 * 60 * 1000;
/** Пульс работающего цикла: по нему другая вкладка понимает, что цикл жив. */
const BEAT_MS = 2000;
/** Обход готового перевода (страница за страницей в этой вкладке) и выбранная книга сайта. */
const WALK_KEY = "tolmach:walk";
const REFBOOK_KEY = "tolmach:refbook:";
/** Сколько ждать, пока сайт дорисует главу при обходе. */
const WALK_WAIT_MS = 20000;
/** «До конца» — но не больше этого за один обход. */
const WALK_MAX = 3000;
/** Незаконченный обход старше этого не продолжаем. */
const WALK_STALE_MS = 30 * 60 * 1000;
/**
 * Сайты-приложения (Next.js и подобные) листают главы без перезагрузки:
 * меняют адрес и перерисовывают страницу, а менеджер скриптов второй раз
 * кнопку не запускает. Поэтому смотрим за адресом сами.
 */
const URL_POLL_MS = 1000;
/** После загрузки или смены адреса глава может дорисовываться — следим столько. */
const WATCH_MS = 15000;
/**
 * Проверки по таймеру в это окно — на случай, если страница меняется без
 * новых узлов. Первая не сразу: сразу после смены адреса на экране ещё
 * может быть прошлая страница.
 */
const WATCH_TICKS_MS = [600, 1500, 4000, 8000, WATCH_MS];
/** Не чаще раза в столько проверяем страницу, пока она перерисовывается. */
const MUTATION_THROTTLE_MS = 700;
/**
 * Столько после смены адреса страницу не оцениваем: по «Назад» сайт
 * перерисовывается не сразу, и любая проверка (в том числе отложенная с
 * прошлой страницы) увидела бы прошлую главу.
 */
const NAV_GRACE_MS = 500;
/**
 * Ушли с главы на не-главу (в оглавление) — кнопка уходит, когда окно
 * наблюдения закончилось, а глава так и не появилась: медленно грузящаяся
 * следующая глава не заставит кнопку мигать. Пока идёт отправка, ждём её конца.
 */
const SETTLE_RETRY_MS = 3000;

function configured(): boolean {
  return APP_ORIGIN.indexOf("__TOLMACH_") !== 0 && IMPORT_TOKEN.indexOf("__TOLMACH_") !== 0 && /^https?:\/\//.test(APP_ORIGIN);
}

// ── Запросы через менеджер ──────────────────────────────────────────────

interface PageResult {
  status: number;
  headers: Record<string, string>;
  html: string;
  finalUrl: string;
}

/** Ошибка с текстом для читателя. */
class UserError extends Error {
  code: ErrorCode;
  constructor(message: string, code: ErrorCode = "unknown") {
    super(message);
    this.code = code;
  }
}

function hasGm(name: "GM_xmlhttpRequest" | "GM_setValue" | "GM_getValue" | "GM_openInTab" | "GM_registerMenuCommand"): boolean {
  switch (name) {
    case "GM_xmlhttpRequest":
      return typeof GM_xmlhttpRequest === "function";
    case "GM_setValue":
      return typeof GM_setValue === "function";
    case "GM_getValue":
      return typeof GM_getValue === "function";
    case "GM_openInTab":
      return typeof GM_openInTab === "function";
    case "GM_registerMenuCommand":
      return typeof GM_registerMenuCommand === "function";
  }
  return false;
}

function gmRequest(details: GmXhrDetails): Promise<GmXhrResponse> {
  return new Promise((resolve, reject) => {
    if (!hasGm("GM_xmlhttpRequest")) {
      reject(new UserError("Менеджер скриптов не дал кнопке доступ к сети. Переустановите кнопку на странице «Кнопка для сайтов» в Толмаче."));
      return;
    }
    const host = hostOf(details.url);
    GM_xmlhttpRequest({
      timeout: 30000,
      ...details,
      onload: (r) => resolve(r),
      onerror: () => reject(new UserError("Не достучались до " + host + ". Проверьте интернет и попробуйте ещё раз.", "network")),
      ontimeout: () => reject(new UserError(host + " не ответил вовремя. Попробуйте ещё раз.", "network")),
      onabort: () => reject(new UserError("Запрос к " + host + " прерван.", "network")),
    });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url, location.href).hostname;
  } catch {
    return url;
  }
}

/**
 * Страница сайта для цикла «и следующие N»: свой сайт — обычным fetch из
 * страницы (куки идут сами, разрешение менеджера не нужно), чужой или если
 * fetch не вышел — через GM_xmlhttpRequest с куками пользователя.
 */
async function fetchSitePage(url: string): Promise<PageResult> {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url, location.href).origin === location.origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin && typeof fetch === "function") {
    try {
      const r = await fetch(url, { credentials: "include", redirect: "follow" });
      const headers: Record<string, string> = {};
      r.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers, html: decodeHtml(bytes, headers["content-type"] || null), finalUrl: r.url || url };
    } catch {
      // ниже — запасной путь через менеджер
    }
  }
  const g = await gmRequest({ method: "GET", url, anonymous: false, timeout: 20000 });
  return { status: g.status, headers: parseRawHeaders(g.responseHeaders), html: g.responseText || "", finalUrl: g.finalUrl || url };
}

/** POST /api/import с ключом кнопки. Куки приложения тут не нужны и не шлются. */
async function importChapters(chapters: ExtractedChapter[]): Promise<ImportResponse> {
  const body: ImportRequest = { chapters: chapters.map((c) => ({ ...c, source: "button" as const })) };
  const r = await gmRequest({
    method: "POST",
    url: APP_ORIGIN + "/api/import",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + IMPORT_TOKEN },
    data: JSON.stringify(body),
    anonymous: true,
    timeout: 30000,
  });
  if (r.status === 401 || r.status === 403) {
    throw new UserError("Ключ кнопки устарел — переустановите кнопку в Толмаче (страница «Кнопка для сайтов»).", "auth");
  }
  if (r.status === 413) throw new UserError("Глава слишком большая для отправки кнопкой. Сохраните страницу и добавьте файлом.", "too_large");
  if (r.status < 200 || r.status >= 300) {
    throw new UserError("Толмач ответил ошибкой " + r.status + ". " + serverMessage(r.responseText), "unknown");
  }
  let parsed: ImportResponse | null = null;
  try {
    parsed = JSON.parse(r.responseText) as ImportResponse;
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.items || !parsed.items.length) throw new UserError("Толмач ответил что-то непонятное. Попробуйте ещё раз.");
  return parsed;
}

function serverMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : "";
    return m.slice(0, 200);
  } catch {
    return "";
  }
}

function openInApp(chapterId: string): void {
  const url = APP_ORIGIN + "/read/" + encodeURIComponent(chapterId);
  if (hasGm("GM_openInTab")) {
    try {
      GM_openInTab(url, { active: true, insert: true });
      return;
    } catch {
      // ниже — обычное окно
    }
  }
  // После долгого запроса браузер уже не считает это нажатием и может
  // заблокировать окно — тогда уходим на читалку в этой же вкладке.
  const w = window.open(url, "_blank");
  if (!w) location.assign(url);
}

function errorText(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  return "Не получилось: " + m;
}

// ── Снятие текущей и следующих глав ─────────────────────────────────────

function extractCurrent(): ExtractedChapter {
  markHiddenLive(document);
  return extractFromDocument(document.cloneNode(true) as Document, { url: location.href });
}

/** Похоже ли на главу: так думает режим чтения или есть 5 абзацев по 25+ слов. */
function looksLikeChapterPage(): boolean {
  try {
    // isProbablyReaderable только читает документ — клон не нужен.
    if (isProbablyReaderable(document)) return true;
  } catch {
    // проверим по абзацам
  }
  const ps = document.querySelectorAll("p");
  let n = 0;
  for (let i = 0; i < ps.length; i++) {
    if (countWords(ps[i].textContent || "") >= 25) {
      n++;
      if (n >= 5) return true;
    }
  }
  return false;
}

/** Следующая страница, снятая без раскладки: стили из <style> → невидимое прочь. */
function chapterFromHtml(html: string, url: string): ExtractedChapter {
  const doc = new DOMParser().parseFromString(html, "text/html");
  markHiddenByStyles(doc);
  return extractFromDocument(doc, { url });
}

interface LoopState {
  v: 1;
  host: string;
  /** Сколько глав взять всего, вместе с текущей. */
  total: number;
  /** Сколько уже снято (отправленные + ждущие отправки). */
  done: number;
  nextUrl: string | null;
  seen: string[];
  pending: ExtractedChapter[];
  firstChapterId: string | null;
  sent: number;
  startedAt: number;
  updatedAt: number;
  /** Пульс работающей вкладки. */
  beat: number;
}

function loadLoop(): LoopState | null {
  if (!hasGm("GM_getValue")) return null;
  try {
    const raw = GM_getValue<string>(LOOP_KEY, "");
    if (!raw) return null;
    const s = JSON.parse(raw) as LoopState;
    return s && s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

function saveLoop(s: LoopState | null): void {
  if (!hasGm("GM_setValue")) return;
  try {
    GM_setValue(LOOP_KEY, s ? JSON.stringify(s) : "");
  } catch {
    // без сохранения цикл просто не переживёт перезагрузку
  }
}

function urlKey(url: string): string {
  return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

/**
 * Адрес «страницы» для слежки за переходами: якорь вроде #comments не в
 * счёт, а маршрут в якоре (#/book/ch-5, #!/…) — в счёт.
 */
function navKey(url: string): string {
  const hash = url.indexOf("#");
  if (hash >= 0 && /^#[/!]/.test(url.slice(hash))) return url.slice(0, hash).replace(/\/+$/, "") + url.slice(hash);
  return urlKey(url);
}

let running = false;
let stopRequested = false;

async function translateThis(ui: Ui): Promise<void> {
  if (running) return;
  running = true;
  ui.setLabel("…");
  try {
    const chapter = extractCurrent();
    if (chapter.paragraphs.length === 0) throw new UserError("На этой странице не нашлось текста главы.", "not_chapter");
    if (chapter.looksLikeIndex) throw new UserError("Это похоже на оглавление, а не на главу. Откройте саму главу.", "not_chapter");
    if (chapter.looksLocked) ui.toast("Похоже, глава закрыта — отправляю то, что видно на странице.");
    const res = await importChapters([chapter]);
    const item = res.items[0];
    ui.toast(item.created ? "Глава в Толмаче — открываю." : "Эта глава уже была в Толмаче — открываю.");
    openInApp(item.chapterId);
  } catch (e) {
    ui.toast(errorText(e));
  } finally {
    running = false;
    ui.setLabel(null);
  }
}

async function startLoop(ui: Ui, more: number): Promise<void> {
  if (running) return;
  let first: ExtractedChapter;
  try {
    first = extractCurrent();
  } catch (e) {
    ui.toast(errorText(e));
    return;
  }
  if (first.paragraphs.length === 0 || first.looksLikeIndex) {
    ui.toast("На этой странице не нашлось текста главы.");
    return;
  }
  const now = Date.now();
  const state: LoopState = {
    v: 1,
    host: location.host,
    total: more + 1,
    done: 1,
    nextUrl: first.nextUrl,
    seen: [urlKey(location.href)],
    pending: [first],
    firstChapterId: null,
    sent: 0,
    startedAt: now,
    updatedAt: now,
    beat: now,
  };
  if (!first.nextUrl) ui.toast("Ссылку на следующую главу не нашёл — отправляю только эту.");
  saveLoop(state);
  await runLoop(ui, state);
}

/** Отправить ждущие главы группами по ≤5 и ≤90 КБ; первая глава цикла запоминается. */
async function flushPending(state: LoopState, all: boolean): Promise<void> {
  while (state.pending.length >= (all ? 1 : GROUP_SIZE)) {
    const group: ExtractedChapter[] = [];
    let size = 0;
    for (const ch of state.pending) {
      const len = JSON.stringify(ch).length;
      if (group.length > 0 && (group.length >= GROUP_SIZE || size + len > GROUP_MAX_CHARS)) break;
      group.push(ch);
      size += len;
    }
    const res = await importChapters(group);
    if (!state.firstChapterId && res.items.length > 0) state.firstChapterId = res.items[0].chapterId;
    state.pending = state.pending.slice(group.length);
    state.sent += group.length;
    state.updatedAt = Date.now();
    saveLoop(state);
  }
}

async function runLoop(ui: Ui, state: LoopState): Promise<void> {
  running = true;
  stopRequested = false;
  const beat = setInterval(() => {
    state.beat = Date.now();
    saveLoop(state);
  }, BEAT_MS);
  let note = "";
  try {
    while (!stopRequested && state.done < state.total && state.nextUrl) {
      ui.setLabel(state.done + 1 + "/" + state.total);
      // Пауза 3–5 с: не долбить чужой сайт очередью запросов.
      await sleep(3000 + Math.floor(Math.random() * 2000));
      if (stopRequested) break;
      const url = state.nextUrl;
      if (state.seen.indexOf(urlKey(url)) >= 0) break; // «дальше» ведёт по кругу
      const page = await fetchSitePage(url);
      if (isChallengePage({ status: page.status, headers: page.headers, html: page.html })) {
        note = "Сайт попросил проверку «вы не робот?» на главе " + (state.done + 1) + ". Откройте её и нажмите «Т» ещё раз.";
        break;
      }
      if (page.status >= 400) {
        note = "Сайт ответил ошибкой " + page.status + " на главе " + (state.done + 1) + ".";
        break;
      }
      const ch = chapterFromHtml(page.html, page.finalUrl || url);
      if (ch.paragraphs.length === 0 || ch.looksLikeIndex) {
        note = "Дальше не глава — остановился.";
        break;
      }
      state.seen.push(urlKey(url));
      state.pending.push(ch);
      state.done++;
      state.nextUrl = ch.nextUrl;
      state.updatedAt = Date.now();
      saveLoop(state);
      if (state.pending.length >= GROUP_SIZE) await flushPending(state, false);
    }
    ui.setLabel("↑");
    await flushPending(state, true);
    saveLoop(null);
    const got = state.sent;
    ui.toast((note ? note + " " : "") + "В Толмаче глав: " + got + ". Открываю первую.");
    if (state.firstChapterId) openInApp(state.firstChapterId);
  } catch (e) {
    // Ключ устарел — продолжать бессмысленно; прочие беды (сеть) — цикл
    // сохранён и продолжится при следующем открытии страницы.
    if (e instanceof UserError && e.code === "auth") saveLoop(null);
    ui.toast(errorText(e));
  } finally {
    clearInterval(beat);
    running = false;
    ui.setLabel(null);
  }
}

/** Незаконченный цикл с прошлого открытия — продолжить, если вкладка-хозяйка мертва. */
function maybeResume(ui: Ui): void {
  const s = loadLoop();
  if (!s) return;
  const now = Date.now();
  if (now - s.updatedAt > LOOP_STALE_MS) {
    saveLoop(null);
    return;
  }
  if (s.host !== location.host) return;
  if (now - s.beat < BEAT_MS * 3) {
    // Пульс свежий: либо цикл идёт в другой вкладке, либо эту только что
    // перезагрузили. Посмотрим ещё раз чуть позже.
    setTimeout(() => {
      if (!running) maybeResume(ui);
    }, BEAT_MS * 4);
    return;
  }
  ui.toast("Продолжаю: взято " + s.done + " из " + s.total + ".");
  void runLoop(ui, s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Готовый перевод: обход глав на русском сайте ────────────────────────
//
// Главы чужого готового перевода нужны Толмачу для глоссария и стиля.
// Сайты переводов часто — приложения: текст главы рисуется скриптом, и
// скачанная страница пуста. Поэтому обход идёт в этой же вкладке: снять
// главу со страницы, отправить, перейти по «Дальше», дождаться текста —
// и так до конца. Состояние — в хранилище менеджера: после перехода
// скрипт запускается заново и продолжает.

interface WalkState {
  v: 1;
  host: string;
  bookId: string;
  bookTitle: string;
  /** Сколько глав взять всего, вместе с первой; -1 — до конца. */
  total: number;
  done: number;
  lastNumber: number | null;
  seen: string[];
  startedAt: number;
  updatedAt: number;
}

function loadWalk(): WalkState | null {
  if (!hasGm("GM_getValue")) return null;
  try {
    const raw = GM_getValue<string>(WALK_KEY, "");
    if (!raw) return null;
    const s = JSON.parse(raw) as WalkState;
    return s && s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

function saveWalk(s: WalkState | null): void {
  if (!hasGm("GM_setValue")) return;
  try {
    GM_setValue(WALK_KEY, s ? JSON.stringify(s) : "");
  } catch {
    // без сохранения обход не переживёт переход
  }
}

function refBookFor(host: string): { id: string; title: string } | null {
  if (!hasGm("GM_getValue")) return null;
  try {
    const raw = GM_getValue<string>(REFBOOK_KEY + host, "");
    const b = raw ? (JSON.parse(raw) as { id?: unknown; title?: unknown }) : null;
    return b && typeof b.id === "string" ? { id: b.id, title: typeof b.title === "string" ? b.title : "" } : null;
  } catch {
    return null;
  }
}

function saveRefBook(host: string, book: { id: string; title: string } | null): void {
  if (!hasGm("GM_setValue")) return;
  try {
    GM_setValue(REFBOOK_KEY + host, book ? JSON.stringify(book) : "");
  } catch {
    // выбор просто не запомнится
  }
}

/** Русская страница: кириллицы в тексте больше, чем латиницы. */
function isRussianPage(): boolean {
  const text = ((document.body && document.body.textContent) || "").slice(0, 40000);
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return cyr > 200 && cyr > lat;
}

async function fetchRefBooks(): Promise<RefBookItem[]> {
  const r = await gmRequest({
    method: "GET",
    url: APP_ORIGIN + "/api/reference/books",
    headers: { Authorization: "Bearer " + IMPORT_TOKEN },
    anonymous: true,
    timeout: 20000,
  });
  if (r.status === 401 || r.status === 403) {
    throw new UserError("Ключ кнопки устарел — переустановите кнопку в Толмаче (страница «Кнопка для сайтов»).", "auth");
  }
  if (r.status < 200 || r.status >= 300) throw new UserError("Толмач ответил ошибкой " + r.status + ". " + serverMessage(r.responseText));
  try {
    const j = JSON.parse(r.responseText) as { books?: RefBookItem[] };
    return Array.isArray(j.books) ? j.books : [];
  } catch {
    throw new UserError("Толмач ответил что-то непонятное. Попробуйте ещё раз.");
  }
}

/** Отправить главу готового перевода; вернёт номер, под которым она записана. */
async function importRef(bookId: string, chapter: ExtractedChapter, expectedNumber: number | null): Promise<number> {
  const body: RefImportRequest = {
    bookId,
    chapters: [{ url: chapter.url, chapterTitle: chapter.chapterTitle, paragraphs: chapter.paragraphs, expectedNumber }],
  };
  const r = await gmRequest({
    method: "POST",
    url: APP_ORIGIN + "/api/reference/import",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + IMPORT_TOKEN },
    data: JSON.stringify(body),
    anonymous: true,
    timeout: 30000,
  });
  if (r.status === 401 || r.status === 403) {
    throw new UserError("Ключ кнопки устарел — переустановите кнопку в Толмаче (страница «Кнопка для сайтов»).", "auth");
  }
  if (r.status === 404) throw new UserError("Этой книги в Толмаче больше нет — выберите книгу заново.", "unknown");
  if (r.status < 200 || r.status >= 300) throw new UserError("Толмач ответил ошибкой " + r.status + ". " + serverMessage(r.responseText));
  let parsed: RefImportResponse | null = null;
  try {
    parsed = JSON.parse(r.responseText) as RefImportResponse;
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.items || !parsed.items.length) throw new UserError("Толмач ответил что-то непонятное. Попробуйте ещё раз.");
  return parsed.items[0].number;
}

/** Дождаться текста главы на странице: два замера подряд с одним числом абзацев. */
async function waitForChapter(ms: number): Promise<ExtractedChapter | null> {
  const until = Date.now() + ms;
  let last = -1;
  while (Date.now() < until && !stopRequested) {
    if (looksLikeChapterPage()) {
      const ch = extractCurrent();
      if (ch.paragraphs.length > 0 && !ch.looksLikeIndex && ch.paragraphs.length === last) return ch;
      last = ch.paragraphs.length;
    }
    await sleep(1000);
  }
  return null;
}

/** Кнопка «Следующая глава» без адреса (сайты-приложения). */
function findNextButton(): HTMLElement | null {
  const re = /^(?:следующая(?: глава)?|далее|дальше|вперёд|вперед|next(?: chapter)?|»|›|→|>)$/i;
  const els = document.querySelectorAll("button, [role=button], a:not([href])");
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement;
    if (el.closest("[data-tolmach-ui]")) continue;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
    const label = (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (re.test(label)) return el;
  }
  return null;
}

function walkLabel(s: WalkState): string {
  return s.total > 0 ? Math.min(s.done + 1, s.total) + "/" + s.total : String(s.done + 1);
}

/** Начать обход с этой страницы. total — глав всего вместе с этой (-1 — до конца). */
async function startWalk(ui: Ui, book: { id: string; title: string }, total: number): Promise<void> {
  if (running) return;
  const now = Date.now();
  const state: WalkState = {
    v: 1,
    host: location.host,
    bookId: book.id,
    bookTitle: book.title,
    total: total > 0 ? Math.min(total, WALK_MAX) : -1,
    done: 0,
    lastNumber: null,
    seen: [],
    startedAt: now,
    updatedAt: now,
  };
  await walkHere(ui, state);
}

/** Шаг обхода на этой странице: снять, отправить, перейти дальше или закончить. */
async function walkHere(ui: Ui, state: WalkState): Promise<void> {
  running = true;
  stopRequested = false;
  ui.setLabel(walkLabel(state));
  let navigating = false;
  try {
    const chapter = await waitForChapter(state.done === 0 ? 3000 : WALK_WAIT_MS);
    if (stopRequested) return finishWalk(ui, state, "Остановлено.");
    if (!chapter) return finishWalk(ui, state, "Глава не загрузилась — остановился. Возможно, сайт просит войти или пройти проверку.");
    const number = await importRef(state.bookId, chapter, state.lastNumber !== null ? state.lastNumber + 1 : null);
    state.done += 1;
    state.lastNumber = number;
    state.seen.push(urlKey(location.href));
    if (state.seen.length > 50) state.seen = state.seen.slice(-50);
    state.updatedAt = Date.now();
    const limit = state.total > 0 ? state.total : WALK_MAX;
    if (state.done >= limit) return finishWalk(ui, state, "");
    const next = chapter.nextUrl;
    // «Дальше» бывает кнопкой без адреса: сайт меняет главу своим скриптом.
    const nextButton = next ? null : findNextButton();
    if (!next && !nextButton) return finishWalk(ui, state, "Ссылки на следующую главу нет — это, похоже, последняя.");
    if (next && state.seen.indexOf(urlKey(next)) >= 0) return finishWalk(ui, state, "«Дальше» ведёт по кругу — остановился.");
    saveWalk(state);
    ui.setLabel(walkLabel(state));
    // Пауза 3–5 с: не долбить чужой сайт.
    await sleep(3000 + Math.floor(Math.random() * 2000));
    if (stopRequested || !loadWalk()) return finishWalk(ui, state, "Остановлено.");
    if (next) {
      navigating = true;
      location.assign(next);
      return;
    }
    const before = location.href;
    nextButton!.click();
    const until = Date.now() + 15000;
    while (location.href === before && Date.now() < until) await sleep(300);
    if (location.href === before) return finishWalk(ui, state, "Кнопка «Дальше» не открыла следующую главу — остановился.");
    if (state.seen.indexOf(urlKey(location.href)) >= 0) return finishWalk(ui, state, "«Дальше» ведёт по кругу — остановился.");
    // Та же страница, новый адрес: продолжаем здесь же, без перезагрузки.
    navigating = true;
    running = false;
    void walkHere(ui, state);
  } catch (e) {
    saveWalk(null);
    ui.toast("Остановился на главе " + (state.done + 1) + ": " + errorText(e));
  } finally {
    if (!navigating) {
      running = false;
      ui.setLabel(null);
    }
  }
}

function finishWalk(ui: Ui, state: WalkState, note: string): void {
  saveWalk(null);
  const got = state.done > 0 ? "В Толмаче глав готового перевода: +" + state.done + (state.lastNumber !== null ? " (до главы " + state.lastNumber + ")" : "") + "." : "";
  ui.toast([note, got, got ? "Глоссарий собирается на странице книги в Толмаче." : ""].filter(Boolean).join(" "));
}

/** Незаконченный обход на этом сайте — продолжить с текущей страницы. */
function resumeWalk(ui: Ui): boolean {
  const s = loadWalk();
  if (!s || s.host !== location.host) return false;
  if (Date.now() - s.updatedAt > WALK_STALE_MS) {
    saveWalk(null);
    return false;
  }
  void walkHere(ui, s);
  return true;
}

/** Выбрать книгу Толмача для этого сайта (список — из Толмача). */
async function pickRefBook(ui: Ui): Promise<{ id: string; title: string } | null> {
  ui.toast("Загружаю книги из Толмача…");
  let books: RefBookItem[];
  try {
    books = await fetchRefBooks();
  } catch (e) {
    ui.toast(errorText(e));
    return null;
  }
  if (books.length === 0) {
    ui.toast("В Толмаче пока нет книг. Сначала добавьте английскую главу этой книги кнопкой «Т» на сайте с оригиналом.");
    return null;
  }
  const picked = await ui.choose(
    "Чей это перевод? Книга в Толмаче:",
    books.map((b) => ({ label: b.title + (b.refChapters ? " · готовых глав: " + b.refChapters : ""), value: b.id })),
  );
  if (!picked) return null;
  const book = books.filter((b) => b.id === picked)[0];
  const chosen = { id: book.id, title: book.title };
  saveRefBook(location.host, chosen);
  return chosen;
}

async function walkWithBook(ui: Ui, total: number): Promise<void> {
  const book = refBookFor(location.host) || (await pickRefBook(ui));
  if (book) await startWalk(ui, book, total);
}

// ── Кнопка и меню ───────────────────────────────────────────────────────

interface Ui {
  setLabel(text: string | null): void;
  toast(text: string): void;
  remove(): void;
  /** Кнопка всё ещё на странице: сайт при перерисовке мог её выкинуть. */
  attached(): boolean;
  reattach(): void;
  /** Показать выбор в меню; null — «Отмена». */
  choose(title: string, options: Array<{ label: string; value: string }>): Promise<string | null>;
}

const CSS = `
:host { all: initial; }
.wrap { position: relative; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.btn { width: 54px; height: 54px; border-radius: 50%; border: 0; padding: 0; margin: 0;
  background: #1f4e5f; color: #fff; font-size: 24px; font-weight: 700; line-height: 54px; text-align: center;
  box-shadow: 0 4px 14px rgba(0,0,0,.35); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.btn.small { font-size: 14px; }
.menu { position: absolute; right: 0; bottom: 64px; width: 250px; max-width: 86vw; background: #fff; color: #1b1b1b;
  border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); padding: 6px 0; display: none; }
.menu.open { display: block; }
.item { display: block; width: 100%; box-sizing: border-box; text-align: left; padding: 13px 16px; margin: 0;
  background: none; border: 0; font-size: 16px; line-height: 1.3; color: inherit; font-family: inherit; cursor: pointer; }
.item:active, .item:hover { background: #e8f0f2; }
.item.muted { color: #666; }
.head { padding: 10px 16px 6px; font-size: 13px; color: #666; line-height: 1.3; }
.toast { position: absolute; right: 0; bottom: 64px; width: 290px; max-width: 86vw; box-sizing: border-box;
  background: #222; color: #fff; padding: 12px 14px; border-radius: 10px; font-size: 15px; line-height: 1.35;
  box-shadow: 0 6px 24px rgba(0,0,0,.3); display: none; }
.toast.show { display: block; }
`;

/** onClose — читатель нажал «Закрыть». */
function createUi(onClose: () => void): Ui {
  const host = document.createElement("tolmach-button");
  host.setAttribute("data-tolmach-ui", "1");
  // Свой интерфейс не должен попасть в текст главы.
  host.setAttribute(HIDDEN_ATTR, "1");
  const css: Array<[string, string]> = [
    ["all", "initial"],
    ["position", "fixed"],
    ["right", "16px"],
    // Выше нижней панели мобильного браузера и под большим пальцем.
    ["bottom", "96px"],
    ["z-index", "2147483647"],
    ["display", "block"],
  ];
  for (const [k, v] of css) host.style.setProperty(k, v, "important");

  const root: ShadowRoot | HTMLElement = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "closed" }) : host;
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";
  btn.textContent = "Т";
  btn.setAttribute("aria-label", "Толмач");
  const menu = document.createElement("div");
  menu.className = "menu";
  const toastEl = document.createElement("div");
  toastEl.className = "toast";
  wrap.appendChild(menu);
  wrap.appendChild(toastEl);
  wrap.appendChild(btn);
  root.appendChild(wrap);

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const closeMenu = () => {
    menu.className = "menu";
  };
  const mount = () => {
    (document.body || document.documentElement).appendChild(host);
  };
  const ui: Ui = {
    setLabel(text) {
      btn.textContent = text || "Т";
      btn.className = text && text.length > 1 ? "btn small" : "btn";
    },
    toast(text) {
      menu.className = "menu";
      toastEl.textContent = text;
      toastEl.className = "toast show";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.className = "toast";
      }, 6000);
    },
    remove() {
      document.removeEventListener("click", closeMenu);
      if (host.parentNode) host.parentNode.removeChild(host);
    },
    attached() {
      return host.isConnected;
    },
    reattach() {
      if (!host.isConnected) mount();
    },
    choose(title, options) {
      return new Promise((resolve) => {
        while (menu.firstChild) menu.removeChild(menu.firstChild);
        toastEl.className = "toast";
        const head = document.createElement("div");
        head.className = "head";
        head.textContent = title;
        menu.appendChild(head);
        for (const o of options) item(o.label, () => resolve(o.value));
        item("Отмена", () => resolve(null), true);
        menu.className = "menu open";
      });
    },
  };
  toastEl.addEventListener("click", () => {
    toastEl.className = "toast";
  });

  const item = (label: string, action: () => void, muted?: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = muted ? "item muted" : "item";
    b.textContent = label;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.className = "menu";
      action();
    });
    menu.appendChild(b);
  };
  const fillMenu = () => {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    if (running) {
      item("Остановить", () => {
        stopRequested = true;
        saveWalk(null);
        ui.toast("Останавливаюсь — отправлю то, что уже взял.");
      });
    } else if (isRussianPage()) {
      const book = refBookFor(location.host);
      item(book ? "Книга в Толмаче: " + book.title + " · сменить" : "Чей это перевод? Выбрать книгу", () => void pickRefBook(ui).then((b) => b && ui.toast("Книга: " + b.title)), true);
      item("Готовый перевод: взять эту главу", () => void walkWithBook(ui, 1));
      item("Готовый перевод: эту и следующие 10", () => void walkWithBook(ui, 11));
      item("Готовый перевод: эту и следующие 50", () => void walkWithBook(ui, 51));
      item("Готовый перевод: эту и все следующие", () => void walkWithBook(ui, -1));
      item("Закрыть", onClose, true);
    } else {
      item("Перевести эту главу", () => void translateThis(ui));
      item("Взять эту и следующие 3", () => void startLoop(ui, 3));
      item("Взять эту и следующие 5", () => void startLoop(ui, 5));
      item("Взять эту и следующие 10", () => void startLoop(ui, 10));
      // Посреди отправки не закрываем: прогресс и итог пишутся в эту кнопку.
      item("Закрыть", onClose, true);
    }
  };
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toastEl.className = "toast";
    if (menu.className.indexOf("open") >= 0) {
      menu.className = "menu";
    } else {
      fillMenu();
      menu.className = "menu open";
    }
  });
  document.addEventListener("click", closeMenu);

  mount();
  return ui;
}

function startButton(): void {
  let ui: Ui | null = null;
  /** Адрес, на котором читатель закрыл кнопку: там она сама больше не всплывает. */
  let closedAt: string | null = null;
  /** Кнопку вызвали из меню дополнения — не убирать её самим до «Закрыть». */
  let forced = false;
  let lastKey = navKey(location.href);
  let navAt = 0;

  const hide = () => {
    if (ui) ui.remove();
    ui = null;
  };
  const show = (): Ui => {
    if (!ui) {
      ui = createUi(() => {
        closedAt = navKey(location.href);
        forced = false;
        hide();
      });
    }
    return ui;
  };

  // Глава могла дорисоваться скриптом сайта — проверяем страницу, пока она
  // меняется (не чаще раза в MUTATION_THROTTLE_MS), и по таймеру.
  let watchUntil = 0;
  let observer: MutationObserver | null = null;
  let throttle: ReturnType<typeof setTimeout> | null = null;
  const stopWatching = () => {
    if (observer) observer.disconnect();
    observer = null;
  };
  const evaluate = () => {
    if (Date.now() - navAt < NAV_GRACE_MS) return;
    if (ui || closedAt === navKey(location.href)) {
      stopWatching();
      return;
    }
    if (looksLikeChapterPage()) {
      show();
      stopWatching();
      return;
    }
    if (Date.now() >= watchUntil) stopWatching();
  };
  /** now — проверить сразу (при загрузке); после перехода — только по таймеру и изменениям. */
  const watch = (now: boolean) => {
    watchUntil = Date.now() + WATCH_MS;
    if (now) evaluate();
    if (ui) return;
    for (const ms of WATCH_TICKS_MS) setTimeout(evaluate, ms);
    if (!observer && typeof MutationObserver === "function" && document.body) {
      observer = new MutationObserver(() => {
        if (throttle) return;
        throttle = setTimeout(() => {
          throttle = null;
          evaluate();
        }, MUTATION_THROTTLE_MS);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  };
  // Окно наблюдения после перехода кончилось: не глава — кнопку убрать.
  const settle = (key: string) => {
    if (lastKey !== key || forced || !ui) return;
    if (running) {
      setTimeout(() => settle(key), SETTLE_RETRY_MS);
      return;
    }
    if (!looksLikeChapterPage()) hide();
  };

  // Переход без перезагрузки: новый адрес — новое окно наблюдения.
  const onUrlMaybeChanged = () => {
    if (ui && !ui.attached()) ui.reattach();
    const key = navKey(location.href);
    if (key === lastKey) return;
    lastKey = key;
    navAt = Date.now();
    if (closedAt !== key) closedAt = null;
    watch(false);
    setTimeout(() => settle(key), WATCH_MS);
  };
  setInterval(onUrlMaybeChanged, URL_POLL_MS);
  window.addEventListener("popstate", onUrlMaybeChanged);
  window.addEventListener("hashchange", onUrlMaybeChanged);

  // Запасной путь, если сайт не похож на главу: меню дополнения → «Показать кнопку».
  if (hasGm("GM_registerMenuCommand")) {
    try {
      GM_registerMenuCommand("Показать кнопку «Т»", () => {
        closedAt = null;
        forced = true;
        show();
      });
    } catch {
      // без пункта меню — только автоматический показ
    }
  }

  const walk = loadWalk();
  if (walk && walk.host === location.host) {
    forced = true;
    if (resumeWalk(show())) return;
    forced = false;
    hide();
  }
  const pending = loadLoop();
  if (pending && pending.host === location.host) {
    maybeResume(show());
    return;
  }
  watch(true);
}

// ── Мост на страницах приложения ────────────────────────────────────────

interface FetchMessage {
  type: "tolmach:fetch";
  requestId: string;
  url: string;
}

function isOwnWindow(source: unknown): boolean {
  if (!source) return false;
  if (source === window) return true;
  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow && source === unsafeWindow) return true;
  } catch {
    // нет доступа к окну страницы — значит, не оно
  }
  return false;
}

function startBridge(): void {
  document.documentElement.setAttribute("data-tolmach-bridge", String(BRIDGE_VERSION));
  const announce = () => {
    window.postMessage({ type: "tolmach:bridge-ready", version: BRIDGE_VERSION }, APP_ORIGIN);
  };
  window.addEventListener("message", (ev: MessageEvent) => {
    // Только своё окно и своё приложение: мост ходит на сайты с куками
    // пользователя, отдавать эту возможность чужой странице нельзя.
    if (ev.origin !== APP_ORIGIN || !isOwnWindow(ev.source)) return;
    const d = ev.data as { type?: unknown; requestId?: unknown; url?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "tolmach:bridge-ping") {
      announce();
      return;
    }
    if (d.type !== "tolmach:fetch" || typeof d.requestId !== "string" || typeof d.url !== "string") return;
    void handleFetch(d as FetchMessage);
  });
  announce();
  if (document.readyState !== "complete") window.addEventListener("load", announce);
}

async function handleFetch(msg: FetchMessage): Promise<void> {
  const reply = (body: { ok: boolean; chapter?: ExtractedChapter; code?: ErrorCode; message?: string }) => {
    window.postMessage({ type: "tolmach:fetched", requestId: msg.requestId, ...body }, APP_ORIGIN);
  };
  let target: URL;
  try {
    target = new URL(msg.url);
  } catch {
    reply({ ok: false, code: "unknown", message: "Непонятный адрес главы." });
    return;
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.origin === APP_ORIGIN) {
    reply({ ok: false, code: "unknown", message: "Такой адрес мост не открывает." });
    return;
  }
  try {
    const r = await gmRequest({ method: "GET", url: target.toString(), anonymous: false, timeout: 20000 });
    const headers = parseRawHeaders(r.responseHeaders);
    const html = r.responseText || "";
    if (isChallengePage({ status: r.status, headers, html })) {
      reply({ ok: false, code: "site_blocked", message: "Сайт просит проверку «вы не робот?». Откройте главу на сайте и нажмите там «Т»." });
      return;
    }
    if (r.status === 404 || r.status === 410) {
      reply({ ok: false, code: "not_chapter", message: "Такой страницы на сайте нет (" + r.status + ")." });
      return;
    }
    if (r.status < 200 || r.status >= 300) {
      reply({ ok: false, code: r.status === 403 || r.status === 429 || r.status === 503 ? "site_blocked" : "network", message: "Сайт ответил " + r.status + "." });
      return;
    }
    const chapter = chapterFromHtml(html, r.finalUrl || target.toString());
    if (chapter.paragraphs.length === 0 || chapter.looksLikeIndex) {
      reply({ ok: false, code: "not_chapter", message: "На странице не нашлось текста главы." });
      return;
    }
    reply({ ok: true, chapter });
  } catch (e) {
    reply({ ok: false, code: e instanceof UserError ? e.code : "network", message: errorText(e) });
  }
}

// ── Запуск ──────────────────────────────────────────────────────────────

function main(): void {
  if (!configured()) return;
  if (window.top !== window.self) return; // не во фреймах рекламы и комментариев
  const rootEl = document.documentElement;
  if (!rootEl || rootEl.hasAttribute("data-tolmach-script")) return; // скрипт поставлен дважды
  rootEl.setAttribute("data-tolmach-script", "1");
  if (location.origin === APP_ORIGIN) startBridge();
  else startButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
