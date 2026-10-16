/**
 * Вставленный текст и «Поделиться» текстом: превратить в абзацы, угадать
 * название, срезать меню/комментарии по якорям (Previous/Next Chapter,
 * Comments, Report, Advertisement …), подвалы переводчиков по краям.
 */

import type { ExtractedChapter } from "../types";
import {
  SCENE_BREAK,
  cleanLine,
  countWords,
  countWordsAll,
  isAdLine,
  isNavLine,
  isSeparator,
  looksLikeChapterTitle,
} from "./clean";

export function chapterFromPastedText(text: string, opts?: { url?: string | null; bookTitle?: string | null }): ExtractedChapter {
  let paragraphs = splitParagraphs(text);

  // Одиночные «Advertisement» посреди текста — это место под рекламу, а не
  // строка главы; убирать можно где угодно, совпадение строгое.
  paragraphs = paragraphs.filter((p) => !isAdLine(p));

  // Название ищем до обрезки меню: на многих сайтах оно стоит над
  // «Previous | Next», и срез верхнего меню иначе унёс бы его с собой.
  const head = Math.min(paragraphs.length, HEAD_SCAN);
  let title = "";
  let titleAt = -1;
  for (let i = 0; i < head; i++) {
    if (looksLikeChapterTitle(paragraphs[i]) && countWords(paragraphs[i]) <= 20) {
      title = paragraphs[i];
      titleAt = i;
      break;
    }
  }

  const top = topCut(paragraphs);
  const bottom = bottomCut(paragraphs, top);
  let body = paragraphs.slice(top, bottom);
  if (titleAt >= top && titleAt < bottom) body.splice(titleAt - top, 1);

  body = stripCredits(body);

  if (!title && body.length > 1 && looksLikeLooseTitle(body[0])) {
    title = body[0];
    body = body.slice(1);
  }

  body = tidySeparators(body);
  const words = countWordsAll(body);
  return {
    url: opts?.url ?? null,
    bookTitle: opts?.bookTitle ?? null,
    chapterTitle: title,
    paragraphs: body,
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words,
    looksLocked: looksLocked(body, text),
    looksLikeIndex: looksLikeChapterList(body),
  };
}

/** Сколько первых абзацев просматривать в поисках названия и верхнего меню. */
const HEAD_SCAN = 15;

/**
 * Где кончается глава: первые комментарии, «Report chapter», просьба о Patreon,
 * строка навигации. Строки строгие — целиком, а не «содержит».
 */
const TAIL_LINE =
  /^(?:comments?(?:\s*\(\d+\))?|\d+\s+comments?|leave\s+a\s+(?:comment|reply)|post\s+a\s+comment|log\s*in\s+to\s+(?:comment|reply)|report(?:\s+(?:chapter|this\s+chapter|error|an?\s+error))?|rate\s+this\s+chapter|advertisement|sponsored\s+content|support\s+(?:me|us|the\s+author|the\s+translator)\b.{0,60}(?:patreon|ko-?fi)|you\s+may\s+also\s+like|комментарии(?:\s*\(\d+\))?|оставить\s+комментарий|пожаловаться)\s*[:.]?$/i;

function isTailLine(p: string): boolean {
  return p.length <= 120 && (isNavLine(p) || TAIL_LINE.test(p));
}

/**
 * Разбить вставку на абзацы: по пустым строкам; если пустых строк нет, а строк
 * много — каждая строка абзац. Жёсткие переносы внутри абзаца (текст из почты,
 * PDF) склеиваются, переносы перед репликой или после конца фразы — остаются.
 */
