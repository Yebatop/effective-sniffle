/**
 * Готовый перевод книги: главы чужого русского перевода (ref_chapters) и
 * имена из них (ref_terms). Главы нужны для глоссария и как образец стиля
 * перед первой своей главой, а ещё читаются в Толмаче как главы книги
 * (/book/:id/ready/:number).
 */

import type { Db } from "./client";
import { contentHash } from "./books";
import { toRefTerm } from "./rows";
import type { Gender, RefBookItem, RefTerm, TermKind } from "../types";

const KINDS: TermKind[] = ["name", "title", "technique", "place", "org", "item", "other"];
const GENDERS: Gender[] = ["m", "f", "n", "unknown"];

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const low = (s: string) => tidy(s).toLowerCase();

function countWordsRu(paragraphs: string[]): number {
  let n = 0;
  for (const p of paragraphs) n += (p.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;
  return n;
}

export interface RefChapterRow {
  id: string;
  number: number;
  title: string;
  paragraphs: string[];
  words: number;
  /** Хеш текста на момент чтения: глава, дописанная за это время, не помечается прочитанной. */
  sha: string;
  /** Читать только одну, без соседей. */
  scanAlone: boolean;
}

export interface RefWriteResult {
  created: boolean;
  updated: boolean;
  /** Под этим номером уже глава с другого адреса и с другим текстом — не затираем. */
  conflict?: boolean;
}

function toRefChapterRow(row: Record<string, unknown>): RefChapterRow {
  return {
    id: String(row.id),
    number: Number(row.number),
    title: String(row.title ?? ""),
    paragraphs: Array.isArray(row.paragraphs) ? (row.paragraphs as unknown[]).map(String) : [],
    words: Number(row.words ?? 0),
    sha: String(row.content_sha256 ?? ""),
    scanAlone: Boolean(row.scan_alone),
  };
}

/**
 * Записать главу готового перевода. Та же глава с тем же текстом — ничего
 * не меняется; с того же адреса, но с другим текстом — заменяется и будет
 * прочитана заново. Под номером уже глава с другого адреса и с другим
 * текстом — не затираем (conflict): скорее всего, выбрана не та книга или
 * сбилась нумерация.
 */
export async function upsertRefChapter(
  d: Db,
  bookId: string,
  input: { number: number; title: string; paragraphs: string[]; url: string | null },
): Promise<RefWriteResult> {
  const sha = contentHash(input.paragraphs);
  const prev = await d.query("select urls, paragraphs, content_sha256 from ref_chapters where book_id = $1 and number = $2", [bookId, input.number]);
  const old = prev.rows[0];
  if (old) {
    const urls = Array.isArray(old.urls) ? (old.urls as unknown[]).map(String) : [];
    const paras = Array.isArray(old.paragraphs) ? (old.paragraphs as unknown[]).map(String) : [];
    // Первая часть главы, собранной из частей, пришла снова — глава уже полнее, не урезаем.
    if (urls.length > 1 && input.url && urls[0] === input.url) return { created: false, updated: false };
    if (startsWith(paras, input.paragraphs) && paras.length > input.paragraphs.length) return { created: false, updated: false };
    if (urls.length > 0 && input.url && !urls.includes(input.url) && String(old.content_sha256) !== sha) {
      return { created: false, updated: false, conflict: true };
    }
  }
  const r = await d.query(
    `insert into ref_chapters (book_id, number, title, paragraphs, words, url, urls, content_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (book_id, number) do update
       set title = excluded.title, paragraphs = excluded.paragraphs, words = excluded.words,
           url = excluded.url, urls = excluded.urls, content_sha256 = excluded.content_sha256, scanned = false, updated_at = now()
       where ref_chapters.content_sha256 <> excluded.content_sha256
     returning (xmax = 0) as created`,
    [bookId, input.number, tidy(input.title).slice(0, 500), input.paragraphs, countWordsRu(input.paragraphs), input.url, input.url ? [input.url] : [], sha],
  );
  const row = r.rows[0];
  if (!row) return { created: false, updated: false };
  return row.created ? { created: true, updated: false } : { created: false, updated: true };
}

/**
 * Дописать часть главы («Глава 5.2» после «5.1»): абзацы — в конец, адрес
 * части запоминается. Та же часть второй раз не дописывается. Главы ещё
 * нет — часть становится её началом.
 */
export async function appendRefChapterPart(
  d: Db,
  bookId: string,
  input: { number: number; title: string; paragraphs: string[]; url: string | null },
  opts: { linked: boolean } = { linked: true },
): Promise<RefWriteResult> {
  const existing = await d.query("select paragraphs, urls from ref_chapters where book_id = $1 and number = $2 for update", [bookId, input.number]);
  const row = existing.rows[0];
  if (!row) return upsertRefChapter(d, bookId, input);
  const urls = Array.isArray(row.urls) ? (row.urls as unknown[]).map(String) : [];
  if (input.url && urls.includes(input.url)) return { created: false, updated: false };
  // Связь с прошлой главой не установлена (обход начат с середины, а «назад»
  // не ведёт в эту книгу) — дописывать к чужому тексту нельзя: скорее всего,
  // выбрана не та книга.
  if (!opts.linked && urls.length > 0) return { created: false, updated: false, conflict: true };
  const paragraphs = [...(Array.isArray(row.paragraphs) ? (row.paragraphs as unknown[]).map(String) : []), ...input.paragraphs];
  await d.query(
    `update ref_chapters set paragraphs = $3, words = $4, urls = $5, content_sha256 = $6, scanned = false, updated_at = now()
     where book_id = $1 and number = $2`,
    [bookId, input.number, paragraphs, countWordsRu(paragraphs), input.url ? [...urls, input.url] : urls, contentHash(paragraphs)],
  );
  return { created: false, updated: true };
}

/**
 * Дописать часть в начало главы («5.1», когда «5.2» уже взята — обход
 * начинали со второй части).
 */
export async function prependRefChapterPart(
  d: Db,
  bookId: string,
  input: { number: number; title: string; paragraphs: string[]; url: string | null },
): Promise<RefWriteResult> {
  const existing = await d.query("select paragraphs, urls from ref_chapters where book_id = $1 and number = $2 for update", [bookId, input.number]);
  const row = existing.rows[0];
  if (!row) return upsertRefChapter(d, bookId, input);
  const urls = Array.isArray(row.urls) ? (row.urls as unknown[]).map(String) : [];
  if (input.url && urls.includes(input.url)) return { created: false, updated: false };
  const paragraphs = [...input.paragraphs, ...(Array.isArray(row.paragraphs) ? (row.paragraphs as unknown[]).map(String) : [])];
  await d.query(
    `update ref_chapters set title = $3, paragraphs = $4, words = $5, url = $6, urls = $7, content_sha256 = $8, scanned = false, updated_at = now()
     where book_id = $1 and number = $2`,
    [bookId, input.number, tidy(input.title).slice(0, 500), paragraphs, countWordsRu(paragraphs), input.url, input.url ? [input.url, ...urls] : urls, contentHash(paragraphs)],
  );
  return { created: false, updated: true };
}

function startsWith(all: string[], head: string[]): boolean {
  if (head.length === 0 || head.length > all.length) return false;
  for (let i = 0; i < head.length; i++) if (all[i] !== head[i]) return false;
  return true;
}

export async function refCounts(d: Db, bookId: string): Promise<{ count: number; minNumber: number | null; maxNumber: number | null; unscanned: number; unscannedWords: number }> {
  const r = await d.query(
    `select count(*)::int as count, min(number) as min, max(number) as max,
            count(*) filter (where not scanned)::int as unscanned,
            coalesce(sum(words) filter (where not scanned), 0)::int as unscanned_words
     from ref_chapters where book_id = $1`,
    [bookId],
  );
  const row = r.rows[0] ?? {};
  return {
    count: Number(row.count ?? 0),
    minNumber: row.min == null ? null : Number(row.min),
    maxNumber: row.max == null ? null : Number(row.max),
    unscanned: Number(row.unscanned ?? 0),
    unscannedWords: Number(row.unscanned_words ?? 0),
  };
}

/** Следующие непрочитанные главы по порядку номеров. */
export async function unscannedRefChapters(d: Db, bookId: string, limit: number): Promise<RefChapterRow[]> {
  const r = await d.query(
    `select id, number, title, paragraphs, words, content_sha256, scan_alone
     from ref_chapters where book_id = $1 and not scanned order by number limit $2`,
    [bookId, limit],
  );
  return r.rows.map(toRefChapterRow);
}

/** Пометить прочитанными — только если текст не поменялся с начала чтения (кнопка могла дописать часть). */
export async function markScanned(d: Db, items: Array<{ id: string; sha: string }>): Promise<number> {
  if (items.length === 0) return 0;
  const r = await d.query(
    `update ref_chapters rc set scanned = true, updated_at = now()
     from unnest($1::uuid[], $2::text[]) as x(id, sha)
     where rc.id = x.id and rc.content_sha256 = x.sha`,
    [items.map((i) => i.id), items.map((i) => i.sha)],
  );
  return r.rowCount ?? 0;
}

/** Эти главы впредь читать по одной. */
export async function markScanAlone(d: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await d.query("update ref_chapters set scan_alone = true where id = any($1::uuid[])", [ids]);
}

/** Номер главы готового перевода, взятой с этого адреса (или null). */
export async function refNumberByUrl(d: Db, bookId: string, url: string): Promise<number | null> {
  const r = await d.query(
    "select number from ref_chapters where book_id = $1 and (url = $2 or $2 = any(urls)) order by number desc limit 1",
    [bookId, url],
  );
  return r.rows[0] ? Number(r.rows[0].number) : null;
}

/** Главы готового перевода книги без текста — для оглавления. */
export async function listRefHeads(d: Db, bookId: string): Promise<Array<{ number: number; title: string; words: number }>> {
  const r = await d.query("select number, title, words from ref_chapters where book_id = $1 order by number", [bookId]);
  return r.rows.map((row) => ({ number: Number(row.number), title: String(row.title ?? ""), words: Number(row.words ?? 0) }));
}

/** Номера глав готового перевода книги. */
export async function refNumbers(d: Db, bookId: string): Promise<Set<number>> {
  const r = await d.query("select number from ref_chapters where book_id = $1", [bookId]);
  return new Set(r.rows.map((row) => Number(row.number)));
}

/** Глава готового перевода для чтения. */
export async function getRefChapterByNumber(
  d: Db,
  bookId: string,
  number: number,
): Promise<{ number: number; title: string; paragraphs: string[]; words: number; url: string | null } | null> {
  const r = await d.query("select number, title, paragraphs, words, url from ref_chapters where book_id = $1 and number = $2", [bookId, number]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    number: Number(row.number),
    title: String(row.title ?? ""),
    paragraphs: Array.isArray(row.paragraphs) ? (row.paragraphs as unknown[]).map(String) : [],
    words: Number(row.words ?? 0),
    url: row.url == null ? null : String(row.url),
  };
}

/** Заголовок главы готового перевода с этим номером (или null). */
export async function refTitle(d: Db, bookId: string, number: number): Promise<string | null> {
  const r = await d.query("select title from ref_chapters where book_id = $1 and number = $2", [bookId, number]);
  return r.rows[0] ? String(r.rows[0].title ?? "") : null;
}

/**
 * Пары для сверки: номера глав, которые есть и по-английски (в книге), и в
 * готовом переводе. Сначала последние — в них нынешние герои.
 */
export async function refPairs(d: Db, bookId: string, limit: number): Promise<Array<{ number: number; chapterId: string; refId: string }>> {
  const r = await d.query(
    `select distinct on (c.number) c.number, c.id as chapter_id, rc.id as ref_id
     from chapters c join ref_chapters rc on rc.book_id = c.book_id and rc.number = c.number
     where c.book_id = $1 and c.number is not null
     order by c.number desc, c.created_at desc
     limit $2`,
    [bookId, limit],
  );
  return r.rows.map((row) => ({ number: Number(row.number), chapterId: String(row.chapter_id), refId: String(row.ref_id) }));
}

/** Пара для сверки по номеру главы (если главы с тех пор не удалили). */
export async function refPairByNumber(d: Db, bookId: string, number: number): Promise<{ number: number; chapterId: string; refId: string } | null> {
  const r = await d.query(
    `select c.number, c.id as chapter_id, rc.id as ref_id
     from chapters c join ref_chapters rc on rc.book_id = c.book_id and rc.number = c.number
     where c.book_id = $1 and c.number = $2
     order by c.created_at desc limit 1`,
    [bookId, number],
  );
  const row = r.rows[0];
  return row ? { number: Number(row.number), chapterId: String(row.chapter_id), refId: String(row.ref_id) } : null;
}

export async function refPairCount(d: Db, bookId: string): Promise<number> {
  const r = await d.query(
    `select count(distinct c.number)::int as n
     from chapters c join ref_chapters rc on rc.book_id = c.book_id and rc.number = c.number
     where c.book_id = $1 and c.number is not null`,
    [bookId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function getRefChapter(d: Db, id: string): Promise<RefChapterRow | null> {
  const r = await d.query("select id, number, title, paragraphs, words, content_sha256, scan_alone from ref_chapters where id = $1", [id]);
  return r.rows[0] ? toRefChapterRow(r.rows[0]) : null;
}

/** Последние абзацы главы готового перевода с этим номером — образец стиля перед своей главой. */
export async function refTail(d: Db, bookId: string, number: number, count: number): Promise<string[]> {
  const r = await d.query("select paragraphs from ref_chapters where book_id = $1 and number = $2", [bookId, number]);
  const paras = r.rows[0] && Array.isArray(r.rows[0].paragraphs) ? (r.rows[0].paragraphs as unknown[]).map(String) : [];
  return paras.slice(-count);
}

export interface RefTermProposal {
  ru: string;
  kind: TermKind;
  gender?: Gender | null;
  note?: string | null;
  /** Номера глав, где встретилось. */
  numbers: number[];
}

/**
 * Слить имена из прочитанных глав: новое — добавить, известное — +число
 * глав, где встретилось, раздвинуть первую/последнюю главу, заполнить
 * пустые род и заметку. Повтор той же пачки (после обрыва) лишь немного
 * завысит счётчик — он нужен только для порядка подсказок.
 */
export async function mergeRefTerms(d: Db, bookId: string, proposals: RefTermProposal[]): Promise<number> {
  let added = 0;
  const seen = new Set<string>();
  for (const p of proposals) {
    const ru = tidy(p.ru);
    if (!ru || ru.length > 120 || seen.has(low(ru))) continue;
    seen.add(low(ru));
    const kind = KINDS.includes(p.kind) ? p.kind : "other";
    const gender = kind === "name" && p.gender && GENDERS.includes(p.gender) ? p.gender : null;
    const numbers = p.numbers.filter((n) => Number.isFinite(n));
    const first = numbers.length ? Math.min(...numbers) : null;
    const last = numbers.length ? Math.max(...numbers) : null;
    const r = await d.query(
      `insert into ref_terms (book_id, ru, kind, gender, note, mentions, first_number, last_number)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (book_id, lower(ru)) do update set
         mentions = ref_terms.mentions + excluded.mentions,
         first_number = least(coalesce(ref_terms.first_number, excluded.first_number), coalesce(excluded.first_number, ref_terms.first_number)),
         last_number = greatest(coalesce(ref_terms.last_number, excluded.last_number), coalesce(excluded.last_number, ref_terms.last_number)),
         gender = coalesce(ref_terms.gender, excluded.gender),
         note = coalesce(ref_terms.note, excluded.note),
         updated_at = now()
       returning (xmax = 0) as created`,
      [bookId, ru, kind, gender, tidy(p.note).slice(0, 200) || null, Math.max(1, numbers.length), first, last],
    );
    if (r.rows[0]?.created) added += 1;
  }
  return added;
}

/**
 * Связать имена готового перевода с терминами глоссария по русскому
 * написанию (без учёта регистра). Написание в глоссарии одно — связать,
 * какого бы рода ни были записи (модели по-разному решают, место это или
 * организация). Терминов с таким написанием несколько («Тень» — прозвище и
 * приём) — связать только с тем, что того же рода. Связанное перестаёт
 * быть подсказкой.
 */
export async function linkRefTerms(d: Db, bookId: string): Promise<number> {
  const r = await d.query(
    `with grouped as (
       select id, lower(ru) as ru_l,
              case when kind in ('name','title') then 'person' else kind end as grp
       from terms where book_id = $1
     ),
     by_spelling as (
       select ru_l, count(*) as n, min(id::text)::uuid as id from grouped group by ru_l
     ),
     by_kind as (
       select ru_l, grp, min(id::text)::uuid as id from grouped group by ru_l, grp having count(*) = 1
     ),
     pick as (
       select rt.id as ref_id,
              case when s.n = 1 then s.id else k.id end as term_id
       from ref_terms rt
       join by_spelling s on s.ru_l = lower(rt.ru)
       left join by_kind k on k.ru_l = lower(rt.ru)
         and k.grp = (case when rt.kind in ('name','title') then 'person' else rt.kind end)
       where rt.book_id = $1 and rt.term_id is null
     )
     update ref_terms rt set term_id = p.term_id, updated_at = now()
     from pick p
     where rt.id = p.ref_id and p.term_id is not null`,
    [bookId],
  );
  return r.rowCount ?? 0;
}

/**
 * Подсказки для разбора новой главы: ещё не сопоставленные имена. Сначала
 * встречавшиеся недавно и часто — они вероятнее появятся дальше.
 */
export async function refHints(d: Db, bookId: string, limit: number): Promise<RefTerm[]> {
  const r = await d.query(
    `select * from ref_terms where book_id = $1 and term_id is null
     order by last_number desc nulls last, mentions desc, lower(ru)
     limit $2`,
    [bookId, limit],
  );
  return r.rows.map(toRefTerm);
}

export async function listRefTerms(d: Db, bookId: string): Promise<RefTerm[]> {
  const r = await d.query("select * from ref_terms where book_id = $1 order by lower(ru)", [bookId]);
  return r.rows.map(toRefTerm);
}

export async function refTermCounts(d: Db, bookId: string): Promise<{ hints: number; matched: number }> {
  const r = await d.query(
    `select count(*) filter (where term_id is null)::int as hints, count(*) filter (where term_id is not null)::int as matched
     from ref_terms where book_id = $1`,
    [bookId],
  );
  return { hints: Number(r.rows[0]?.hints ?? 0), matched: Number(r.rows[0]?.matched ?? 0) };
}

/** Убрать готовый перевод книги целиком (глоссарий остаётся). */
export async function deleteReference(d: Db, bookId: string): Promise<void> {
  await d.query("delete from ref_terms where book_id = $1", [bookId]);
  await d.query("delete from ref_chapters where book_id = $1", [bookId]);
}

/** Книги для выбора в кнопке на русском сайте: свежие сверху. */
export async function listRefBooks(d: Db): Promise<RefBookItem[]> {
  const r = await d.query(
    `select b.id, b.title,
            (select count(*)::int from chapters c where c.book_id = b.id) as chapters,
            (select count(*)::int from ref_chapters rc where rc.book_id = b.id) as ref_chapters
     from books b
     order by b.updated_at desc
     limit 100`,
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    chapters: Number(row.chapters ?? 0),
    refChapters: Number(row.ref_chapters ?? 0),
  }));
}
