/**
 * Задача «собрать глоссарий из готового перевода» — одна живая на книгу,
 * с арендой и попытками, как перевод главы (lib/db/jobs.ts).
 */

import type { Db } from "./client";
import { LEASE_SECONDS } from "./jobs";
import { toGlossaryJob } from "./rows";
import type { ErrorCode, GlossaryJob, GlossaryJobStage, GlossaryJobState, ModelId } from "../types";

const LIVE_STATES = "('queued','running','blocked_budget','blocked_credit')";
const ENDED: GlossaryJobState[] = ["done", "failed", "stopped"];

export async function createOrGetGlossaryJob(
  d: Db,
  input: { bookId: string; model: ModelId; scanTotal: number; alignTotal: number },
  tries = 3,
): Promise<{ job: GlossaryJob; created: boolean }> {
  const r = await d.query(
    `insert into glossary_jobs (book_id, model, scan_total, align_total, stage)
     values ($1, $2, $3, $4, case when $3::int > 0 then 'scan' else 'align' end)
     on conflict do nothing returning *`,
    [input.bookId, input.model, input.scanTotal, input.alignTotal],
  );
  if (r.rows[0]) return { job: toGlossaryJob(r.rows[0]), created: true };
  const live = await liveGlossaryJob(d, input.bookId);
  if (live) return { job: live, created: false };
  if (tries <= 1) throw new Error("Не удалось создать задачу глоссария.");
  return createOrGetGlossaryJob(d, input, tries - 1);
}

export async function getGlossaryJob(d: Db, id: string): Promise<GlossaryJob | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await d.query("select * from glossary_jobs where id = $1", [id]);
  return r.rows[0] ? toGlossaryJob(r.rows[0]) : null;
}

export async function liveGlossaryJob(d: Db, bookId: string): Promise<GlossaryJob | null> {
  const r = await d.query(
    `select * from glossary_jobs where book_id = $1 and state in ${LIVE_STATES} order by created_at desc limit 1`,
    [bookId],
  );
  return r.rows[0] ? toGlossaryJob(r.rows[0]) : null;
}

export async function latestGlossaryJob(d: Db, bookId: string): Promise<GlossaryJob | null> {
  const r = await d.query("select * from glossary_jobs where book_id = $1 order by created_at desc limit 1", [bookId]);
  return r.rows[0] ? toGlossaryJob(r.rows[0]) : null;
}

/** Захватить: только queued или running с истёкшей арендой. */
export async function claimGlossaryJob(d: Db, id: string): Promise<GlossaryJob | null> {
  const r = await d.query(
    `update glossary_jobs set state = 'running', lease_until = now() + make_interval(secs => $2),
       attempt = attempt + 1, updated_at = now()
     where id = $1 and (state = 'queued' or (state = 'running' and (lease_until is null or lease_until < now())))
     returning *`,
    [id, LEASE_SECONDS],
  );
  return r.rows[0] ? toGlossaryJob(r.rows[0]) : null;
}

/**
 * Продлить аренду и записать прогресс. Продвинулись (scanDone/alignDone
 * выросли) — счётчик повторов обнуляется. false — задачу сменили или остановили.
 */
export async function glossaryHeartbeat(
  d: Db,
  id: string,
  attempt: number,
  patch?: Partial<{ stage: GlossaryJobStage; scanDone: number; scanTotal: number; alignDone: number; alignTotal: number }>,
): Promise<boolean> {
  const progressed = patch?.scanDone != null || patch?.alignDone != null || patch?.stage != null;
  const r = await d.query(
    `update glossary_jobs set lease_until = now() + make_interval(secs => $3), updated_at = now(),
       stage = coalesce($4, stage),
       scan_done = coalesce($5, scan_done),
       scan_total = coalesce($6, scan_total),
       align_done = coalesce($7, align_done),
       align_total = coalesce($8, align_total),
       retries = case when $9 then 0 else retries end
     where id = $1 and attempt = $2 and state = 'running'
     returning id`,
    [id, attempt, LEASE_SECONDS, patch?.stage ?? null, patch?.scanDone ?? null, patch?.scanTotal ?? null, patch?.alignDone ?? null, patch?.alignTotal ?? null, progressed],
  );
  return r.rows.length > 0;
}

