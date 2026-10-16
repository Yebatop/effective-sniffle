/** Книги и главы: импорт без дублей, чтение для читалки и библиотеки. */

import { createHash } from "node:crypto";
import { withTx, type Db } from "./client";
import { iso, num, toBook, toChapter } from "./rows";
import { bookKeyFromUrl, chapterNumberFrom, normalizeUrl, siteOf } from "../core/url";
import { wordsIn } from "../core/words";
import type { Book, BookListItem, Chapter, ChapterSource, ExtractedChapter, Gender, Paragraph, Register } from "../types";

export interface ImportInput extends ExtractedChapter {
  source: ChapterSource;
  /** Явный выбор книги (вставка, файл). Иначе — по ключу книги из адреса. */
  bookId?: string;
}

const UNTITLED_BOOK = "Без названия";
const UNTITLED_CHAPTER = "Без названия";

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Отпечаток содержимого: одна и та же глава, взятая любым путём, даёт один хеш. */
export function contentHash(paragraphs: string[]): string {
  return createHash("sha256").update(paragraphs.map(clean).join("\n")).digest("hex");
}

function urlOrNull(raw: string | null | undefined): string | null {
  return raw ? normalizeUrl(raw) : null;
}

/**
 * Записать главу. Книга: bookId → по bookKeyFromUrl(url) → новая книга
 * (название — bookTitle или «Без названия»). Глава идемпотентна по
 * (book_id, sha256 нормализованного текста): повтор возвращает
 * существующую с created=false. Если у существующей главы не было
 * next_url/prev_url/url, а теперь есть — дополнить. Абзацы пишутся в
 * chapter_paragraphs: idx 0 — название, дальше текст.
 *
 * Тот же адрес с другим текстом (автор поправил главу, или снялось иначе)
 * не плодит вторую главу: пока перевода нет, текст заменяется; если перевод
 * уже есть, возвращается прежняя глава — чтобы не терять прочитанное.
 */
export async function importChapter(d: Db, input: ImportInput): Promise<{ chapter: Chapter; book: Book; created: boolean }> {
  const url = urlOrNull(input.url);
  const nextUrl = urlOrNull(input.nextUrl);
  const prevUrl = urlOrNull(input.prevUrl);
  const paragraphs = input.paragraphs.map(clean).filter(Boolean);
  if (paragraphs.length === 0) throw new Error("В главе нет текста.");
  const title = clean(input.chapterTitle ?? "") || UNTITLED_CHAPTER;
  const sha = contentHash(paragraphs);
  const words = paragraphs.reduce((n, p) => n + wordsIn(p), 0);

  const book = await resolveBook(d, input, url);

  // Тот же адрес в этой книге — та же глава.
  if (url) {
    const sameUrl = await d.query(
      "select * from chapters where book_id = $1 and url = $2 order by created_at limit 1",
      [book.id, url],
    );
    const existing = sameUrl.rows[0];
    if (existing) {
      const chapter = toChapter(existing);
      if (chapter.contentSha256 !== sha && !chapter.currentTranslationId) {
        const replaced = await replaceText(d, chapter.id, title, paragraphs, sha, words, nextUrl, prevUrl);
        return { chapter: replaced, book, created: false };
      }
      return { chapter: await fillLinks(d, chapter.id, url, nextUrl, prevUrl), book, created: false };
    }
  }

  const number = chapterNumberFrom(title, url);
  const texts = [title, ...paragraphs];
  // Глава и её абзацы — одним оператором: либо всё, либо ничего.
  const inserted = await d.query(
    `with c as (
       insert into chapters (book_id, number, title_src, url, next_url, prev_url, content_sha256, words, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (book_id, content_sha256) do nothing
       returning *
     ), p as (
       insert into chapter_paragraphs (chapter_id, idx, text)
       select c.id, t.ord - 1, t.text
       from c, unnest($10::text[]) with ordinality as t(text, ord)
     )
     select * from c`,
    [book.id, number, title, url, nextUrl, prevUrl, sha, words, input.source, texts],
  );
  if (inserted.rows[0]) {
    await d.query("update books set updated_at = now() where id = $1", [book.id]);
    return { chapter: toChapter(inserted.rows[0]), book, created: true };
  }

  const dup = await d.query("select id from chapters where book_id = $1 and content_sha256 = $2", [book.id, sha]);
  const id = String(dup.rows[0]?.id);
  return { chapter: await fillLinks(d, id, url, nextUrl, prevUrl), book, created: false };
}

