/**
 * Задачи перевода: без двойного запуска и с арендой.
 *
 * Создание — insert … on conflict do nothing по частичному уникальному
 * индексу jobs_live_per_chapter: повтор отдаёт уже живую задачу. Захват —
 * один атомарный update: только queued или running с истёкшей арендой.
 */

import type { Db } from "./client";
import type { Effort, ErrorCode, Job, JobState, ModelId } from "../types";

export const LEASE_SECONDS = 90;

export async function createOrGetJob(d: Db, input: { chapterId: string; model: ModelId; effort: Effort }): Promise<{ job: Job; created: boolean }> {
  throw new Error("not implemented");
}

/** Захватить задачу: state → running, lease_until = now()+90 с, attempt+1. null — занята или завершена. */
export async function claimJob(d: Db, id: string): Promise<Job | null> {
  throw new Error("not implemented");
}

/** Продлить аренду и записать прогресс. Возвращает false, если задачу перехватили (аренда истекла и её взял другой). */
export async function heartbeat(d: Db, id: string, attempt: number, patch?: Partial<{ nextChunk: number; chunksTotal: number; termsExtracted: boolean; translationId: string }>): Promise<boolean> {
  throw new Error("not implemented");
}

export async function setJobState(d: Db, id: string, state: JobState, error?: { code: ErrorCode; message: string } | null): Promise<void> {
  throw new Error("not implemented");
}

/** Отпустить аренду, оставив задачу продолжаемой (эстафета): state остаётся running, lease_until = now(). */
export async function releaseJob(d: Db, id: string, attempt: number): Promise<void> {
  throw new Error("not implemented");
}

export async function getJob(d: Db, id: string): Promise<Job | null> {
  throw new Error("not implemented");
}

/** Живая задача главы, если есть. */
export async function liveJobForChapter(d: Db, chapterId: string): Promise<Job | null> {
  throw new Error("not implemented");
}

/** Задачи running с истёкшей арендой и queued старше минуты — для перезапуска кроном. */
export async function staleJobs(d: Db): Promise<Job[]> {
  throw new Error("not implemented");
}

/** Снять блокировку (после поднятия лимита или пополнения): blocked_* → queued. */
export async function unblockJobs(d: Db): Promise<number> {
  throw new Error("not implemented");
}
