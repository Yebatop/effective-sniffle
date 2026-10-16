/**
 * Глоссарий в промпте: только термины, которые встречаются в переводимом
 * тексте (по en и aliases, без учёта регистра, по границам слов), плюс
 * обращения «ты/вы» между персонажами, которые есть в тексте.
 * Порядок детерминирован (по en), чтобы одинаковый вход давал одинаковый текст.
 */

import type { Address, Gender, Term, TermKind } from "../types";

/** Сравнение по en без учёта регистра, затем точное, затем id — без зависимости от локали. */
export function compareByEn(a: Term, b: Term): number {
  const al = a.en.toLowerCase();
  const bl = b.en.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.en !== b.en) return a.en < b.en ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Шаблон имени: границы — не буква и не цифра (Unicode), пробелы внутри — любые. */
function namePattern(name: string): RegExp {
  const body = name
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Термины, встречающиеся в тексте. Длинные имена ищутся первыми и занимают
 * свой кусок текста: «Azure Cloud Sect» не тянет за собой отдельный термин
 * «Sect», если «Sect» встречается только внутри длинного названия.
 * Имена короче 2 символов не ищутся — слишком много случайных совпадений.
 */
export function termsInText(terms: Term[], text: string): Term[] {
  if (!text || terms.length === 0) return [];

  const candidates: Array<{ term: Term; name: string }> = [];
  for (const term of terms) {
    const names = new Set([term.en, ...(term.aliases ?? [])].map((s) => s.trim()).filter((s) => s.length >= 2));
    for (const name of names) candidates.push({ term, name });
  }
  candidates.sort((a, b) => b.name.length - a.name.length || compareByEn(a.term, b.term) || (a.name < b.name ? -1 : 1));

  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && end > s);
  const found = new Map<string, Term>();

  for (const { term, name } of candidates) {
    for (const m of text.matchAll(namePattern(name))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      found.set(term.id, term);
    }
  }
  return [...found.values()].sort(compareByEn);
}

/**
 * Обращения, где оба персонажа есть среди `present`; учитывает fromChapter ≤ chapterNumber.
 *
 * На пару (кто → кому) остаётся одно обращение — самое позднее из
 * действующих. Номер главы неизвестен (вставленный текст) — считаем главу
 * свежей: действует последнее правило. Такие главы читатель берёт по ходу
 * чтения, то есть позже, чем собран глоссарий.
 */
export function addressesFor(addresses: Address[], present: Term[], chapterNumber: number | null): Address[] {
  const byId = new Map(present.map((t) => [t.id, t]));
  const best = new Map<string, Address>();

  for (const a of addresses) {
    if (!byId.has(a.fromTermId) || !byId.has(a.toTermId) || a.fromTermId === a.toTermId) continue;
    if (a.fromChapter !== null && chapterNumber !== null && a.fromChapter > chapterNumber) continue;
    const key = `${a.fromTermId}\u0000${a.toTermId}`;
    const prev = best.get(key);
    if (!prev || laterRule(a, prev)) best.set(key, a);
  }

  const name = (id: string) => byId.get(id)?.en.toLowerCase() ?? "";
  return [...best.values()].sort((a, b) => {
    const fa = name(a.fromTermId);
    const fb = name(b.fromTermId);
    if (fa !== fb) return fa < fb ? -1 : 1;
    const ta = name(a.toTermId);
    const tb = name(b.toTermId);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** a действует позже b: больший fromChapter; при равенстве проверенное важнее предложенного. */
function laterRule(a: Address, b: Address): boolean {
  const ca = a.fromChapter ?? -Infinity;
  const cb = b.fromChapter ?? -Infinity;
  if (ca !== cb) return ca > cb;
  if (a.status !== b.status) return a.status === "checked";
  return a.id > b.id;
}

const KIND_RU: Record<TermKind, string | null> = {
  name: "имя",
  title: "титул",
  technique: "техника",
  place: "место",
  org: "организация",
  item: "предмет",
  other: null,
};

const GENDER_RU: Record<Gender, string | null> = { m: "м", f: "ж", n: "ср", unknown: null };

/** Перевод строк и лишние пробелы ломают построчный формат блока. */
function oneLine(s: string): string {
  return s.replace(/[⟦⟧]/g, (c) => (c === "⟦" ? "[" : "]")).replace(/\s+/g, " ").trim();
}

function termLine(t: Term): string {
  const aliases = [...new Set((t.aliases ?? []).map(oneLine).filter((a) => a && a.toLowerCase() !== t.en.toLowerCase()))].sort();
  const also = aliases.length > 0 ? ` (также: ${aliases.join(", ")})` : "";
  const tags = [KIND_RU[t.kind], t.kind === "name" && t.gender ? GENDER_RU[t.gender] : null].filter(Boolean);
  const kind = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  const note = t.note && oneLine(t.note) ? ` — ${oneLine(t.note)}` : "";
  const proposed = t.status === "proposed" ? " [предложено]" : "";
  return `- ${oneLine(t.en)}${also} → ${oneLine(t.ru)}${kind}${note}${proposed}`;
}

/** Блок для промпта: термины («en → ru (вид, род) — пометка»), затем «КТО К КОМУ». Предложенные помечены. */
export function renderGlossaryBlock(terms: Term[], addresses: Address[], allTerms: Term[]): string {
  const sections: string[] = [];

  const usable = terms.filter((t) => oneLine(t.en) && oneLine(t.ru)).sort(compareByEn);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of usable) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    lines.push(termLine(t));
  }
  if (lines.length > 0) sections.push(`ТЕРМИНЫ\n${lines.join("\n")}`);

  const byId = new Map(allTerms.map((t) => [t.id, t]));
  const pairs: Array<{ from: Term; to: Term; a: Address }> = [];
  for (const a of addresses) {
    const from = byId.get(a.fromTermId);
    const to = byId.get(a.toTermId);
    if (from && to) pairs.push({ from, to, a });
  }
  pairs.sort((x, y) => compareByEn(x.from, y.from) || compareByEn(x.to, y.to) || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0));
  const addressLines = pairs.map(({ from, to, a }) => {
    const form = a.form === "ty" ? "«ты»" : "«вы»";
    const proposed = a.status === "proposed" ? " [предложено]" : "";
    return `- ${oneLine(from.en)} → ${oneLine(to.en)}: ${form}${proposed}`;
  });
  if (addressLines.length > 0) sections.push(`КТО К КОМУ ОБРАЩАЕТСЯ (первый говорит второму)\n${addressLines.join("\n")}`);

  return sections.join("\n\n");
}
