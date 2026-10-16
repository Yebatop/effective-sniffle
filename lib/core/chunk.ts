/**
 * Деление главы на части для перевода.
 *
 * Часть — непрерывный диапазон абзацев (idx) не больше maxWords английских
 * слов (по умолчанию 1 400); абзац не режется. idx 0 (название) всегда в
 * первой части. Деление детерминировано: одна и та же глава всегда даёт те
 * же части — от этого зависит продолжение задачи после обрыва.
 */

import type { Paragraph } from "../types";

export interface Chunk {
  index: number; // номер части, с 0
  from: number; // первый idx включительно
  to: number; // последний idx включительно
  words: number;
}

export const DEFAULT_CHUNK_WORDS = 1400;

export function splitIntoChunks(paragraphs: Paragraph[], maxWords = DEFAULT_CHUNK_WORDS): Chunk[] {
  throw new Error("not implemented");
}

/** Разделить диапазон пополам по абзацам (для повтора после отказа модели). */
export function halveRange(from: number, to: number): [[number, number], [number, number]] | null {
  throw new Error("not implemented");
}
