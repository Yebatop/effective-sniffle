/**
 * Снятие главы со страницы. Один код для браузера (кнопка на сайте, файлы
 * в приложении) и сервера (linkedom). Функции принимают Document и не
 * обращаются к window/глобалам — кроме markHiddenLive, которой нужен
 * живой DOM с раскладкой (doc.defaultView.getComputedStyle).
 *
 * Результат — абзацы по блочным элементам Readability `article.content`,
 * а не textContent (тот склеивает <p> на минифицированном HTML).
 *
 * Файл попадает в кнопку на сайтах (esbuild, es2019, старый Chromium в Kiwi):
 * без replaceAll, at, structuredClone, Object.hasOwn.
 */

import { Readability } from "@mozilla/readability";
import type { ExtractedChapter } from "../types";
import {
  SCENE_BREAK,
  cleanLine,
  countWords,
  countWordsAll,
  isAdLine,
  isNavLine,
  looksLikeChapterTitle,
  withoutBookName,
} from "./clean";
import { looksLocked, stripCredits, tidySeparators } from "./text";

export interface ExtractOptions {
  /** Адрес страницы — для относительных ссылок «дальше» и ключа книги. */
  url: string | null;
}

/** Пометка невидимого элемента; extractFromDocument выбрасывает помеченное. */
export const HIDDEN_ATTR = "data-tolmach-hidden";
/** Документ уже размечен по живой раскладке — правила <style> не нужны. */
const LIVE_ATTR = "data-tolmach-live";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Главное: Document → глава. Не меняет переданный документ (работает с клоном). */
export function extractFromDocument(doc: Document, opts: ExtractOptions): ExtractedChapter {
  const work = doc.cloneNode(true) as Document;
  const root = work.documentElement;
  // Живая страница уже размечена по настоящей раскладке; правила из <style>
  // поверх неё только навредят (блок, показанный скриптом, в CSS скрыт).
  if (root && !root.hasAttribute(LIVE_ATTR)) markHiddenByStyles(work);
  removeMarked(work);

  const base = pageBase(doc, opts.url);
  const siteName = metaContent(work, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const headings = headingCandidates(work);
  const bookTitle = guessBookTitle(work, base, siteName, headings);
  const coverUrl = findCover(work, base);
  const nextUrl = findNextLink(doc, base);
  const prevUrl = findPrevLink(doc, base);
  const density = linkDensity(work);
  const pageText = work.body ? textOf(work.body).slice(0, 50000) : "";
  const chapterLinks = countChapterLinks(work);

  // Запасной способ читает документ, Readability его портит — порядок важен.
  const dense = byParagraphDensity(work);
  const read = byReadability(work);
  const best = pickExtraction(read, dense);

  let paragraphs = best ? best.paragraphs.slice() : [];
  paragraphs = paragraphs.filter((p) => !isAdLine(p));
  paragraphs = trimNavEdges(paragraphs);

  // Название: заголовок у текста, похожий на главу → первая строка текста
  // вида «Chapter 12» → заголовок документа без имени книги и сайта.
  const hostName = base ? safeHost(base) : null;
  const names = [bookTitle, siteName, hostName];
  let title = "";
  for (const h of headings) {
    if (looksLikeChapterTitle(h)) {
      title = h;
      break;
    }
  }
  if (!title && paragraphs.length > 1 && looksLikeChapterTitle(paragraphs[0]) && countWords(paragraphs[0]) <= 20) {
    title = paragraphs[0];
  }
  if (!title) {
    const docTitle = stripTitleParts((read && read.title) || work.title || "", names);
    const near = headings.find((h) => h.length >= 3 && docTitle.toLowerCase().indexOf(h.toLowerCase()) >= 0);
    title = near || docTitle || headings[0] || "";
  }
  const shortTitle = withoutBookName(title, [bookTitle]);
  if (shortTitle) title = shortTitle;
  title = cleanLine(title).replace(/\n/g, " ");

  paragraphs = dropTitleEcho(paragraphs, [title, bookTitle]);
  paragraphs = tidySeparators(stripCredits(paragraphs));
  const words = countWordsAll(paragraphs);
  const share = best ? best.linkShare : 0;

  return {
    url: opts.url,
    bookTitle,
    chapterTitle: title,
    paragraphs,
    nextUrl,
    prevUrl,
    coverUrl,
    words,
    looksLocked: looksLocked(paragraphs, pageText),
    looksLikeIndex: share > 0.5 || (density > 0.5 && words < 500) || (words < 200 && chapterLinks >= 10),
  };
}

// ── Два способа и выбор между ними ──────────────────────────────────────

export interface Extraction {
  method: "readability" | "density";
  paragraphs: string[];
  words: number;
  /** Доля текста результата, лежавшая в ссылках: у оглавления близка к 1. */
  linkShare: number;
  title?: string | null;
}

/**
 * Одно правило везде: Readability точнее в границах и заголовке, поэтому
 * побеждает — если только не потеряла явно много текста (меньше 60% от того,
 * что нашёл запасной способ).
 */
export function pickExtraction(read: Extraction | null, dense: Extraction | null): Extraction | null {
  if (!read || read.words === 0) return dense && dense.words > 0 ? dense : read;
  if (!dense) return read;
  return read.words < 0.6 * dense.words ? dense : read;
}

function byReadability(work: Document): Extraction | null {
  let article: ReturnType<Readability<Node>["parse"]> = null;
  try {
    article = new Readability<Node>(work, { serializer: (node: Node) => node }).parse();
  } catch {
    return null;
  }
  const content = article && article.content;
  if (!content || content.nodeType !== ELEMENT_NODE) return null;
  const el = content as Element;
  const paragraphs = blocksFrom(el);
  return {
    method: "readability",
    paragraphs,
    words: countWordsAll(paragraphs),
    linkShare: linkShareOf(el),
    title: article ? article.title : null,
  };
}

/**
 * Запасной способ (exttran:src/extract.ts byParagraphDensity): контейнер,
 * в прямых абзацах которого больше всего текста. Меню и сайдбары проигрывают —
 * они из ссылок, а не из абзацев.
 */
function byParagraphDensity(work: Document): Extraction | null {
  let bestNode: Element | null = null;
  let bestLength = 0;
  const candidates = work.querySelectorAll("article, main, section, div, td");
  for (let i = 0; i < candidates.length; i++) {
    const node = candidates[i];
    let count = 0;
    let length = 0;
    for (let j = 0; j < node.children.length; j++) {
      const c = node.children[j];
      if (c.tagName.toLowerCase() !== "p") continue;
      count++;
      length += (c.textContent || "").trim().length;
    }
    if (count >= 3 && length > bestLength) {
      bestLength = length;
      bestNode = node;
    }
  }
  if (!bestNode || bestLength < 400) return null;

  const out: string[] = [];
  for (let j = 0; j < bestNode.children.length; j++) {
    const c = bestNode.children[j];
    if (c.hasAttribute(HIDDEN_ATTR)) continue;
    const tag = c.tagName.toLowerCase();
    if (tag === "hr") out.push(SCENE_BREAK);
    else if (DENSITY_TAGS[tag]) walk(c, out);
  }
  return { method: "density", paragraphs: out, words: countWordsAll(out), linkShare: linkShareOf(bestNode) };
}

const DENSITY_TAGS: Record<string, boolean> = {
  p: true,
  blockquote: true,
  pre: true,
  ul: true,
  ol: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  table: true,
};

// ── Абзацы из разметки ──────────────────────────────────────────────────

const BLOCK_TAGS: Record<string, boolean> = {};
for (const t of "address article aside blockquote center dd details dialog dir div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main menu nav ol p pre section summary table tbody tfoot thead tr td th caption ul".split(" ")) {
  BLOCK_TAGS[t] = true;
}
/** Блоки, которые сами по себе абзац (если внутри нет других блоков). */
const LEAF_TAGS: Record<string, boolean> = {};
for (const t of "p li blockquote pre h1 h2 h3 h4 h5 h6 dd dt figcaption summary caption td th".split(" ")) LEAF_TAGS[t] = true;
/** Не текст главы ни при каких условиях. */
const SKIP_TAGS: Record<string, boolean> = {};
for (const t of "script style noscript template svg math button form input select option textarea iframe object embed canvas video audio img picture source head link meta nav".split(" ")) {
  SKIP_TAGS[t] = true;
}
const BLOCK_SELECTOR = "address,article,aside,blockquote,center,dd,details,div,dl,dt,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,ol,p,pre,section,table,tr,ul";

/** Абзацы контейнера по порядку: p, li, blockquote, pre, h2–h6, строки таблиц, текст между <br><br>. */
export function blocksFrom(root: Element): string[] {
  const out: string[] = [];
  walk(root, out);
  return out.filter((p) => p !== "");
}

function walk(el: Element, out: string[]): void {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS[tag] || el.hasAttribute(HIDDEN_ATTR)) return;
  if (tag === "tr") {
    pushRow(el, out);
    return;
  }
  if (tag === "pre") {
    pushText(out, (el.textContent || "").replace(/\r\n?/g, "\n"), true);
    return;
  }
  if (LEAF_TAGS[tag] && !el.querySelector(BLOCK_SELECTOR)) {
    pushText(out, inlineText(el.childNodes), false);
    return;
  }
  // Смешанное содержимое: текст и строчные элементы между блоками копятся и
  // сбрасываются абзацем при встрече блока.
  let inline: Node[] = [];
  const flush = () => {
    if (inline.length > 0) pushText(out, inlineText(inline), false);
    inline = [];
  };
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.nodeType === TEXT_NODE) {
      inline.push(child);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const e = child as Element;
    const t = e.tagName.toLowerCase();
    if (SKIP_TAGS[t] || e.hasAttribute(HIDDEN_ATTR)) continue;
    if (t === "br") {
      inline.push(e);
      continue;
    }
    if (t === "hr") {
      flush();
      out.push(SCENE_BREAK);
      continue;
    }
    if (!BLOCK_TAGS[t] && !e.querySelector(BLOCK_SELECTOR)) {
      inline.push(e);
      continue;
    }
    flush();
    walk(e, out);
  }
  flush();
}

