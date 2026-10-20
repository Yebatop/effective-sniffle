import { afterAll, beforeAll, expect, test } from "vitest";
import pg from "pg";
import { migrate, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import { mergeProposals, listTerms } from "@/lib/db/terms";
import { upsertRefChapter } from "@/lib/db/reference";
import { SCHEMA_VERSION } from "@/lib/db/schema";

// База владельца уже стоит на версии 1 и в ней книги и глоссарий. Новая
// версия схемы должна доставиться поверх, ничего не потеряв.
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tolmach_test";
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 3 });
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool);
  // Откатить до версии 1: убрать то, что добавила версия 2.
  await pool.query(`
    drop table glossary_jobs; drop table ref_terms; drop table ref_chapters;
    alter table terms drop column source;
    update schema_meta set version = 1;
  `);
});

afterAll(async () => {
  await pool.end();
});

test("версия 1 с данными → текущая: данные на месте, новые таблицы работают", async () => {
  const db = pool as unknown as Db;
  // Текст придуман для теста.
  const { chapter, book } = await importChapter(db, {
    url: "https://serialhall.example/fiction/5/reed-lake/chapter/1/chapter-1",
    bookTitle: "Reed Lake",
    chapterTitle: "Chapter 1: Reeds",
    paragraphs: ["Ilse rowed across the reed lake at noon."],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
    source: "button",
  });
  await pool.query("insert into terms (book_id, en, ru, kind) values ($1, 'Ilse', 'Ильза', 'name')", [book.id]);

  await migrate(pool);
  await migrate(pool); // повторный запуск ничего не ломает

  expect((await pool.query("select version from schema_meta")).rows[0].version).toBe(SCHEMA_VERSION);
  const terms = await listTerms(db, book.id);
  expect(terms).toHaveLength(1);
  expect(terms[0]).toMatchObject({ en: "Ilse", ru: "Ильза", source: "auto" });
  await mergeProposals(db, book.id, chapter.id, [{ en: "Reed Lake", ru: "Камышовое озеро", kind: "place" }], []);
  expect(await upsertRefChapter(db, book.id, { number: 1, title: "Глава 1", paragraphs: ["Ильза переплыла озеро."], url: null })).toEqual({
    created: true,
    updated: false,
  });
});
