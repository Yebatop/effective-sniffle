/**
 * Подсчёт слов — общий для цены (cost.ts) и деления на части (chunk.ts).
 * Вынесен отдельно, чтобы эти два модуля не импортировали друг друга.
 */

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Слово — кусок между пробелами, в котором есть буква или цифра (тире и «...» не считаются). */
export function wordsIn(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token && HAS_LETTER_OR_DIGIT.test(token)) n += 1;
  }
  return n;
}