/** Состояние — только своей попыткой (сменённый исполнитель не затирает нового). */
export async function setGlossaryStateIf(
  d: Db,
  id: string,
  attempt: number,
  state: GlossaryJobState,
  error?: { code: ErrorCode; message: string } | null,
): Promise<boolean> {
  const clearLease = ENDED.includes(state) || state.startsWith("blocked");
  const r = await d.query(
    `update glossary_jobs set state = $3, error_code = $4, error_message = $5,
       stage = case when $3 = 'done' then 'done' else stage end,
       lease_until = case when $6 then null else lease_until end, updated_at = now()
     where id = $1 and attempt = $2 and state = 'running'
     returning id`,
    [id, attempt, state, error?.code ?? null, error?.message ?? null, clearLease],
  );
  return r.rows.length > 0;
}

/** Остановить по просьбе читателя: любая живая задача книги → stopped. */
export async function stopGlossaryJob(d: Db, bookId: string): Promise<boolean> {
  const r = await d.query(
    `update glossary_jobs set state = 'stopped', lease_until = null, updated_at = now()
     where book_id = $1 and state in ${LIVE_STATES} returning id`,
    [bookId],
  );
  return r.rows.length > 0;
}

export async function bumpGlossaryRetries(d: Db, id: string): Promise<number> {
  const r = await d.query("update glossary_jobs set retries = retries + 1 where id = $1 returning retries", [id]);
  return r.rows[0] ? Number(r.rows[0].retries) : 0;
}

/** Резерв на задаче: delta > 0 — взяли, < 0 — вернули. */
export async function trackGlossaryReservation(d: Db, id: string, delta: number, month: string): Promise<void> {
  await d.query(
    "update glossary_jobs set reserved_usd = greatest(0, reserved_usd + $2), reserved_month = $3 where id = $1",
    [id, delta, month],
  );
}

/** Резерв, оставшийся от убитого захода, — забрать (вызывает только захвативший). */
export async function takeOrphanGlossaryReservation(d: Db, id: string): Promise<{ usd: number; month: string | null }> {
  const r = await d.query(
    `with old as (select reserved_usd, reserved_month from glossary_jobs where id = $1),
          upd as (update glossary_jobs set reserved_usd = 0 where id = $1)
     select * from old`,
    [id],
  );
  const row = r.rows[0];
  return { usd: row ? Number(row.reserved_usd) : 0, month: row?.reserved_month == null ? null : String(row.reserved_month) };
}

export async function addGlossarySpent(d: Db, id: string, usd: number): Promise<void> {
  await d.query("update glossary_jobs set spent_usd = spent_usd + $2 where id = $1", [id, usd]);
}

/** Эстафета: отпустить аренду, задача остаётся running и продолжаемой. */
export async function releaseGlossaryJob(d: Db, id: string, attempt: number): Promise<void> {
  await d.query(
    "update glossary_jobs set lease_until = now() - interval '1 second', updated_at = now() where id = $1 and attempt = $2 and state = 'running'",
    [id, attempt],
  );
}

/** Зависшие (исполнитель пропал) и забытые в очереди — для крона. */
export async function staleGlossaryJobs(d: Db): Promise<GlossaryJob[]> {
  const r = await d.query(
    `select * from glossary_jobs
     where (state = 'running' and (lease_until is null or lease_until < now()))
        or (state = 'queued' and updated_at < now() - interval '1 minute')
     order by updated_at limit 10`,
  );
  return r.rows.map(toGlossaryJob);
}

/** После поднятия лимита или пополнения: blocked_* → queued. */
export async function unblockGlossaryJobs(d: Db): Promise<string[]> {
  const r = await d.query(
    `update glossary_jobs set state = 'queued', error_code = null, error_message = null, updated_at = now()
     where state in ('blocked_budget','blocked_credit') returning id`,
  );
  return r.rows.map((row) => String(row.id));
}