/** Текст строчного содержимого: пробелы схлопнуты, <br> → перевод строки. */
function inlineText(nodes: ArrayLike<Node>): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      parts.push((node.nodeValue || "").replace(/[ \t\r\n\f]+/g, " "));
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const e = node as Element;
    const t = e.tagName.toLowerCase();
    if (t === "br") {
      parts.push("\n");
      return;
    }
    if (SKIP_TAGS[t] || e.hasAttribute(HIDDEN_ATTR)) return;
    const kids = e.childNodes;
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  for (let i = 0; i < nodes.length; i++) visit(nodes[i]);
  return parts.join("");
}

/**
 * Положить текст блока: двойной <br> — граница абзацев. Одиночный <br>
 * остаётся переводом строки внутри абзаца, кроме случая «вся глава в одном
 * <p> через <br>»: много длинных строк подряд — это абзацы.
 */
function pushText(out: string[], text: string, pre: boolean): void {
  const chunks = pre ? [text] : text.split(/\n[ \t]*\n/);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;
    let total = 0;
    for (const l of lines) total += l.length;
    if (!pre && lines.length >= 4 && total / lines.length >= 80) {
      for (const l of lines) {
        const c = cleanLine(l);
        if (c) out.push(c);
      }
    } else {
      const c = cleanLine(lines.join("\n"));
      if (c) out.push(c);
    }
  }
}

