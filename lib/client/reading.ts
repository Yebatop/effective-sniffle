/**
 * Чистые помощники читалки: слова, время до конца главы, слияние абзацев
 * из опроса задачи.
 */

import type { JobState, TranslatedParagraph } from "../types";

/** Скорость чтения русского текста, слов в минуту. */
export const READING_WPM = 180;

/** Слова в русском (или любом) тексте: куски между пробелами, где есть буква или цифра. */
export function countWords(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const part of text.split(/\s+/)) {
    if (part && /[\p{L}\p{N}]/u.test(part)) n += 1;
  }
  return n;
}

/**
 * Сколько минут читать от абзаца fromIdx (включительно) до конца.
 * Название главы (idx 0) не считается. 0 — читать нечего.
 */
export function minutesLeft(paragraphs: ReadonlyArray<{ idx: number; text: string }>, fromIdx: number, wpm = READING_WPM): number {
  let words = 0;
  for (const p of paragraphs) {
    if (p.idx >= 1 && p.idx >= fromIdx) words += countWords(p.text);
  }
  if (words === 0) return 0;
  return Math.max(1, Math.ceil(words / wpm));
}

/**
 * Влить новые абзацы перевода. Ключ — idx; при повторе побеждает больший seq
 * (модель могла переписать абзац). Возвращает новый Map, старый не трогает.
 */
export function mergeTranslated(
  current: ReadonlyMap<number, TranslatedParagraph>,
  incoming: readonly TranslatedParagraph[],
): Map<number, TranslatedParagraph> {
  const next = new Map(current);
  for (const p of incoming) {
    const prev = next.get(p.idx);
    if (!prev || p.seq >= prev.seq) next.set(p.idx, p);
  }
  return next;
}

/** Абзацы по порядку idx. */
export function orderedParagraphs(map: ReadonlyMap<number, TranslatedParagraph>): TranslatedParagraph[] {
  return Array.from(map.values()).sort((a, b) => a.idx - b.idx);
}

export function maxSeq(paragraphs: readonly { seq: number }[], start = 0): number {
  let s = start;
  for (const p of paragraphs) if (p.seq > s) s = p.seq;
  return s;
}

/** Задача ещё идёт — её надо опрашивать. */
export function isLiveJobState(state: JobState | null | undefined): boolean {
  return state === "queued" || state === "running";
}

/** Задача остановилась ошибкой или ждёт решения человека. */
export function isStoppedJobState(state: JobState | null | undefined): boolean {
  return state === "failed" || state === "blocked_budget" || state === "blocked_credit";
}