async function resolveBook(d: Db, input: ImportInput, url: string | null): Promise<Book> {
  if (input.bookId) {
    const book = await getBook(d, input.bookId);
    if (!book) throw new Error("Книга не найдена.");
    return book;
  }
  const bookTitle = clean(input.bookTitle ?? "") || UNTITLED_BOOK;
  const cover = input.coverUrl ? urlOrNull(input.coverUrl) : null;
  const key = url ? bookKeyFromUrl(url) : null;
  if (key) {
    // Две одновременные главы одной книги не заведут две книги: ключ уникален.
    const r = await d.query(
      `insert into books (book_key, title, site, cover_url)
       values ($1, $2, $3, $4)
       on conflict (book_key) do update set
         title = case when books.title = $5 and excluded.title <> $5 then excluded.title else books.title end,
         cover_url = coalesce(books.cover_url, excluded.cover_url)
       returning *`,
      [key, bookTitle, siteOf(url), cover, UNTITLED_BOOK],
    );
    return toBook(r.rows[0]);
  }
  const r = await d.query(
    "insert into books (title, site, cover_url) values ($1, $2, $3) returning *",
    [bookTitle, siteOf(url), cover],
  );
  return toBook(r.rows[0]);
}

async function fillLinks(d: Db, id: string, url: string | null, nextUrl: string | null, prevUrl: string | null): Promise<Chapter> {
  const r = await d.query(
    `update chapters set
       url = coalesce(url, $2),
       next_url = coalesce(next_url, $3),
       prev_url = coalesce(prev_url, $4)
     where id = $1
     returning *`,
    [id, url, nextUrl, prevUrl],
  );
  return toChapter(r.rows[0]);
}

async function replaceText(
  d: Db,
  id: string,
  title: string,
  paragraphs: string[],
  sha: string,
  words: number,
  nextUrl: string | null,
  prevUrl: string | null,
): Promise<Chapter> {
  return withTx(d, async (tx) => {
    await tx.query("delete from chapter_paragraphs where chapter_id = $1", [id]);
    await tx.query(
      `insert into chapter_paragraphs (chapter_id, idx, text)
       select $1, t.ord - 1, t.text from unnest($2::text[]) with ordinality as t(text, ord)`,
      [id, [title, ...paragraphs]],
    );
    const r = await tx.query(
      `update chapters set title_src = $2, content_sha256 = $3, words = $4,
         next_url = coalesce($5, next_url), prev_url = coalesce($6, prev_url)
       where id = $1 returning *`,
      [id, title, sha, words, nextUrl, prevUrl],
    );
    return toChapter(r.rows[0]);
  });
}

export async function getBook(d: Db, id: string): Promise<Book | null> {
  if (!isUuid(id)) return null;
  const r = await d.query("select * from books where id = $1", [id]);
  return r.rows[0] ? toBook(r.rows[0]) : null;
}

const BOOK_PATCH_COLUMNS = {
  title: "title",
  register: "register",
  narratorPerson: "narrator_person",
  narratorGender: "narrator_gender",
  honorifics: "honorifics",
  coverUrl: "cover_url",
} as const;

export async function updateBook(
  d: Db,
  id: string,
  patch: Partial<{ title: string; register: Register; narratorPerson: 1 | 3 | null; narratorGender: Gender | null; honorifics: string | null; coverUrl: string | null }>,
): Promise<Book> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, column] of Object.entries(BOOK_PATCH_COLUMNS)) {
    if (key in patch) {
      params.push((patch as Record<string, unknown>)[key] ?? null);
      sets.push(`${column} = $${params.length}`);
    }
  }
  // Стиль, рассказчик и обращения влияют на перевод — как и правка глоссария.
  const affectsPrompt = ["register", "narratorPerson", "narratorGender", "honorifics"].some((k) => k in patch);
  if (affectsPrompt) sets.push("glossary_version = glossary_version + 1");
  sets.push("updated_at = now()");
  const r = await d.query(`update books set ${sets.join(", ")} where id = $1 returning *`, params);
  if (!r.rows[0]) throw new Error("Книга не найдена.");
  return toBook(r.rows[0]);
}

export async function listBooks(d: Db): Promise<BookListItem[]> {
  const r = await d.query(
    `select b.*,
       (select count(*) from chapters c where c.book_id = b.id) as n_chapters,
       (select count(*) from chapters c where c.book_id = b.id and c.current_translation_id is not null) as n_translated,
       (select coalesce(sum(a.usd), 0) from api_calls a where a.book_id = b.id) as spent_usd,
       rp.chapter_id as lr_chapter_id, rp.updated_at as lr_at,
       lc.title_src as lr_title, lc.number as lr_number,
       exists (
         select 1 from chapters n
         where n.book_id = b.id and n.current_translation_id is not null and n.id <> lc.id
           and ((lc.number is not null and n.number = lc.number + 1) or (lc.next_url is not null and n.url = lc.next_url))
       ) as next_ready
     from books b
     left join reading_position rp on rp.book_id = b.id
     left join chapters lc on lc.id = rp.chapter_id
     order by coalesce(rp.updated_at, b.updated_at) desc`,
  );
  return r.rows.map((row) => ({
    book: toBook(row),
    chapters: num(row.n_chapters),
    translated: num(row.n_translated),
    lastRead: row.lr_chapter_id
      ? {
          chapterId: String(row.lr_chapter_id),
          chapterTitle: String(row.lr_title ?? ""),
          number: row.lr_number == null ? null : num(row.lr_number),
          at: iso(row.lr_at),
        }
      : null,
    nextReady: Boolean(row.next_ready),
    spentUsd: num(row.spent_usd),
  }));
}

