/**
 * Числа, деньги и даты для экранов.
 *
 * Цены считает ядро (lib/core/cost.ts). Если оценка не получилась —
 * цену просто не показываем, а не рисуем выдуманную.
 */

import { estimateTranslationUsd, formatRub } from "../core/cost";
import { MODELS } from "../core/models";
import type { Effort, ModelId } from "../types";

/** «1 глава», «3 главы», «11 глав». */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count));
  if (n % 100 >= 11 && n % 100 <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function num(n: number): string {
  try {
    return n.toLocaleString("ru-RU");
  } catch {
    return String(n);
  }
}

/** Запасная запись рублей, если ядро ещё не умеет: «≈ 3,5 ₽». */
export function fallbackRub(usd: number, usdRub: number): string {
  const r = usd * usdRub;
  if (!Number.isFinite(r)) return "—";
  const digits = r >= 100 ? 0 : r >= 10 ? 1 : r >= 1 ? 1 : 2;
  const s = r.toFixed(digits).replace(".", ",");
  return `≈ ${s} ₽`;
}

/** Доллары → «≈ 3,5 ₽» по курсу из настроек. */
export function rub(usd: number, usdRub: number): string {
  try {
    const s = formatRub(usd, usdRub);
    if (typeof s === "string" && s) return s;
  } catch {
    // ядро ещё не готово — запишем сами
  }
  return fallbackRub(usd, usdRub);
}

/** Рубли без «≈» — для мест, где знак уже стоит рядом. */
export function rubBare(usd: number, usdRub: number): string {
  return rub(usd, usdRub).replace(/^≈\s*/, "");
}

/** Оценка цены перевода главы или null, если посчитать не вышло. */
export function estimateRub(model: ModelId | null | undefined, words: number, usdRub: number, effort?: Effort): string | null {
  if (!model || !(model in MODELS) || !Number.isFinite(words) || words <= 0) return null;
  try {
    const usd = estimateTranslationUsd(model, words, effort ? { effort } : undefined);
    if (!Number.isFinite(usd) || usd < 0) return null;
    return rub(usd, usdRub);
  } catch {
    return null;
  }
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const spec = (MODELS as Record<string, { label: string } | undefined>)[id];
  if (spec) return spec.label;
  // В расходах может быть полный id ответа вида claude-sonnet-5-5-20261001.
  for (const key of Object.keys(MODELS)) {
    if (id.startsWith(key)) return MODELS[key as ModelId].label;
  }
  return id;
}

/** «16 окт, 14:05» — коротко, в часовом поясе устройства. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Глава для подписи: «Глава 12 · Название» или просто название. */
export function chapterLabel(number: number | null | undefined, title: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (number === null || number === undefined) return t || "Глава без названия";
  if (!t) return `Глава ${number}`;
  // Название уже начинается с номера («Chapter 12: …») — не дублируем.
  if (new RegExp(`^(chapter|ch\\.?|глава)\\s*${number}\\b`, "i").test(t)) return t;
  return `Глава ${number} · ${t}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, "") + "…";
}
