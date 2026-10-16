/**
 * Токены в деньги и оценка цены до вызова.
 *
 * Профиль из замера «Толмача» (14.09.2026, 10 глав, медиана 1 738 слов):
 * ~31 225 «входных эквивалентов» на главу при цене выхода 5× входа,
 * то есть ~17 966 на 1 000 английских слов. Отсюда оценки.
 */

import type { Effort, ModelId, Usage } from "../types";

/** Фактическая цена вызова в долларах. batch — скидка 50%. */
export function usageCostUsd(model: ModelId, usage: Usage, opts?: { batch?: boolean }): number {
  throw new Error("not implemented");
}

/** Оценка цены перевода текста из `words` английских слов (вход + выход + обдумывание). */
export function estimateTranslationUsd(model: ModelId, words: number, opts?: { effort?: Effort; batch?: boolean }): number {
  throw new Error("not implemented");
}

/**
 * Худшая возможная цена одного запроса — для резерва в бюджете:
 * все входные токены по полной цене + max_tokens по цене выхода.
 */
export function worstCaseUsd(model: ModelId, inputTokensEstimate: number, maxTokens: number): number {
  throw new Error("not implemented");
}

/** Грубая оценка числа токенов в тексте (английский или русский) без вызова API. */
export function estimateTokens(text: string): number {
  throw new Error("not implemented");
}

/** Рубли по курсу, округлённые для показа: «≈ 3,5 ₽», «≈ 0,30 ₽». */
export function formatRub(usd: number, usdRub: number): string {
  throw new Error("not implemented");
}

/** Число английских слов в абзацах. */
export function countWords(paragraphs: string[]): number {
  throw new Error("not implemented");
}