/** Строка таблицы (окна статуса в LitRPG) — один абзац, ячейки через « | ». */
function pushRow(tr: Element, out: string[]): void {
  const cells: string[] = [];
  for (let i = 0; i < tr.children.length; i++) {
    const c = tr.children[i];
    const t = c.tagName.toLowerCase();
    if ((t !== "td" && t !== "th") || c.hasAttribute(HIDDEN_ATTR)) continue;
    const text = cleanLine(inlineText(c.childNodes)).replace(/\n/g, " ");
    if (text) cells.push(text);
  }
  if (cells.length > 0) out.push(cells.join(" | "));
}

/** Доля текста элемента внутри ссылок. */
function linkShareOf(el: Element): number {
  const all = squash(textOf(el)).length;
  if (all === 0) return 0;
  let inLinks = 0;
  const anchors = el.querySelectorAll("a");
  for (let i = 0; i < anchors.length; i++) inLinks += squash(anchors[i].textContent || "").length;
  return Math.min(1, inLinks / all);
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Текст узла без скриптов и стилей (у linkedom textContent включает их). */
function textOf(node: Node): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.nodeType === TEXT_NODE) {
      parts.push(n.nodeValue || "");
      return;
    }
    if (n.nodeType !== ELEMENT_NODE) return;
    const t = (n as Element).tagName.toLowerCase();
    if (t === "script" || t === "style" || t === "noscript" || t === "template") return;
    if (BLOCK_TAGS[t] || t === "br") parts.push("\n");
    const kids = n.childNodes;
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(node);
  return parts.join("");
}

/** Строки навигации по краям текста («Previous Chapter | Next Chapter»). */
function trimNavEdges(paragraphs: string[]): string[] {
  let start = 0;
  let end = paragraphs.length;
  while (start < end && start < 5 && isNavLine(paragraphs[start])) start++;
  while (end > start && paragraphs.length - end < 5 && isNavLine(paragraphs[end - 1])) end--;
  return paragraphs.slice(start, end);
}

