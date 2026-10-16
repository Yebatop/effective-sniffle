/**
 * Метки абзацев. В запросе перед каждым абзацем оригинала стоит ⟦idx⟧,
 * модель обязана повторить ту же метку перед переводом этого абзаца.
 * Под одной меткой может быть несколько строк (реплики с новой строки).
 */

export const LABEL_OPEN = "⟦";
export const LABEL_CLOSE = "⟧";

/** Текст абзацев с метками для запроса: "⟦1⟧ текст\n\n⟦2⟧ текст". */
export function labelParagraphs(items: Array<{ idx: number; text: string }>): string {
  throw new Error("not implemented");
}

/**
 * Разбор потока по мере прихода. push(delta) возвращает абзацы, которые
 * стали завершёнными (пришла следующая метка); finish() — последний абзац.
 * Текст до первой метки отбрасывается. Метки вне ожидаемого диапазона
 * игнорируются; повтор метки — повторный абзац заменяет предыдущий.
 */
export interface LabelStreamParser {
  push(delta: string): Array<{ idx: number; text: string }>;
  finish(): Array<{ idx: number; text: string }>;
}
export function createLabelParser(expected: { from: number; to: number }): LabelStreamParser {
  throw new Error("not implemented");
}

/** Какие idx из диапазона отсутствуют в результате. */
export function missingIdx(expected: { from: number; to: number }, got: Iterable<number>): number[] {
  throw new Error("not implemented");
}
