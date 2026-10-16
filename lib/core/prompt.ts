/**
 * Сборка запроса на перевод части главы.
 *
 * Порядок — от неизменного к меняющемуся: правила → стиль книги (это
 * system, с одной меткой кэша после) → глоссарий части, рассказчик →
 * концовка предыдущего текста → абзацы с метками. Поток и пакет собирают
 * запрос одной этой функцией: расхождение даже в пробел ломает кэш и слог.
 */

import type { Address, Book, ModelId, Effort, Paragraph, Term } from "../types";

export interface TranslatePromptInput {
  book: Book;
  chapterNumber: number | null;
  /** Абзацы этой части (idx 0 — название, если входит в часть). */
  paragraphs: Paragraph[];
  /** Все термины книги и обращения — отбор по тексту делается внутри. */
  terms: Term[];
  addresses: Address[];
  /** Последние 2–3 переведённых абзаца перед этой частью (из этой или прошлой главы). */
  previousTail: string[];
  /** Короткое «что было раньше», если есть. */
  summary?: string | null;
}

export interface BuiltRequest {
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user"; content: string }>;
  /** Оценка входных токенов — для резерва бюджета. */
  inputTokensEstimate: number;
  /** max_tokens для этой части: ожидаемый вывод × 1,5 + запас на обдумывание. */
  maxTokens: number;
}

/** Правила перевода (из «Толмача», дополненные метками, названием, рассказчиком). */
export const RULES: string = "";

export function buildTranslateRequest(input: TranslatePromptInput, model: ModelId, effort: Effort): BuiltRequest {
  throw new Error("not implemented");
}