/** Первые строки текста, повторяющие название главы или книги, — убрать. */
function dropTitleEcho(paragraphs: string[], titles: Array<string | null>): string[] {
  const keys = titles.filter((t): t is string => !!t).map(titleKey).filter((k) => k !== "");
  let start = 0;
  while (start < paragraphs.length && start < 3) {
    const p = paragraphs[start];
    if (p.length > 200) break;
    const k = titleKey(p);
    if (k === "" || keys.indexOf(k) < 0) break;
    start++;
  }
  return paragraphs.slice(start);
}

function titleKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ── Название, книга, обложка ────────────────────────────────────────────

/** Заголовки страницы, которые могут быть названием главы: h1 раньше h2 и т. д. */
function headingCandidates(work: Document): string[] {
  const out: string[] = [];
  const selectors = [
    "h1",
    '[class*="chapter-title"], [class*="chapter_title"], [class*="chapterTitle"], [id*="chapter-title"], [class*="chapter-name"]',
    "h2",
    "h3",
    "h4",
  ];
  for (const sel of selectors) {
    const nodes = work.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.closest('nav, footer, aside, a, [class*="comment"], [id*="comment"], [class*="sidebar"], [id*="sidebar"]')) continue;
      const text = cleanLine(el.textContent || "").replace(/\n/g, " ");
      if (text && text.length <= 150 && out.indexOf(text) < 0) out.push(text);
    }
  }
  return out;
}

/** «Chapter 5 - Book | Site» → без частей, совпадающих с книгой и сайтом. */
function stripTitleParts(title: string, names: Array<string | null>): string {
  const clean = squash(title);
  const parts = clean.split(/\s+[|·•–—-]\s+/);
  if (parts.length > 1) {
    const kept = parts.filter((p) => !names.some((n) => !!n && sameName(p, n)));
    if (kept.length > 0 && kept.length < parts.length) return kept.join(" - ");
  }
  return withoutBookName(clean, names);
}

/** Одно и то же имя с точностью до регистра и знаков: «Royal Road» ~ «royalroad.com». */
function sameName(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Имя сайта внутри хоста: «royalroad» в «royalroadcom».
  return ka.length >= 4 && kb.indexOf(ka) === 0 && kb.length - ka.length <= 4;
}

/**
 * Имя книги — дёшево и по возможности: хлебные крошки → ссылка на страницу
 * книги (её путь — начало пути главы) → части заголовка документа.
 */
function guessBookTitle(work: Document, base: string | null, siteName: string | null, headings: string[]): string | null {
  const host = base ? safeHost(base) : null;
  const isJunk = (text: string): boolean => {
    if (!text || text.length < 2 || text.length > 150) return true;
    if (isNavLine(text) || looksLikeChapterTitle(text)) return true;
    if (/^(home|главная|novels?|library|books?|series|fictions?|browse|библиотека|каталог)$/i.test(text)) return true;
    if (siteName && sameName(text, siteName)) return true;
    if (host && sameName(text, host)) return true;
    return false;
  };

  // 1. Хлебные крошки.
  const crumbs = work.querySelectorAll('[class*="breadcrumb"] a, [aria-label*="readcrumb"] a, [id*="breadcrumb"] a');
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const text = squash(crumbs[i].textContent || "");
    if (!isJunk(text)) return text;
  }

  // 2. Ссылка на страницу книги: её путь — начало пути главы.
  if (base) {
    let here: URL | null = null;
    try {
      here = new URL(base);
    } catch {
      here = null;
    }
    if (here) {
      const herePath = here.pathname.replace(/\/+$/, "");
      let best: { depth: number; text: string } | null = null;
      const anchors = work.querySelectorAll("a[href]");
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        let u: URL;
        try {
          u = new URL(a.getAttribute("href") || "", here);
        } catch {
          continue;
        }
        if (stripWww(u.hostname) !== stripWww(here.hostname)) continue;
        const path = u.pathname.replace(/\/+$/, "");
        if (!path || path === herePath || herePath.indexOf(path + "/") !== 0) continue;
        const depth = path.split("/").length;
        if (depth < 2) continue;
        const text = squash(a.textContent || a.getAttribute("title") || "");
        if (isJunk(text)) continue;
        if (!best || depth > best.depth) best = { depth, text };
      }
      if (best) return best.text;
    }
  }

  // 3. Части заголовка: «Chapter 3: Fall - Book | Site». Часть, которая
  // целиком сидит в заголовке главы на странице, — это название главы.
  const chapterHeads = headings.filter(looksLikeChapterTitle).map((h) => h.toLowerCase());
  const raw = metaContent(work, ['meta[property="og:title"]']) || work.title || "";
  const parts = squash(raw).split(/\s+[|·•–—-]\s+/);
  if (parts.length >= 2) {
    const rest = parts.filter((p) => !isJunk(p) && !chapterHeads.some((h) => h.indexOf(p.toLowerCase()) >= 0));
    if (rest.length === 1) return rest[0];
  }
  return null;
}

