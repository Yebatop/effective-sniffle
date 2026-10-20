/** Глоссарий — строки, не документ: правки и слияние идут по строкам. */

import type { Db } from "./client";
import { num, toAddress, toTerm } from "./rows";
import type { Address, Gender, Term, TermKind, TermStatus } from "../types";

export async function listTerms(d: Db, bookId: string): Promise<Term[]> {
  const r = await d.query("select * from terms where book_id = $1 order by lower(en)", [bookId]);
  return r.rows.map(toTerm);
}
export async function listAddresses(d: Db, bookId: string): Promise<Address[]> {
  const r = await d.query("select * from addresses where book_id = $1 order by created_at", [bookId]);
  return r.rows.map(toAddress);
}

export interface ProposedTerm {
  en: string;
  ru: string;
  kind: TermKind;
  gender?: Gender | null;
  aliases?: string[];
  note?: string | null;
}
export interface ProposedAddress {
  fromEn: string;
  toEn: string;
  form: "ty" | "vy";
  fromChapter?: number | null;
}

const KINDS: TermKind[] = ["name", "title", "technique", "place", "org", "item", "other"];
const GENDERS: Gender[] = ["m", "f", "n", "unknown"];

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const low = (s: string) => tidy(s).toLowerCase();

/**
 * Слить предложения модели: новый термин добавляется, только если его en
 * (без учёта регистра) нет ни среди en, ни среди aliases книги; к
 * существующему термину добавляются новые aliases, пустой gender
 * заполняется; status=checked модель не меняет никогда. Обращения: по en
 * (или alias) находятся term id; неизвестные имена пропускаются; пара уже
 * есть — не трогать. Если что-то добавлено — glossary_version книги +1.
 */
export async function mergeProposals(
  d: Db,
  bookId: string,
  chapterId: string,
  terms: ProposedTerm[],
  addresses: ProposedAddress[],
): Promise<{ addedTerms: number; addedAddresses: number; glossaryVersion: number }> {
  const existing = await listTerms(d, bookId);
  const byName = new Map<string, Term>();
  const index = (t: Term) => {
    byName.set(low(t.en), t);
    for (const a of t.aliases) if (!byName.has(low(a))) byName.set(low(a), t);
  };
  existing.forEach(index);

  let changed = false;
  let addedTerms = 0;
  const seen = new Set<string>();
  for (const p of terms) {
    const en = tidy(p.en);
    const ru = tidy(p.ru);
    if (!en || !ru || seen.has(low(en))) continue;
    seen.add(low(en));
    const kind = KINDS.includes(p.kind) ? p.kind : "other";
    const gender = kind === "name" && p.gender && GENDERS.includes(p.gender) ? p.gender : null;
    const aliases = Array.from(new Set((p.aliases ?? []).map(tidy).filter((a) => a && low(a) !== low(en))));

    const known = byName.get(low(en));
    if (known) {
      if (known.status === "checked") continue;
      const have = new Set([low(known.en), ...known.aliases.map(low)]);
      const newAliases = aliases.filter((a) => !have.has(low(a)) && !byName.has(low(a)));
      const fillGender = known.kind === "name" && !known.gender && gender ? gender : null;
      if (newAliases.length === 0 && !fillGender) continue;
      const r = await d.query(
        `update terms set aliases = aliases || $2::text[], gender = coalesce(gender, $3), updated_at = now()
         where id = $1 and status <> 'checked' returning *`,
        [known.id, newAliases, fillGender],
      );
      if (r.rows[0]) {
        changed = true;
        index(toTerm(r.rows[0]));
      }
      continue;
    }
    const r = await d.query(
      `insert into terms (book_id, en, ru, kind, gender, aliases, note, first_chapter_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (book_id, lower(en)) do nothing
       returning *`,
      [bookId, en, ru, kind, gender, aliases, tidy(p.note) || null, chapterId],
    );
    if (r.rows[0]) {
      changed = true;
      addedTerms += 1;
      index(toTerm(r.rows[0]));
    }
  }

  let addedAddresses = 0;
  for (const a of addresses) {
    const from = byName.get(low(a.fromEn));
    const to = byName.get(low(a.toEn));
    if (!from || !to || from.id === to.id || (a.form !== "ty" && a.form !== "vy")) continue;
    const r = await d.query(
      `insert into addresses (book_id, from_term_id, to_term_id, form, from_chapter)
       select $1, $2, $3, $4, $5
       where not exists (select 1 from addresses where from_term_id = $2 and to_term_id = $3)
       on conflict do nothing
       returning id`,
      [bookId, from.id, to.id, a.form, a.fromChapter ?? null],
    );
    if (r.rows[0]) {
      changed = true;
      addedAddresses += 1;
    }
  }

  const version = changed ? await bumpVersion(d, bookId) : await currentVersion(d, bookId);
  return { addedTerms, addedAddresses, glossaryVersion: version };
}

/**
 * Слить пары из готового перевода. Готовый перевод главнее разбора: у
 * термина, который предложила модель (auto, не проверен человеком), русское
 * написание меняется на то, что в готовом переводе. Проверенное человеком
 * не трогается никогда. Новые термины — со source = reference.
 */
