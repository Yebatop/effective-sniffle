/**
 * Задачи перевода: без двойного запуска и с арендой.
 *
 * Создание — insert … on conflict do nothing по частичному уникальному
 * индексу jobs_live_per_chapter: повтор отдаёт уже живую задачу. Захват —
 * один атомарный update: только queued или running с истёкшей арендой.
 */

import type { Db } from "./client";
import { toJob } from "./rows";
import type { Effort, ErrorCode, Job, JobState, ModelId } from "../types";

/** Аренда длиннее паузы до первых абзацев (модель может «думать» до минуты). */
export const LEASE_SECONDS = 120;

const LIVE_STATES = "('queued','running','blocked_budget','blocked_credit')";
const TERMINAL: JobState[] = ["done", "failed"];

export async function createOrGetJob(d: Db, input: { chapterId: string; model: ModelId; effort: Effort }, tries = 3): Promise<{ job: Job; created: boolean }> {
  const r = await d.query(
    `insert into jobs (chapter_id, kind, model, effort) values ($1, 'translate', $2, $3)
     on conflict do nothing returning *`,
    [input.chapterId, input.model, input.effort],
  );
  if (r.rows[0]) return { job: toJob(r.rows[0]), created: true };
  const live = await liveJobForChapter(d, input.chapterId);
  if (live) return { job: live, created: false };
  // Живая задача успела завершиться между двумя запросами — пробуем ещё раз.
  if (tries <= 1) throw new Error("Не удалось создать задачу перевода.");
  return createOrGetJob(d, input, tries - 1);
}

/** Захватить задачу: state → running, lease_until = now()+90 с, attempt+1. null — занята или завершена. */
export async function claimJob(d: Db, id: string): Promise<Job | null> {
  const r = await d.query(
    `update jobs set state = 'running', lease_until = now() + make_interval(secs => $2),
       attempt = attempt + 1, updated_at = now()
     where id = $1 and (state = 'queued' or (state = 'running' and (lease_until is null or lease_until < now())))
     returning *`,
    [id, LEASE_SECONDS],
  );
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** Продлить аренду и записать прогресс. Возвращает false, если задачу перехватили (аренда истекла и её взял другой). */
export async function heartbeat(
  d: Db,
  id: string,
  attempt: number,
  patch?: Partial<{ nextChunk: number; chunksTotal: number; termsExtracted: boolean; translationId: string }>,
): Promise<boolean> {
  const r = await d.query(
    `update jobs set lease_until = now() + make_interval(secs => $3), updated_at = now(),
       next_chunk = coalesce($4, next_chunk),
       chunks_total = coalesce($5, chunks_total),
       terms_extracted = coalesce($6, terms_extracted),
       translation_id = coalesce($7, translation_id)
     where id = $1 and attempt = $2 and state = 'running'
     returning id`,
    [id, attempt, LEASE_SECONDS, patch?.nextChunk ?? null, patch?.chunksTotal ?? null, patch?.termsExtracted ?? null, patch?.translationId ?? null],
  );
  return r.rows.length > 0;
}

export async function setJobState(d: Db, id: string, state: JobState, error?: { code: ErrorCode; message: string } | null): Promise<void> {
  const clearLease = TERMINAL.includes(state) || state.startsWith("blocked");
  await d.query(
    `update jobs set state = $2, error_code = $3, error_message = $4,
       lease_until = case when $5 then null else lease_until end, updated_at = now()
     where id = $1`,
    [id, state, error?.code ?? null, error?.message ?? null, clearLease],
  );
}

/** Отпустить аренду, оставив задачу продолжаемой (эстафета): state остаётся running, lease_until = now(). */
export async function releaseJob(d: Db, id: string, attempt: number): Promise<void> {
  await d.query(
    "update jobs set lease_until = now() - interval '1 second', updated_at = now() where id = $1 and attempt = $2 and state = 'running'",
    [id, attempt],
  );
}

export async function getJob(d: Db, id: string): Promise<Job | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await d.query("select * from jobs where id = $1", [id]);
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** Живая задача главы, если есть. */
export async function liveJobForChapter(d: Db, chapterId: string): Promise<Job | null> {
  const r = await d.query(
    `select * from jobs where chapter_id = $1 and state in ${LIVE_STATES} order by created_at desc limit 1`,
    [chapterId],
  );
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** Последняя задача главы в любом состоянии — чтобы показать, почему перевод не вышел. */
export async function latestJobForChapter(d: Db, chapterId: string): Promise<Job | null> {
  const r = await d.query("select * from jobs where chapter_id = $1 order by created_at desc limit 1", [chapterId]);
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/** Задачи running с истёкшей арендой и queued старше минуты — для перезапуска кроном. */
export async function staleJobs(d: Db): Promise<Job[]> {
  const r = await d.query(
    `select * from jobs
     where (state = 'running' and (lease_until is null or lease_until < now()))
        or (state = 'queued' and updated_at < now() - interval '1 minute')
     order by updated_at limit 20`,
  );
  return r.rows.map(toJob);
}

/** Снять блокировку (после поднятия лимита или пополнения): blocked_* → queued. Возвращает id задач. */
export async function unblockJobs(d: Db): Promise<string[]> {
  const r = await d.query(
    `update jobs set state = 'queued', error_code = null, error_message = null, updated_at = now()
     where state in ('blocked_budget','blocked_credit') returning id`,
  );
  return r.rows.map((row) => String(row.id));
}