export async function getChapter(d: Db, id: string): Promise<Chapter | null> {
  if (!isUuid(id)) return null;
  const r = await d.query("select * from chapters where id = $1", [id]);
  return r.rows[0] ? toChapter(r.rows[0]) : null;
}

export async function getParagraphs(d: Db, chapterId: string): Promise<Paragraph[]> {
  const r = await d.query("select idx, text from chapter_paragraphs where chapter_id = $1 order by idx", [chapterId]);
  return r.rows.map((row) => ({ idx: num(row.idx), text: String(row.text) }));
}

/** Главы книги по порядку: номер, затем время добавления. */
export async function listChapters(d: Db, bookId: string): Promise<Array<Chapter & { translated: boolean }>> {
  const r = await d.query(
    "select * from chapters where book_id = $1 order by number nulls last, created_at",
    [bookId],
  );
  return r.rows.map((row) => ({ ...toChapter(row), translated: row.current_translation_id != null }));
}

/**
 * Соседи главы. Сначала по ссылкам «дальше/назад» со страницы — им можно
 * верить больше всего; затем по номеру (ровно ±1, чтобы не перепрыгнуть
 * невзятые главы); если номера нет — по порядку добавления среди глав без номера.
 */
export async function neighbors(d: Db, chapter: Chapter): Promise<{ prev: Chapter | null; next: Chapter | null }> {
  const pick = async (sql: string, params: unknown[]) => {
    const r = await d.query(sql, params);
    return r.rows[0] ? toChapter(r.rows[0]) : null;
  };
  const find = async (dir: "next" | "prev"): Promise<Chapter | null> => {
    const link = dir === "next" ? chapter.nextUrl : chapter.prevUrl;
    if (link) {
      const byLink = await pick("select * from chapters where book_id = $1 and url = $2 and id <> $3 limit 1", [chapter.bookId, link, chapter.id]);
      if (byLink) return byLink;
    }
    // Обратная ссылка: у следующей главы prev_url указывает на эту.
    if (chapter.url) {
      const back = dir === "next" ? "prev_url" : "next_url";
      const byBackLink = await pick(`select * from chapters where book_id = $1 and ${back} = $2 and id <> $3 limit 1`, [chapter.bookId, chapter.url, chapter.id]);
      if (byBackLink) return byBackLink;
    }
    if (chapter.number != null) {
      const n = dir === "next" ? chapter.number + 1 : chapter.number - 1;
      return pick("select * from chapters where book_id = $1 and number = $2 order by created_at limit 1", [chapter.bookId, n]);
    }
    const op = dir === "next" ? ">" : "<";
    const order = dir === "next" ? "asc" : "desc";
    return pick(
      `select * from chapters where book_id = $1 and number is null and id <> $2 and created_at ${op} $3 order by created_at ${order} limit 1`,
      [chapter.bookId, chapter.id, chapter.createdAt],
    );
  };
  const [prev, next] = await Promise.all([find("prev"), find("next")]);
  return { prev, next };
}

/** Найти главу по нормализованному адресу. */
export async function findChapterByUrl(d: Db, url: string): Promise<Chapter | null> {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const r = await d.query("select * from chapters where url = $1 order by created_at limit 1", [normalized]);
  return r.rows[0] ? toChapter(r.rows[0]) : null;
}

export async function deleteChapter(d: Db, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await d.query("delete from chapters where id = $1", [id]);
}

/** Сколько потрачено на книгу за всё время, $. */
export async function bookSpentUsd(d: Db, bookId: string): Promise<number> {
  const r = await d.query("select coalesce(sum(usd), 0) as usd from api_calls where book_id = $1", [bookId]);
  return num(r.rows[0]?.usd);
}

/** Есть ли у книги переведённые главы до этой (для «это первая глава книги» в разборе терминов). */
export async function isFirstChapterOfBook(d: Db, chapter: Chapter): Promise<boolean> {
  const r = await d.query(
    "select 1 from chapters where book_id = $1 and id <> $2 and current_translation_id is not null limit 1",
    [chapter.bookId, chapter.id],
  );
  return r.rows.length === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Мусор в адресе не должен ронять запрос ошибкой приведения типа в Postgres. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