export async function mergeReferenceTerms(
  d: Db,
  bookId: string,
  chapterId: string | null,
  terms: ProposedTerm[],
): Promise<{ added: number; updated: number }> {
  const existing = await listTerms(d, bookId);
  const byName = new Map<string, Term>();
  const index = (t: Term) => {
    byName.set(low(t.en), t);
    for (const a of t.aliases) if (!byName.has(low(a))) byName.set(low(a), t);
  };
  existing.forEach(index);

  let added = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const p of terms) {
    const en = tidy(p.en);
    const ru = tidy(p.ru);
    if (!en || !ru || seen.has(low(en))) continue;
    seen.add(low(en));
    const kind = KINDS.includes(p.kind) ? p.kind : "other";
    const gender = kind === "name" && p.gender && GENDERS.includes(p.gender) ? p.gender : null;
    const aliases = Array.from(new Set((p.aliases ?? []).map(tidy).filter((a) => a && low(a) !== low(en))));
    const note = tidy(p.note) || null;

    const known = byName.get(low(en));
    if (known) {
      if (known.status === "checked") continue;
      const have = new Set([low(known.en), ...known.aliases.map(low)]);
      const newAliases = aliases.filter((a) => !have.has(low(a)) && !byName.has(low(a)));
      const newRu = known.source === "auto" && low(known.ru) !== low(ru) ? ru : null;
      const fillGender = known.kind === "name" && !known.gender && gender ? gender : null;
      const fillNote = !known.note && note ? note : null;
      if (!newRu && newAliases.length === 0 && !fillGender && !fillNote) continue;
      const r = await d.query(
        `update terms set ru = coalesce($2, ru), source = case when $2::text is not null then 'reference' else source end,
           aliases = aliases || $3::text[], gender = coalesce(gender, $4), note = coalesce(note, $5), updated_at = now()
         where id = $1 and status <> 'checked' returning *`,
        [known.id, newRu, newAliases, fillGender, fillNote],
      );
      if (r.rows[0]) {
        updated += 1;
        index(toTerm(r.rows[0]));
      }
      continue;
    }
    const r = await d.query(
      `insert into terms (book_id, en, ru, kind, gender, aliases, note, first_chapter_id, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'reference')
       on conflict (book_id, lower(en)) do nothing
       returning *`,
      [bookId, en, ru, kind, gender, aliases, note, chapterId],
    );
    if (r.rows[0]) {
      added += 1;
      index(toTerm(r.rows[0]));
    }
  }
  if (added + updated > 0) await bumpVersion(d, bookId);
  return { added, updated };
}

async function bumpVersion(d: Db, bookId: string): Promise<number> {
  const r = await d.query(
    "update books set glossary_version = glossary_version + 1, updated_at = now() where id = $1 returning glossary_version",
    [bookId],
  );
  return num(r.rows[0]?.glossary_version);
}

async function currentVersion(d: Db, bookId: string): Promise<number> {
  const r = await d.query("select glossary_version from books where id = $1", [bookId]);
  return num(r.rows[0]?.glossary_version);
}

const TERM_COLUMNS = { ru: "ru", kind: "kind", gender: "gender", aliases: "aliases", note: "note", status: "status" } as const;

/** Правка человеком: ставит status=checked, glossary_version +1. */
export async function updateTerm(
  d: Db,
  id: string,
  patch: Partial<{ ru: string; kind: TermKind; gender: Gender | null; aliases: string[]; note: string | null; status: TermStatus }>,
): Promise<Term> {
  const clean: Record<string, unknown> = {};
  if (patch.ru !== undefined) {
    const ru = tidy(patch.ru);
    if (!ru) throw new Error("Перевод термина не может быть пустым.");
    clean.ru = ru;
  }
  if (patch.kind !== undefined) clean.kind = KINDS.includes(patch.kind) ? patch.kind : "other";
  if (patch.gender !== undefined) clean.gender = patch.gender && GENDERS.includes(patch.gender) ? patch.gender : null;
  if (patch.aliases !== undefined) clean.aliases = Array.from(new Set(patch.aliases.map(tidy).filter(Boolean)));
  if (patch.note !== undefined) clean.note = tidy(patch.note) || null;
  clean.status = patch.status === "proposed" ? "proposed" : "checked";

  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, column] of Object.entries(TERM_COLUMNS)) {
    if (key in clean) {
      params.push(clean[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  sets.push("updated_at = now()");
  const r = await d.query(`update terms set ${sets.join(", ")} where id = $1 returning *`, params);
  if (!r.rows[0]) throw new Error("Термин не найден.");
  const term = toTerm(r.rows[0]);
  await bumpVersion(d, term.bookId);
  return term;
}

export async function deleteTerm(d: Db, id: string): Promise<void> {
  const r = await d.query("delete from terms where id = $1 returning book_id", [id]);
  if (r.rows[0]) await bumpVersion(d, String(r.rows[0].book_id));
}

export async function setAddressForm(d: Db, id: string, form: "ty" | "vy"): Promise<void> {
  if (form !== "ty" && form !== "vy") throw new Error("Обращение — «ты» или «вы».");
  const r = await d.query("update addresses set form = $2, status = 'checked' where id = $1 returning book_id", [id, form]);
  if (r.rows[0]) await bumpVersion(d, String(r.rows[0].book_id));
}

export async function getTerm(d: Db, id: string): Promise<Term | null> {
  const r = await d.query("select * from terms where id = $1", [id]);
  return r.rows[0] ? toTerm(r.rows[0]) : null;
}
