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
import type { ErrorCode, ExtractedChapter, ImportRequest, ImportResponse } from "../lib/types";

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

function hasGm(name: "GM_xmlhttpRequest" | "GM_setValue" | "GM_getValue" | "GM_openInTab"): boolean {
  switch (name) {
    case "GM_xmlhttpRequest":
      return typeof GM_xmlhttpRequest === "function";
    case "GM_setValue":
      return typeof GM_setValue === "function";
    case "GM_getValue":
      return typeof GM_getValue === "function";
    case "GM_openInTab":
      return typeof GM_openInTab === "function";
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

// ── Кнопка и меню ───────────────────────────────────────────────────────

interface Ui {
  setLabel(text: string | null): void;
  toast(text: string): void;
  remove(): void;
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
.toast { position: absolute; right: 0; bottom: 64px; width: 290px; max-width: 86vw; box-sizing: border-box;
  background: #222; color: #fff; padding: 12px 14px; border-radius: 10px; font-size: 15px; line-height: 1.35;
  box-shadow: 0 6px 24px rgba(0,0,0,.3); display: none; }
.toast.show { display: block; }
`;

function createUi(): Ui {
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
      if (host.parentNode) host.parentNode.removeChild(host);
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
        ui.toast("Останавливаюсь — отправлю то, что уже взял.");
      });
    } else {
      item("Перевести эту главу", () => void translateThis(ui));
      item("Взять эту и следующие 3", () => void startLoop(ui, 3));
      item("Взять эту и следующие 5", () => void startLoop(ui, 5));
      item("Взять эту и следующие 10", () => void startLoop(ui, 10));
    }
    item("Закрыть", () => ui.remove(), true);
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
  document.addEventListener("click", () => {
    menu.className = "menu";
  });

  (document.body || document.documentElement).appendChild(host);
  return ui;
}

function startButton(): void {
  let ui: Ui | null = null;
  const show = () => {
    if (!ui) ui = createUi();
    return ui;
  };
  const pending = loadLoop();
  if (pending && pending.host === location.host) {
    maybeResume(show());
    return;
  }
  // Сайты-приложения дорисовывают главу скриптом — проверяем ещё пару раз.
  const check = (left: number) => {
    if (ui) return;
    if (looksLikeChapterPage()) {
      show();
      return;
    }
    if (left > 0) setTimeout(() => check(left - 1), 2500);
  };
  check(2);
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
