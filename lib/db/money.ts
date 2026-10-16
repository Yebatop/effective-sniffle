/**
 * Бюджет и журнал расходов.
 *
 * Перед каждым вызовом модели резервируется худшая цена; после — резерв
 * закрывается фактом. Резерв атомарен: два устройства не перелетят лимит.
 */

import type { Db } from "./client";
import type { BudgetState, ModelId, Usage } from "../types";

/** "2026-10" по UTC. */
export function monthKey(date?: Date): string {
  throw new Error("not implemented");
}

/** Зарезервировать; false — не хватает лимита. */
export async function reserve(d: Db, usd: number, limitUsd: number, month?: string): Promise<boolean> {
  throw new Error("not implemented");
}

/** Закрыть резерв фактом: reserved -= reservedUsd, spent += actualUsd. */
export async function settle(d: Db, reservedUsd: number, actualUsd: number, month?: string): Promise<void> {
  throw new Error("not implemented");
}

export async function budgetState(d: Db, limitUsd: number, month?: string): Promise<BudgetState> {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

export async function spendByBook(d: Db, month?: string): Promise<Array<{ bookId: string | null; title: string | null; usd: number; calls: number }>> {
  throw new Error("not implemented");
}

export async function recentCalls(d: Db, limit: number): Promise<Array<ApiCallRecord & { createdAt: string; chapterTitle: string | null }>> {
  throw new Error("not implemented");
}