/** Обложка: картинка превью (og:image) — её сайт сам отдаёт наружу. */
function findCover(work: Document, base: string | null): string | null {
  const selectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]',
  ];
  for (const sel of selectors) {
    const node = work.querySelector(sel);
    const raw = node ? node.getAttribute("content") || node.getAttribute("href") : null;
    const found = absoluteHttp(raw, base);
    if (found) return found;
  }
  return null;
}

function metaContent(work: Document, selectors: string[]): string | null {
  for (const sel of selectors) {
    const node = work.querySelector(sel);
    const v = node ? squash(node.getAttribute("content") || "") : "";
    if (v) return v;
  }
  return null;
}

/** Адрес целиком и только http(s), чтобы не подсунуть javascript:. */
function absoluteHttp(raw: string | null | undefined, base: string | null): string | null {
  if (!raw) return null;
  try {
    const u = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** База для относительных ссылок: адрес страницы → canonical → og:url. */
function pageBase(doc: Document, url: string | null): string | null {
  const candidates: Array<string | null> = [url];
  const canonical = doc.querySelector('link[rel="canonical"]');
  candidates.push(canonical ? canonical.getAttribute("href") : null);
  const og = doc.querySelector('meta[property="og:url"]');
  candidates.push(og ? og.getAttribute("content") : null);
  for (const c of candidates) {
    const abs = absoluteHttp(c, null);
    if (abs) return abs;
  }
  return null;
}

function safeHost(url: string): string | null {
  try {
    return stripWww(new URL(url).hostname);
  } catch {
    return null;
  }
}

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function countChapterLinks(work: Document): number {
  let n = 0;
  const anchors = work.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const text = squash(a.textContent || "");
    const href = a.getAttribute("href") || "";
    if (looksLikeChapterTitle(text) || /chapter|\/ch[-_]?\d|glava|episode/i.test(href)) n++;
  }
  return n;
}

// ── Невидимое ───────────────────────────────────────────────────────────

/**
 * Живая страница в браузере: пометить невидимые элементы (display:none,
 * visibility:hidden, нулевые размеры, offsetParent === null у видимых
 * типов) атрибутом data-tolmach-hidden. extractFromDocument выбрасывает
 * помеченное. Так отсекаются скрытые «водяные знаки» Royal Road.
 */
export function markHiddenLive(doc: Document): number {
  const view = doc.defaultView;
  if (!view || !doc.body || !doc.documentElement) return 0;
  doc.documentElement.setAttribute(LIVE_ATTR, "1");
  // Старые пометки с прошлого нажатия: читатель мог с тех пор открыть
  // спойлер или сайт показал блок. Свой интерфейс кнопки помечен навсегда.
  const stale = doc.querySelectorAll("[" + HIDDEN_ATTR + "]");
  for (let i = 0; i < stale.length; i++) {
    if (!stale[i].hasAttribute("data-tolmach-ui")) stale[i].removeAttribute(HIDDEN_ATTR);
  }
  let count = 0;
  const scrollX = view.pageXOffset || 0;
  const scrollY = view.pageYOffset || 0;

  const visit = (el: Element) => {
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;
      // Спойлер скрыт до нажатия, но это часть главы (окна статуса и т. п.).
      if (isSpoiler(child)) continue;
      if (child.hasAttribute(HIDDEN_ATTR)) continue;
      if (liveHidden(child, view, scrollX, scrollY)) {
        child.setAttribute(HIDDEN_ATTR, "1");
        count++;
        continue;
      }
      visit(child);
    }
  };
  visit(doc.body);
  return count;
}

function liveHidden(el: Element, view: Window, scrollX: number, scrollY: number): boolean {
  let cs: CSSStyleDeclaration;
  try {
    cs = view.getComputedStyle(el);
  } catch {
    return false;
  }
  if (!cs) return false;
  if (cs.display === "none") return true;
  if (cs.visibility === "hidden" || cs.visibility === "collapse") return true;
  if (cs.getPropertyValue("content-visibility") === "hidden") return true;
  // font-size:0 у контейнера — частый приём вёрстки (дети задают свой размер),
  // поэтому скрытым считаем, только если у самого элемента есть свой текст.
  if (parseFloat(cs.fontSize) === 0 && hasOwnText(el)) return true;

  const h = el as HTMLElement;
  const position = cs.position;
  if ("offsetParent" in h && position !== "fixed" && position !== "sticky") {
    if (h.offsetParent === null && !el.closest("details")) return true;
  }
  if ("offsetHeight" in h && h.offsetHeight === 0 && cs.overflow === "hidden" && hasAnyText(el)) return true;
  if (position === "absolute" || position === "fixed") {
    if (/rect\(\s*(?:0|1)px,?\s*(?:0|1)px,?\s*(?:0|1)px,?\s*(?:0|1)px\s*\)/.test(cs.clip || "")) return true;
    const r = el.getBoundingClientRect();
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return true;
  }
  return false;
}

