/**
 * Общие мелочи снятия текста: счёт слов, чистка строки, разделители сцен,
 * строки навигации. Без DOM и без Node — этот файл попадает и в кнопку
 * на сайтах (esbuild, es2019), поэтому никаких replaceAll/at/structuredClone.
 */

/** Слова считаются одинаково везде: по ним оценивается цена главы. */
export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}'’-]+/gu);
  return words ? words.length : 0;
}

export function countWordsAll(paragraphs: readonly string[]): number {
  let sum = 0;
  for (const p of paragraphs) sum += countWords(p);
  return sum;
}

/**
 * Привести строку абзаца к виду для хранения: неразрывные и прочие пробелы —
 * в обычный, нулевой ширины — прочь, внутри строки один пробел. Переносы
 * строк (из одиночного <br>) сохраняются: под одной меткой абзаца бывает
 * несколько строк — реплики, стихи, сообщения.
 */
export function cleanLine(text: string): string {
  return text
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\s  -   　]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Строка из одних звёздочек, черт, тильд, ромбиков — разделитель сцены. */
const SEPARATOR = /^[\s*_=~—–\-−·•∙◇◆○●◎□■☆★※#+.─-╿]+$/;

export function isSeparator(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  // Одинокая точка или «...» — это реплика-многоточие, а не разделитель.
  if (/^[.…\s]+$/.test(t)) return false;
  return SEPARATOR.test(t);
}

/** Единый вид разделителя сцены. */
export const SCENE_BREAK = "* * *";

/**
 * Навигация между главами: строка целиком из «Previous Chapter», «Next»,
 * «Table of Contents», «Index» и их русских собратьев (с | / • между ними).
 * Строгое совпадение по всей строке — в тексте главы такое не встречается.
 */
const NAV_WORD =
  "(?:«|‹|<<?|←|⟵)?\\s*(?:prev(?:ious)?(?:\\s+chapter)?|next(?:\\s+chapter)?|table\\s+of\\s+contents?|contents|index|toc|chapter\\s+list|all\\s+chapters|back\\s+to\\s+(?:index|novel|book|series)|предыдущая(?:\\s+глава)?|следующая(?:\\s+глава)?|назад|далее|вперёд|вперед|оглавление|содержание|к\\s+оглавлению)\\s*(?:»|›|>>?|→|⟶)?";
const NAV_LINE = new RegExp(`^(?:${NAV_WORD})(?:\\s*[|/•·,\\-–—]?\\s*(?:${NAV_WORD}))*\\s*$`, "i");

export function isNavLine(text: string): boolean {
  const t = text.trim();
  if (t === "" || t.length > 120) return false;
  return NAV_LINE.test(t);
}

/** Похоже на заголовок главы: «Chapter 12», «Ch. 3:», «Глава 5», «Prologue». */
const CHAPTER_TITLE =
  /^(?:chapter|chap\.?|ch\.?|episode|ep\.?|part|book\s+\d+\s*,?\s*chapter|vol(?:ume)?\.?\s*\d+\s*,?\s*(?:chapter|ch\.?)|глава|часть|эпизод)\s*[-#№:.]?\s*(?:\d+|[ivxlcdm]+\b|one|two|three|four|five|six|seven|eight|nine|ten)|^(?:prologue|epilogue|interlude|side\s+story|extra|afterword|intermission|пролог|эпилог|интерлюдия)\b/i;

export function looksLikeChapterTitle(text: string): boolean {
  const t = text.trim();
  if (t === "" || t.length > 150) return false;
  return CHAPTER_TITLE.test(t);
}

/** Место под рекламу посреди текста: строка целиком «Advertisement». */
const AD_LINE = /^(?:advertisement|advertisements|sponsored content|ads?)$/i;

export function isAdLine(text: string): boolean {
  return AD_LINE.test(text.trim());
}

/** Экранировать строку для RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Убрать из заголовка главы имя книги и сайта: «Book — Chapter 3» → «Chapter 3».
 * В отличие от exttran «Chapter N» не срезается — по нему ищется номер главы.
 */
export function withoutBookName(title: string, names: ReadonlyArray<string | null | undefined>): string {
  let out = title.trim();
  for (const raw of names) {
    const name = (raw || "").trim();
    if (!name || name.length < 2) continue;
    if (out.toLowerCase() === name.toLowerCase()) return "";
    const escaped = escapeRegExp(name);
    out = out.replace(new RegExp(`^${escaped}\\s*[-–—:|·•»]+\\s*`, "i"), "");
    out = out.replace(new RegExp(`\\s*[-–—:|·•«]+\\s*${escaped}$`, "i"), "");
  }
  return out.trim();
}
