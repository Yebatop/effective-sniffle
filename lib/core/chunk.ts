/**
 * Деление главы на части для перевода.
 *
 * Часть — непрерывный диапазон абзацев (idx) не больше maxWords английских
 * слов (по умолчанию 1 400); абзац не режется. idx 0 (название) всегда в
 * первой части. Деление детерминировано: одна и та же глава всегда даёт те
 * же части — от этого зависит продолжение задачи после обрыва.
 */

import type { Paragraph } from "../types";
import { wordsIn } from "./words";

export interface Chunk {
  index: number; // номер части, с 0
  from: number; // первый idx включительно
  to: number; // последний idx включительно
  words: number;
}

export const DEFAULT_CHUNK_WORDS = 1400;

/**
 * Части выравниваются по размеру при том же их числе: глава в 1 500 слов
 * делится 750 + 750, а не 1 400 + 100 — крошечная последняя часть платит за
 * тот же префикс правил, а контекста у модели в ней почти нет. Число частей
 * при этом минимальное (каждая лишняя часть — лишний раз оплаченные правила):
 * сначала жадно считается, сколько частей нужно при пределе maxWords, потом
 * подбирается самый маленький предел, который даёт столько же частей.
 *
 * Абзац длиннее maxWords идёт отдельной частью. Название (idx 0) никогда не
 * остаётся частью само по себе — оно всегда едет вместе со следующим абзацем.
 */
export function splitIntoChunks(paragraphs: Paragraph[], maxWords = DEFAULT_CHUNK_WORDS): Chunk[] {
  if (paragraphs.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxWords));
  const sorted = [...paragraphs].sort((a, b) => a.idx - b.idx);

  // Единица деления — абзац; название склеено со следующим абзацем.
  const units: Array<{ from: number; to: number; words: number }> = sorted.map((p) => ({ from: p.idx, to: p.idx, words: wordsIn(p.text) }));
  if (units.length > 1 && units[0].from === 0) {
    const [title, first] = units.splice(0, 2);
    units.unshift({ from: title.from, to: first.to, words: title.words + first.words });
  }

  const minCount = pack(units, limit).length;
  let lo = 1;
  let hi = limit;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pack(units, mid).length <= minCount) hi = mid;
    else lo = mid + 1;
  }
  return pack(units, lo);
}

/** Жадная упаковка: часть закрывается, когда следующая единица не влезает в cap. */
function pack(units: Array<{ from: number; to: number; words: number }>, cap: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const u of units) {
    if (cur && cur.words + u.words > cap) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { index: chunks.length, from: u.from, to: u.to, words: u.words };
    else {
      cur.to = u.to;
      cur.words += u.words;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Разделить диапазон пополам по абзацам (для повтора после отказа модели). */
export function halveRange(from: number, to: number): [[number, number], [number, number]] | null {
  if (!(to > from)) return null;
  const mid = Math.floor((from + to) / 2);
  return [
    [from, mid],
    [mid + 1, to],
  ];
}