function hasOwnText(el: Element): boolean {
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === TEXT_NODE && (kids[i].nodeValue || "").trim() !== "") return true;
  }
  return false;
}

function hasAnyText(el: Element): boolean {
  return (el.textContent || "").trim() !== "";
}

function isSpoiler(el: Element): boolean {
  return /spoiler/i.test((el.getAttribute("class") || "") + " " + (el.id || ""));
}

/**
 * Документ без раскладки (DOMParser, linkedom): найти в <style> правила с
 * display:none / visibility:hidden и пометить подходящие элементы
 * data-tolmach-hidden. Плюс инлайн-стили и атрибут hidden.
 *
 * CSS разбирается из текста <style>, а не через CSSOM — у linkedom его толком
 * нет. Каскад не считается: правило, которое потом перекрыто, всё равно
 * прячет. Поэтому большие блоки (> ~2000 знаков) по правилам не прячем —
 * это скорее содержимое, которое показывает скрипт, чем водяной знак.
 */
export function markHiddenByStyles(doc: Document): number {
  let count = 0;
  const mark = (el: Element) => {
    if (markStatic(el)) count++;
  };

  const styles = doc.querySelectorAll("style");
  const selectors: string[] = [];
  for (let i = 0; i < styles.length; i++) collectHidingSelectors(styles[i].textContent || "", selectors);
  for (const sel of selectors) {
    let found: NodeListOf<Element>;
    try {
      found = doc.querySelectorAll(sel);
    } catch {
      continue; // селектор, который движок не понимает, — пропустить
    }
    for (let i = 0; i < found.length; i++) mark(found[i]);
  }

  const inline = doc.querySelectorAll("[style]");
  for (let i = 0; i < inline.length; i++) {
    if (hidesByDeclarations(inline[i].getAttribute("style") || "")) mark(inline[i]);
  }

  const flagged = doc.querySelectorAll('[hidden], [aria-hidden="true"]');
  for (let i = 0; i < flagged.length; i++) {
    const el = flagged[i];
    if (el.hasAttribute("hidden") || hasAnyText(el)) mark(el);
  }
  return count;
}

const BIG_HIDDEN_TEXT = 2000;

function markStatic(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "head" || tag === "body") return false;
  if (el.hasAttribute(HIDDEN_ATTR)) return false;
  if (isSpoiler(el) || el.closest('[class*="spoiler"]')) return false;
  if ((el.textContent || "").length > BIG_HIDDEN_TEXT) return false;
  el.setAttribute(HIDDEN_ATTR, "1");
  return true;
}

/** Селекторы правил, которые прячут элемент. Вложенные @media — только для экрана без условий. */
export function collectHidingSelectors(css: string, out: string[]): void {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let prelude = text.slice(i, open);
    // @charset/@import без блока стоят перед правилом через «;».
    const semi = prelude.lastIndexOf(";");
    if (semi >= 0) prelude = prelude.slice(semi + 1);
    prelude = prelude.trim();
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      const ch = text.charAt(j);
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    const inner = text.slice(open + 1, depth === 0 ? j - 1 : j);
    if (prelude.charAt(0) === "@") {
      const unconditional =
        /^@(?:supports|layer|-moz-document|document)\b/i.test(prelude) ||
        (/^@media\b/i.test(prelude) && prelude.indexOf("(") < 0 && /\b(?:all|screen)\b/i.test(prelude) && !/\bnot\b/i.test(prelude));
      if (unconditional) collectHidingSelectors(inner, out);
    } else if (prelude && hidesByDeclarations(inner)) {
      for (const sel of splitSelectors(prelude)) {
        if (usableSelector(sel)) out.push(sel);
      }
    }
    i = j;
  }
}