function splitParagraphs(text: string): string[] {
  const norm = text
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ /g, " ");
  const lines = norm.split("\n").map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l !== "").length;
  let blankRuns = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "" && lines[i - 1] !== "") blankRuns++;

  // Пустые строки считаются границами абзацев, только если они встречаются
  // регулярно. Одна-две пустых строки на весь текст — это отбивка после
  // названия или разрыв сцены, а абзацы тогда разделены просто переводом строки.
  const byBlank = blankRuns >= 2 && blankRuns >= nonEmpty / 8;

  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    // Шапка сайта или хвост с комментариями часто идут одним куском без
    // пустых строк; если в куске есть служебная строка — каждая строка сама по себе.
    const structural = block.length > 1 && block.some(isStructuralLine);
    let para = "";
    let prev = "";
    for (const line of block) {
      if (para === "") para = line;
      else if (!structural && softWrap(prev, line)) para += " " + line;
      else if (byBlank && !structural) para += "\n" + line;
      else {
        push(out, para);
        para = line;
      }
      prev = line;
    }
    push(out, para);
    block = [];
  };
  for (const line of lines) {
    if (line === "") {
      if (byBlank) flush();
      continue;
    }
    block.push(line);
  }
  flush();
  return out;
}

function push(out: string[], para: string): void {
  const cleaned = cleanLine(para);
  if (cleaned) out.push(cleaned);
}

function isStructuralLine(line: string): boolean {
  return isNavLine(line) || isTailLine(line) || CREDIT_LINE.test(line) || (looksLikeChapterTitle(line) && countWords(line) <= 20);
}

/** Жёсткий перенос посреди фразы: строка не кончается знаком, следующая — со строчной. */
function softWrap(prev: string, next: string): boolean {
  return !/[.!?…:;"”’'»)\]—–\-*]$/.test(prev) && /^[a-zа-яё(,]/.test(next);
}

/**
 * Верхнее меню: всё до последней строки навигации в голове текста. Срезаем,
 * только если перед ней мало слов — иначе это уже текст главы.
 */
function topCut(paragraphs: string[]): number {
  const total = countWordsAll(paragraphs);
  const limit = Math.min(paragraphs.length, HEAD_SCAN);
  let cut = 0;
  let wordsBefore = 0;
  for (let i = 0; i < limit; i++) {
    const own = countWords(paragraphs[i]);
    // Меню сверху — только если до него почти ничего, а после него — бóльшая
    // часть текста. Иначе «Next Chapter» в конце короткой вставки срезал бы всю главу.
    const nearTop = wordsBefore <= Math.min(60, Math.max(8, total * 0.15));
    const restIsChapter = total - wordsBefore - own >= total * 0.5;
    if (isNavLine(paragraphs[i]) && nearTop && restIsChapter) cut = i + 1;
    wordsBefore += own;
  }
  return cut;
}

/**
 * Нижний срез: с первой строки-якоря (навигация, «Comments», «Report chapter»…),
 * которая стоит во второй половине текста. В середине главы не режем никогда.
 */
function bottomCut(paragraphs: string[], from: number): number {
  const total = countWordsAll(paragraphs.slice(from));
  let seen = 0;
  for (let i = from; i < paragraphs.length; i++) {
    if (seen >= total * 0.5 && isTailLine(paragraphs[i])) return i;
    seen += countWords(paragraphs[i]);
  }
  return paragraphs.length;
}

/** Первая строка как название: короткая, не реплика, не обрывок фразы. */
function looksLikeLooseTitle(p: string): boolean {
  if (p.length > 120 || p.indexOf("\n") >= 0) return false;
  if (/^["“”'‘«—–-]/.test(p)) return false;
  if (/[.,;:]$/.test(p) && !looksLikeChapterTitle(p)) return false;
  return countWords(p) > 0;
}

/** Похоже на список глав, а не на главу: большинство строк — «Chapter N …». */
function looksLikeChapterList(paragraphs: string[]): boolean {
  if (paragraphs.length < 10) return false;
  let titles = 0;
  for (const p of paragraphs) if (looksLikeChapterTitle(p) && countWords(p) <= 15) titles++;
  return titles / paragraphs.length > 0.5;
}

/** Разделители сцен — единым видом, подряд не больше одного, по краям не нужны. */
export function tidySeparators(paragraphs: string[]): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    if (isSeparator(p)) {
      if (out.length > 0 && out[out.length - 1] !== SCENE_BREAK) out.push(SCENE_BREAK);
    } else {
      out.push(p);
    }
  }
  while (out.length > 0 && out[out.length - 1] === SCENE_BREAK) out.pop();
  return out;
}

/** Текст «Поделиться» — это просто ссылка? Вернёт адрес или null. */
export function sharedUrl(text: string): string | null {
  const t = (text || "").trim();
  if (t === "") return null;

  const found = t.match(/https?:\/\/[^\s<>"'«»]+/i);
  let candidate: string | null = null;
  let rest = t;
  if (found) {
    candidate = found[0];
    rest = t.slice(0, found.index) + " " + t.slice((found.index || 0) + found[0].length);
  } else if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i.test(t)) {
    // Голый адрес без схемы: «royalroad.com/fiction/…».
    candidate = "https://" + t;
    rest = "";
  }
  if (!candidate) return null;

  // Android делится «Название главы https://…»: вокруг ссылки допустим только
  // короткий заголовок. Длинный текст со ссылкой внутри — это уже глава.
  rest = rest.trim();
  if (rest.length > 200 || /\n\s*\n/.test(rest) || countWords(rest) > 30) return null;

  candidate = candidate.replace(/[.,;:!?)\]}>]+$/, "");
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Подписи переводчика сверху: «Translator: KJ», «TL: …», «Edited by: …».
 * Только в начале строки и с двоеточием.
 */
