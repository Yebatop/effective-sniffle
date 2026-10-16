/**
 * Чистые помощники глоссария: разделы, «другие имена» списком через запятую.
 */

import type { Term, TermKind } from "../types";

export const KIND_ORDER: readonly TermKind[] = ["name", "title", "technique", "place", "org", "item", "other"];

export const KIND_LABELS: Record<TermKind, string> = {
  name: "Имена",
  title: "Титулы и обращения",
  technique: "Техники и навыки",
  place: "Места",
  org: "Организации",
  item: "Предметы",
  other: "Прочее",
};

/** Разделить «Gu, Master Gu ,, » → ["Gu", "Master Gu"] (без повторов). */
export function parseAliases(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[,;\n]/)) {
    const v = part.trim().replace(/\s+/g, " ");
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function formatAliases(list: readonly string[] | null | undefined): string {
  return (list ?? []).join(", ");
}

/** Термины по разделам в постоянном порядке; внутри — по английскому написанию. */
export function groupTerms(terms: readonly Term[]): Array<{ kind: TermKind; label: string; terms: Term[] }> {
  const by = new Map<TermKind, Term[]>();
  for (const t of terms) {
    const kind: TermKind = KIND_ORDER.indexOf(t.kind) >= 0 ? t.kind : "other";
    const list = by.get(kind);
    if (list) list.push(t);
    else by.set(kind, [t]);
  }
  const out: Array<{ kind: TermKind; label: string; terms: Term[] }> = [];
  for (const kind of KIND_ORDER) {
    const list = by.get(kind);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => a.en.localeCompare(b.en, "en", { sensitivity: "base" }));
    out.push({ kind, label: KIND_LABELS[kind], terms: list });
  }
  return out;
}