/** Объявления прячут элемент: display:none, visibility:hidden, font-size:0, height:0 + overflow:hidden … */
export function hidesByDeclarations(block: string): boolean {
  const decl: Record<string, string> = {};
  for (const part of block.split(";")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
    if (prop) decl[prop] = value;
  }
  if (decl["display"] === "none") return true;
  if (decl["visibility"] === "hidden" || decl["visibility"] === "collapse") return true;
  if (decl["content-visibility"] === "hidden") return true;
  if (decl["font-size"] !== undefined && isZeroLength(decl["font-size"])) return true;
  const overflowHidden = decl["overflow"] === "hidden" || decl["overflow-y"] === "hidden";
  if (overflowHidden && ((decl["height"] !== undefined && isZeroLength(decl["height"])) || (decl["max-height"] !== undefined && isZeroLength(decl["max-height"])))) {
    return true;
  }
  const positioned = decl["position"] === "absolute" || decl["position"] === "fixed";
  if (positioned && /rect\(\s*(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?\s*\)/.test(decl["clip"] || "")) {
    return true;
  }
  if (decl["clip-path"] && /inset\(\s*50%\s*\)/.test(decl["clip-path"])) return true;
  if (positioned && (farNegative(decl["left"]) || farNegative(decl["top"]))) return true;
  if (farNegative(decl["text-indent"]) && overflowHidden) return true;
  return false;
}

function isZeroLength(v: string): boolean {
  return /^0*(?:\.0+)?(?:px|em|rem|pt|%|vh|vw)?$/.test(v.trim()) && /^0/.test(v.trim());
}

function farNegative(v: string | undefined): boolean {
  if (!v) return false;
  const m = v.match(/^-(\d+(?:\.\d+)?)(px|em|rem)?$/);
  if (!m) return false;
  const n = parseFloat(m[1]) * (m[2] === "em" || m[2] === "rem" ? 16 : 1);
  return n >= 999;
}

/** Список селекторов через запятую — с учётом скобок :not(a, b) и [attr="a,b"]. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude.charAt(i);
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Состояния (:hover), псевдоэлементы (::before) и корень документа — мимо. */
function usableSelector(sel: string): boolean {
  if (!sel) return false;
  if (sel.indexOf("::") >= 0) return false;
  if (/:(?:before|after|hover|focus|focus-within|focus-visible|active|visited|link|target|checked|placeholder|selection|first-letter|first-line|-webkit-|-moz-|-ms-)/i.test(sel)) return false;
  if (/^(?:html|body|:root|\*|head)$/i.test(sel.trim())) return false;
  return true;
}

function removeMarked(work: Document): void {
  const marked = work.querySelectorAll("[" + HIDDEN_ATTR + "]");
  for (let i = 0; i < marked.length; i++) {
    const el = marked[i];
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}

// ── Ссылки «дальше» и «назад» ───────────────────────────────────────────

type Direction = "next" | "prev";

const NEXT_WORDS =
  /^(?:next|next chapter|next part|next page|next episode|next ch|next chap|следующая|следующая глава|следующая страница|далее|дальше|вперёд|вперед)$/;
const PREV_WORDS =
  /^(?:prev|previous|prev chapter|previous chapter|previous part|previous page|previous episode|prev ch|prev chap|back|предыдущая|предыдущая глава|предыдущая страница|назад)$/;
const NEXT_START = /^(?:next chapter|следующая глава)\b/;
const PREV_START = /^(?:previous chapter|prev chapter|предыдущая глава)\b/;
const NEXT_SYMBOL = /^(?:»|›|→|>>|>|⟶|⇒|▶|►|❯)$/;
const PREV_SYMBOL = /^(?:«|‹|←|<<|<|⟵|⇐|◀|◄|❮)$/;

/** Ссылка на следующую главу: rel=next → класс/id «next» → текст ссылки; «назад» отсеивается; якоря отрезаются. */
export function findNextLink(doc: Document, url: string | null): string | null {
  return findLink(doc, url, "next");
}
export function findPrevLink(doc: Document, url: string | null): string | null {
  return findLink(doc, url, "prev");
}

function findLink(doc: Document, url: string | null, dir: Direction): string | null {
  const base = pageBase(doc, url);
  const resolve = (href: string | null) => resolveSameSite(href, base);
  const other: Direction = dir === "next" ? "prev" : "next";

  // 1. Разметка, сделанная ровно для этого.
  const relSel = dir === "next" ? 'link[rel~="next"], a[rel~="next"]' : 'link[rel~="prev"], a[rel~="prev"], link[rel~="previous"], a[rel~="previous"]';
  const rels = doc.querySelectorAll(relSel);
  for (let i = 0; i < rels.length; i++) {
    const u = resolve(rels[i].getAttribute("href"));
    if (u) return u;
  }

  const anchors: Element[] = [];
  const all = doc.querySelectorAll("a[href]");
  for (let i = 0; i < all.length; i++) {
    if (!all[i].closest('[class*="comment"], [id*="comment"]')) anchors.push(all[i]);
  }

  // 2. Класс или id ссылки (или её обёртки) — но не у ссылки в обратную сторону.
  for (const a of anchors) {
    if (!hasDirectionMark(a, dir) || hasDirectionMark(a, other) || textDirection(a) === other) continue;
    const u = resolve(a.getAttribute("href"));
    if (u) return u;
  }

  // 3. Текст самой ссылки.
  for (const a of anchors) {
    if (textDirection(a) !== dir) continue;
    const u = resolve(a.getAttribute("href"));
    if (u) return u;
  }
  return null;
}

function hasDirectionMark(a: Element, dir: Direction): boolean {
  const words = dir === "next" ? /^next|next$|[-_]next[-_]?/ : /^prev|prev$|[-_]prev|previous/;
  const els: Array<Element | null> = [a, a.parentElement];
  for (const el of els) {
    if (!el) continue;
    const marks = ((el.getAttribute("class") || "") + " " + (el.getAttribute("id") || "")).toLowerCase();
    for (const token of marks.split(/\s+/)) {
      if (token && words.test(token)) return true;
    }
  }
  return false;
}

/** Куда ведёт ссылка по её тексту (или aria-label/title у ссылки-значка). */
function textDirection(a: Element): Direction | null {
  const raw = squash(a.textContent || "") || squash(a.getAttribute("aria-label") || "") || squash(a.getAttribute("title") || "");
  if (!raw || raw.length > 80) return null;
  if (NEXT_SYMBOL.test(raw)) return "next";
  if (PREV_SYMBOL.test(raw)) return "prev";
  const t = raw
    .toLowerCase()
    .replace(/[«»‹›←→⟵⟶⇐⇒<>◀▶◄►❮❯|:.!\s]+$/g, "")
    .replace(/^[«»‹›←→⟵⟶⇐⇒<>◀▶◄►❮❯|:.!\s]+/g, "")
    .replace(/\s+/g, " ");
  if (PREV_WORDS.test(t) || PREV_START.test(t)) return "prev";
  if (NEXT_WORDS.test(t) || NEXT_START.test(t)) return "next";
  return null;
}

/** Абсолютный адрес того же сайта без якоря; ссылка на саму страницу — null. */
function resolveSameSite(href: string | null, base: string | null): string | null {
  if (!href) return null;
  const h = href.trim();
  if (h === "" || h.charAt(0) === "#" || /^(?:javascript|mailto|tel|data):/i.test(h)) return null;
  let u: URL;
  try {
    u = base ? new URL(h, base) : new URL(h);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if (base) {
    const b = new URL(base);
    if (stripWww(u.hostname) !== stripWww(b.hostname)) return null;
    if (u.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "") && u.search === b.search) return null;
  }
  return u.toString();
}

/**
 * Следующая глава по оглавлению книги — запасной путь к findNextLink
 * (exttran:src/extract.ts nextFromIndex). Ссылки внутрь книги по порядку;
 * если текущей среди них нет — честно null, а не догадка.
 */
export function nextFromIndex(indexDoc: Document, indexUrl: string, currentUrl: string): string | null {
  let here: URL;
  let index: URL;
  try {
    here = new URL(currentUrl);
    index = new URL(indexUrl);
  } catch {
    return null;
  }
  const bookPath = index.pathname.replace(/\/+$/, "");
  const chapters: string[] = [];
  const anchors = indexDoc.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length; i++) {
    let u: URL;
    try {
      u = new URL(anchors[i].getAttribute("href") || "", index);
    } catch {
      continue;
    }
    u.hash = "";
    u.search = "";
    if (stripWww(u.hostname) !== stripWww(here.hostname)) continue;
    if (u.pathname.indexOf(bookPath + "/") !== 0) continue;
    const link = u.toString();
    if (chapters.indexOf(link) < 0) chapters.push(link);
  }
  const current = (here.origin + here.pathname).replace(/\/+$/, "");
  const at = chapters.findIndex((l) => l.replace(/\/+$/, "").replace(/^https?:\/\/(?:www\.)?/, "") === current.replace(/^https?:\/\/(?:www\.)?/, ""));
  if (at < 0 || at + 1 >= chapters.length) return null;
  return chapters[at + 1];
}

/** Доля текста в ссылках (оглавление ≈ 1, глава ≈ 0). */
export function linkDensity(doc: Document): number {
  return doc.body ? linkShareOf(doc.body) : 0;
}
