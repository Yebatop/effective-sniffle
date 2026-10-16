/**
 * Подсветка терминов глоссария в русском тексте (перенос exttran:src/highlight.ts).
 *
 * Русский склоняется: «Эбенхольц» встретится как «Эбенхольца», «Эбенхольцем».
 * Поэтому ищем термин плюс одно из окончаний — не произвольные буквы:
 * «мана» + окончание не поймает «манатки». Лучше пропустить падеж, чем
 * подчеркнуть постороннее слово.
 *
 * Отличия от exttran:
 * - регулярка собирается ОДИН раз на список терминов (compileTerms), а не на
 *   каждый абзац при каждой отрисовке;
 * - без учёта регистра («Орден» и «орден»), «е» и «ё» равны;
 * - в многословных терминах склоняется каждое слово («наставника Гу»);
 * - слово на гласную/ь/й длиннее трёх букв ищется по основе
 *   («Печать» → «Печати», «Печатью»; «Лина» → «Лины»).
 */

/** Окончания, от длинных к коротким. */
const ENDINGS = [
  "ами", "ями", "ому", "ему", "ыми", "ими", "ого", "его",
  "ах", "ях", "ам", "ям", "ом", "ем", "ём", "ой", "ей", "ёй", "ую", "юю",
  "ые", "ие", "ых", "их", "ым", "им", "ов", "ев", "ёв", "ья", "ье", "ью", "ьи",
  "а", "я", "у", "ю", "е", "ё", "ы", "и", "о", "ь", "й",
];
const ENDING_GROUP = `(?:${ENDINGS.join("|")})`;

/** Буква любого алфавита — граница слова. */
const LETTER = /[\p{L}\p{M}]/u;
/** Последняя буква, которую можно отбросить, чтобы получить основу. */
const STRIPPABLE = /[аяоеёыиуюьй]$/i;
/** Слово из одних кириллических букв — только к таким приставляем окончания. */
const CYRILLIC_WORD = /^[а-яё-]+$/i;

export interface Segment<T> {
  text: string;
  /** Заполнено, если кусок — термин. */
  term?: T;
}

export interface CompiledTerms<T> {
  re: RegExp;
  /** Термин по номеру группы в регулярке. */
  byGroup: T[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** «е» и «ё» — одна буква для поиска. */
function yo(escaped: string): string {
  return escaped.replace(/[её]/g, "[её]").replace(/[ЕЁ]/g, "[ЕЁ]");
}

function wordPattern(word: string): string {
  if (!CYRILLIC_WORD.test(word)) return yo(escapeRegExp(word));
  if (word.length >= 4 && STRIPPABLE.test(word)) {
    // Основа + обязательное окончание (исходная буква тоже в списке окончаний).
    return yo(escapeRegExp(word.slice(0, -1))) + ENDING_GROUP;
  }
  return yo(escapeRegExp(word)) + ENDING_GROUP + "?";
}

/** Шаблон одного термина: каждое слово со своим окончанием, между словами — пробелы. */
export function termPattern(ru: string): string {
  const words = ru.trim().split(/\s+/).filter(Boolean);
  return words.map(wordPattern).join("\\s+");
}

/**
 * Собрать регулярку на весь список. Термины короче трёх букв пропускаются,
 * длинные идут первыми — иначе «Орден» съест начало «Орден Стражей».
 * Вернёт null, если подсвечивать нечего.
 */
export function compileTerms<T extends { ru: string }>(terms: readonly T[]): CompiledTerms<T> | null {
  const usable = terms
    .filter((t) => typeof t.ru === "string" && t.ru.trim().length >= 3)
    .slice()
    .sort((a, b) => b.ru.trim().length - a.ru.trim().length);
  if (usable.length === 0) return null;

  const seen = new Set<string>();
  const parts: string[] = [];
  const byGroup: T[] = [];
  for (const term of usable) {
    const key = term.ru.trim().toLowerCase().replace(/ё/g, "е");
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`(${termPattern(term.ru)})`);
    byGroup.push(term);
  }
  // Справа граница проверяется в самой регулярке (с откатом окончаний),
  // слева — вручную: ретроспектива есть не во всех старых браузерах.
  const re = new RegExp(`(?:${parts.join("|")})(?![\\p{L}\\p{M}])`, "giu");
  return { re, byGroup };
}

/** Разбить текст на куски по уже собранной регулярке. */
export function highlightWith<T>(text: string, compiled: CompiledTerms<T> | null): Segment<T>[] {
  if (!compiled || text === "") return [{ text }];
  const { re, byGroup } = compiled;
  re.lastIndex = 0;
  const segments: Segment<T>[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? text.charAt(start - 1) : "";
    if (before && LETTER.test(before)) {
      // Кусок внутри слова: «мане» в «манекене» — не термин. Продолжаем со
      // следующей буквы, чтобы не пропустить термин, начинающийся внутри.
      re.lastIndex = start + 1;
      continue;
    }
    let term: T | undefined;
    for (let g = 1; g < m.length; g += 1) {
      if (m[g] !== undefined) {
        term = byGroup[g - 1];
        break;
      }
    }
    if (!term) continue;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: m[0], term });
    last = end;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.length > 0 ? segments : [{ text }];
}

/** Удобная обёртка для разовых вызовов (в читалке — compileTerms + highlightWith). */
export function highlight<T extends { ru: string }>(text: string, terms: readonly T[]): Segment<T>[] {
  return highlightWith(text, compileTerms(terms));
}
