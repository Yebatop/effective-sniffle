/**
 * Оглавление книги: свои главы и главы готового перевода, по номеру. На
 * один номер — одна строка: свой перевод (или начатый), иначе готовый
 * перевод, иначе глава без перевода (её откроет читалка с карточкой
 * «Перевести»). Своих глав одного номера несколько (добавлена повторно) —
 * свои показываем все, готовая тогда не нужна.
 */

import { readyHref } from "../core/ready";
import type { Chapter, ReadyHead } from "../types";

export interface TocRow {
  key: string;
  number: number | null;
  title: string;
  href: string;
  kind: "own" | "ready" | "source";
}

export function tocRows(bookId: string, chapters: Array<Chapter & { translated: boolean; started?: boolean }>, ready: ReadyHead[]): TocRow[] {
  const readyBy = new Map(ready.map((r) => [r.number, r]));
  const rows: TocRow[] = [];
  // Номера, где готовая глава не нужна: есть свой перевод или начатый.
  const usedReady = new Set<number>();
  for (const c of chapters) if (c.number !== null && (c.translated || c.started)) usedReady.add(c.number);
  for (const c of chapters) {
    const r = c.number !== null ? readyBy.get(c.number) : undefined;
    if (r && !usedReady.has(r.number)) {
      usedReady.add(r.number);
      rows.push({ key: `r${r.number}`, number: r.number, title: r.title || c.titleSrc, href: readyHref(bookId, r.number), kind: "ready" });
      continue;
    }
    rows.push({
      key: c.id,
      number: c.number,
      title: c.titleSrc,
      href: `/read/${encodeURIComponent(c.id)}`,
      kind: c.translated ? "own" : "source",
    });
  }
  for (const r of ready) {
    if (usedReady.has(r.number)) continue;
    rows.push({ key: `r${r.number}`, number: r.number, title: r.title, href: readyHref(bookId, r.number), kind: "ready" });
  }
  return rows.sort((a, b) => {
    if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
    if (a.number === null && b.number !== null) return 1;
    if (a.number !== null && b.number === null) return -1;
    return 0;
  });
}

