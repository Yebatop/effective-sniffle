/**
 * Бюджет и журнал расходов.
 *
 * Перед каждым вызовом модели резервируется худшая цена; после — резерв
 * закрывается фактом. Резерв атомарен: два устройства не перелетят лимит.
 */

import type { Db } from "./client";
import { iso, num } from "./rows";
import type { BudgetState, ModelId, Usage } from "../types";

/** "2026-10" по UTC. */
export function monthKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function ensureMonth(d: Db, month: string): Promise<void> {
  await d.query("insert into budget (month) values ($1) on conflict do nothing", [month]);
}

/** Зарезервировать; false — не хватает лимита. */
export async function reserve(d: Db, usd: number, limitUsd: number, month: string = monthKey()): Promise<boolean> {
  await ensureMonth(d, month);
  // В read committed второй одновременный update перепроверяет условие
  // на уже обновлённой строке — поэтому два резерва не превысят лимит.
  const r = await d.query(
    `update budget set reserved_usd = reserved_usd + $2
     where month = $1 and spent_usd + reserved_usd + $2 <= $3
     returning month`,
    [month, usd, limitUsd],
  );
  return r.rows.length > 0;
}

/** Закрыть резерв фактом: reserved -= reservedUsd, spent += actualUsd. */
export async function settle(d: Db, reservedUsd: number, actualUsd: number, month: string = monthKey()): Promise<void> {
  await ensureMonth(d, month);
  await d.query(
    "update budget set reserved_usd = greatest(0, reserved_usd - $2), spent_usd = spent_usd + $3 where month = $1",
    [month, reservedUsd, actualUsd],
  );
}

export async function budgetState(d: Db, limitUsd: number, month: string = monthKey()): Promise<BudgetState> {
  const r = await d.query("select spent_usd, reserved_usd from budget where month = $1", [month]);
  return {
    month,
    limitUsd,
    spentUsd: num(r.rows[0]?.spent_usd),
    reservedUsd: num(r.rows[0]?.reserved_usd),
  };
}

export interface ApiCallRecord {
  jobId?: string | null;
  chapterId?: string | null;
  bookId?: string | null;
  purpose: "translate" | "extract" | "repair" | "check" | "other";
  /** Ключ идемпотентности: повтор записи с тем же ключом ничего не делает. */
  idemKey?: string | null;
  model: ModelId | string;
  batch?: boolean;
  usage: Usage;
  stopReason?: string | null;
  usd: number;
}

/** true — записано, false — такой ключ уже был (не считать второй раз). */
export async function recordApiCall(d: Db, rec: ApiCallRecord): Promise<boolean> {
  const r = await d.query(
    `insert into api_calls (job_id, chapter_id, book_id, purpose, idem_key, model, batch,
       input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, stop_reason, usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (idem_key) do nothing
     returning id`,
    [
      rec.jobId ?? null,
      rec.chapterId ?? null,
      rec.bookId ?? null,
      rec.purpose,
      rec.idemKey ?? null,
      rec.model,
      Boolean(rec.batch),
      rec.usage.inputTokens,
      rec.usage.outputTokens,
      rec.usage.cacheWrite5mTokens,
      rec.usage.cacheWrite1hTokens,
      rec.usage.cacheReadTokens,
      rec.stopReason ?? null,
      rec.usd,
    ],
  );
  return r.rows.length > 0;
}

export async function spendByBook(d: Db, month: string = monthKey()): Promise<Array<{ bookId: string | null; title: string | null; usd: number; calls: number }>> {
  const r = await d.query(
    `select a.book_id, b.title, sum(a.usd) as usd, count(*) as calls
     from api_calls a left join books b on b.id = a.book_id
     where to_char(a.created_at at time zone 'UTC', 'YYYY-MM') = $1
     group by a.book_id, b.title
     order by sum(a.usd) desc`,
    [month],
  );
  return r.rows.map((row) => ({
    bookId: row.book_id == null ? null : String(row.book_id),
    title: row.title == null ? null : String(row.title),
    usd: num(row.usd),
    calls: num(row.calls),
  }));
}

export async function recentCalls(d: Db, limit: number): Promise<Array<ApiCallRecord & { createdAt: string; chapterTitle: string | null }>> {
  const r = await d.query(
    `select a.*, c.title_src as chapter_title from api_calls a
     left join chapters c on c.id = a.chapter_id
     order by a.created_at desc limit $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    jobId: row.job_id == null ? null : String(row.job_id),
    chapterId: row.chapter_id == null ? null : String(row.chapter_id),
    bookId: row.book_id == null ? null : String(row.book_id),
    purpose: String(row.purpose) as ApiCallRecord["purpose"],
    idemKey: row.idem_key == null ? null : String(row.idem_key),
    model: String(row.model),
    batch: Boolean(row.batch),
    usage: {
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheWrite5mTokens: num(row.cache_write_5m),
      cacheWrite1hTokens: num(row.cache_write_1h),
      cacheReadTokens: num(row.cache_read),
    },
    stopReason: row.stop_reason == null ? null : String(row.stop_reason),
    usd: num(row.usd),
    createdAt: iso(row.created_at),
    chapterTitle: row.chapter_title == null ? null : String(row.chapter_title),
  }));
}
