/** Переводы: версии не перезаписываются, текущая — указатель в главе. */

import type { Db } from "./client";
import type { ModelId, Translation, TranslatedParagraph } from "../types";

export async function createTranslation(d: Db, input: { chapterId: string; model: ModelId; mode: "sync" | "batch"; glossaryVersion: number }): Promise<Translation> {
  throw new Error("not implemented");
}

/** Записать/заменить абзац перевода; seq берётся новый — опрос увидит обновление. */
export async function upsertParagraph(d: Db, translationId: string, p: { idx: number; text: string; refused?: boolean }): Promise<number> {
  throw new Error("not implemented");
}

/** Удалить абзацы диапазона (недописанная часть перед повтором). */
export async function deleteParagraphRange(d: Db, translationId: string, from: number, to: number): Promise<void> {
  throw new Error("not implemented");
}

export async function getTranslation(d: Db, id: string): Promise<Translation | null> {
  throw new Error("not implemented");
}

/** Абзацы с seq > since, по idx. */
export async function getParagraphsSince(d: Db, translationId: string, since: number): Promise<TranslatedParagraph[]> {
  throw new Error("not implemented");
}

export async function addTranslationCost(d: Db, translationId: string, usd: number): Promise<void> {
  throw new Error("not implemented");
}

/** Завершить: статус done и указатель главы на эту версию. */
export async function finishTranslation(d: Db, translationId: string): Promise<void> {
  throw new Error("not implemented");
}

export async function failTranslation(d: Db, translationId: string): Promise<void> {
  throw new Error("not implemented");
}

/** Последние n абзацев текущего перевода предыдущей главы — контекст для следующей. */
export async function tailOfChapter(d: Db, chapterId: string, n: number): Promise<string[]> {
  throw new Error("not implemented");
}
