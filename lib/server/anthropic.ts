/**
 * Вызовы Claude: перевод части потоком и разбор терминов.
 *
 * - Клиент: new Anthropic() — ключ из ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL
 *   переопределяет адрес (так тесты подставляют поддельный сервер).
 * - Перевод — всегда потоком (messages.stream / beta.messages.stream +
 *   finalMessage). Для Sonnet/Opus — серверный fallbacks: "default"
 *   (beta server-side-fallback-2026-07-01), для Haiku — без него.
 * - effort передаётся всегда явно (output_config.effort); thinking не
 *   передаётся (на Opus 5.5 его нельзя выключить; adaptive — по умолчанию).
 * - Отказ — HTTP 200 со stop_reason "refusal": вернуть kind "refused",
 *   начатый текст выбросить. max_tokens — kind "truncated".
 * - Ошибки SDK → ErrorCode через typed-классы, не по тексту сообщения,
 *   кроме двух случаев, у которых нет своего класса: «credit balance is too
 *   low» → credit_low, «specified API usage limits» → console_limit.
 */

import type { Effort, ErrorCode, ModelId, Usage } from "../types";
import type { BuiltRequest } from "../core/prompt";
import type { ProposedAddress, ProposedTerm } from "../db/terms";

export type TranslateOutcome =
  | { kind: "ok"; paragraphs: Array<{ idx: number; text: string }>; usage: Usage; model: string; stopReason: string }
  | { kind: "refused"; usage: Usage; model: string; category: string | null }
  | { kind: "truncated"; paragraphs: Array<{ idx: number; text: string }>; usage: Usage; model: string }
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean };

/**
 * Перевести часть. onParagraph вызывается для каждого завершённого абзаца
 * по мере потока (через createLabelParser) — так читалка видит текст до
 * конца части. Абзацы приходят уже с polish().
 */
export async function translateChunk(
  req: BuiltRequest,
  model: ModelId,
  effort: Effort,
  expected: { from: number; to: number },
  onParagraph: (p: { idx: number; text: string }) => Promise<void> | void,
): Promise<TranslateOutcome> {
  throw new Error("not implemented");
}

export interface ExtractionResult {
  terms: ProposedTerm[];
  addresses: ProposedAddress[];
  narrator: { person: 1 | 3 | null; gender: "m" | "f" | "unknown" | null } | null;
  /** Предложение стиля по жанру: live/plain/elevated. */
  register: "live" | "plain" | "elevated" | null;
}

export type ExtractOutcome =
  | { kind: "ok"; result: ExtractionResult; usage: Usage; model: string }
  | { kind: "refused"; usage: Usage; model: string }
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean };

/**
 * Разбор главы до перевода: новые имена и термины (с родом персонажей и
 * другими именами), кто к кому на «ты/вы», рассказчик, стиль. Модель видит
 * уже известные термины с русскими написаниями и обращения, чтобы не
 * дублировать. Structured outputs (messages.parse + zodOutputFormat),
 * effort low.
 */
export async function extractTerms(input: {
  model: ModelId;
  chapterText: string;
  known: Array<{ en: string; ru: string; kind: string; aliases: string[] }>;
  knownAddresses: Array<{ fromEn: string; toEn: string; form: "ty" | "vy" }>;
  isFirstChapterOfBook: boolean;
}): Promise<ExtractOutcome> {
  throw new Error("not implemented");
}

/** Проверка ключа без трат (models.retrieve). */
export async function checkKey(): Promise<{ ok: boolean; message?: string }> {
  throw new Error("not implemented");
}
