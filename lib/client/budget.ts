/**
 * Полоса бюджета: доли «потрачено» и «занято под идущие переводы» от лимита.
 */

import type { BudgetState } from "../types";

export interface BudgetShares {
  /** 0..1 — потрачено. */
  spent: number;
  /** 0..1 — занято под идущие переводы (после потраченного). */
  reserved: number;
  /** Потрачено + занято больше лимита. */
  over: boolean;
}

export function budgetShares(b: Pick<BudgetState, "limitUsd" | "spentUsd" | "reservedUsd">): BudgetShares {
  const limit = Number.isFinite(b.limitUsd) && b.limitUsd > 0 ? b.limitUsd : 0;
  const spent = Math.max(0, b.spentUsd || 0);
  const reserved = Math.max(0, b.reservedUsd || 0);
  if (limit === 0) return { spent: spent > 0 ? 1 : 0, reserved: 0, over: spent + reserved > 0 };
  const s = Math.min(1, spent / limit);
  const r = Math.min(1 - s, reserved / limit);
  return { spent: s, reserved: r, over: spent + reserved >= limit };
}

/** «октябрь 2026» из «2026-10». */
export function monthName(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!m) return month || "";
  const names = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
  ];
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${names[i]} ${m[1]}` : month;
}
