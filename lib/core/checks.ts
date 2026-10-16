/**
 * Бесплатные проверки готового перевода — подсветка, не автозамена.
 */

import type { Term } from "../types";

export type CheckKind = "missing" | "latin" | "length" | "term_spelling" | "refused";

export interface CheckIssue {
  idx: number;
  kind: CheckKind;
  /** Коротко по-русски, для подсказки. */
  message: string;
}

/**
 * - missing: абзац оригинала без перевода;
 * - latin: латинские слова в русском тексте (кроме белого списка: термины
 *   глоссария с латиницей в ru, аббревиатуры вроде HP, LV, ID);
 * - length: отношение длины перевода к оригиналу вне 0,5–2,5 (для абзацев от 8 слов);
 * - term_spelling: слово, похожее на русское имя термина, но написанное иначе
 *   (основа отличается на 1–2 буквы), например «Лин Вэй» при «Линь Вэй»;
 * - refused: абзац, который модель отказалась переводить.
 */
export function checkTranslation(
  source: Array<{ idx: number; text: string }>,
  translated: Array<{ idx: number; text: string; refused?: boolean }>,
  terms: Term[],
): CheckIssue[] {
  throw new Error("not implemented");
}