const CREDIT_LINE =
  /^(?:translator|translators|translation|tl|editor|editors|edited\s+by|proofreader|proofread\s+by|translated\s+by|raw\s+provider|tl\s*check|t\/?n|pr)\s*[:：]/i;

/**
 * Подвал узнаём только по явным приметам — площадке поддержки или обещанию
 * глав вперёд. Ничего вроде «please»: глава вполне может кончаться репликой
 * «Please, don't» (урок exttran, коммит 5954956). И не голое «discord» —
 * это обычное английское слово («the discord between them»).
 */
const SUPPORT_LINE =
  /\b(?:patreon|ko-?fi|buymeacoffee|buy\s+me\s+a\s+coffee|boosty|paypal|discord\.(?:gg|com)|(?:join|our|my)\s+discord|discord\s+(?:server|channel)|advanced?\s+chapters?|chapters?\s+ahead|early\s+access|read\s+ahead)\b/i;

/** Сколько абзацев с каждого края вообще можно трогать. */
const HEAD_WINDOW = 8;
const TAIL_WINDOW = 6;
/** Подвал — короткая строка; длинный абзац с «patreon» внутри — уже текст. */
const MAX_CREDIT_LENGTH = 300;

/** Срезать подвалы переводчиков только по краям (из exttran:src/extract.ts stripCredits). */
export function stripCredits(paragraphs: string[]): string[] {
  let start = 0;
  while (start < paragraphs.length && start < HEAD_WINDOW) {
    const p = paragraphs[start].trim();
    if (p === "" || isSeparator(p) || (p.length <= MAX_CREDIT_LENGTH && CREDIT_LINE.test(p))) {
      start++;
      continue;
    }
    break;
  }

  let end = paragraphs.length;
  while (end > start && paragraphs.length - end < TAIL_WINDOW) {
    const p = paragraphs[end - 1].trim();
    if (p === "" || isSeparator(p) || (p.length <= MAX_CREDIT_LENGTH && SUPPORT_LINE.test(p))) {
      end--;
      continue;
    }
    break;
  }

  return paragraphs.slice(start, end);
}

/**
 * Маркеры закрытой главы (из exttran:src/extract.ts LOCK_MARKERS). Сами по себе
 * ничего не значат: «early access on Patreon» стоит и под обычными главами.
 */
const LOCK_MARKERS =
  /(locked chapter|chapter is locked|this chapter is locked|unlock this chapter|unlock (?:the )?chapter|premium chapter|members only|subscribe to read|advance access|early access|purchase this chapter|coins? to unlock|buy this chapter|глава закрыта|платная глава)/i;

/** Глава короче этого — повод присмотреться к маркерам. */
const LOCKED_MAX_WORDS = 150;

/** Маркеры закрытой главы — только подсказка, и только при малом тексте. */
export function looksLocked(paragraphs: string[], pageText?: string): boolean {
  if (countWordsAll(paragraphs) >= LOCKED_MAX_WORDS) return false;
  if (LOCK_MARKERS.test(paragraphs.join("\n"))) return true;
  return pageText ? LOCK_MARKERS.test(pageText) : false;
}
