import { afterAll, beforeAll, expect, test } from "vitest";
import pg from "pg";
import { migrate, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";

// База, где уже стоит прошлая версия «Толмача» (ExtTran): у неё свои books и
// translations с другими колонками. Так было у владельца при первой установке:
// «column "id" referenced in foreign key constraint does not exist».
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tolmach_test";
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, max: 3 });
  await pool.query("drop schema public cascade; create schema public;");
  await pool.query(`
    create table books (key text primary key, host text not null, slug text not null, title text not null,
      chapters_translated integer not null default 0, first_seen timestamptz not null, last_seen timestamptz not null,
      cover_url text, source_title text);
    create table glossaries (book_key text primary key references books(key) on delete cascade, data jsonb not null,
      updated_at timestamptz not null default now());
    create table translations (reader text not null, source text not null, register text not null, tier text not null,
      book_key text not null, title text not null default '', words integer not null default 0, body text not null,
      model text not null default '', rub numeric(10,4) not null default 0, published boolean not null default false,
      next_url text, created_at timestamptz not null default now(), last_read_at timestamptz not null default now(),
      primary key (reader, source, register, tier));
    create table queue (reader text not null, source text not null, register text not null, tier text not null,
      book_key text not null, state text not null, primary key (reader, source, register, tier));
    insert into books values ('old.example/novel/x', 'old.example', 'x', 'Старая книга', 3, now(), now(), null, null);
    insert into glossaries values ('old.example/novel/x', '{"terms": []}');
    insert into translations (reader, source, register, tier, book_key, body) values ('me', 'https://old.example/1', 'ровный', 'middle', 'old.example/novel/x', 'Старый перевод');
  `);
});

afterAll(async () => {
  await pool.end();
});

test("old tables are moved aside, kept intact, and the new schema installs", async () => {
  await migrate(pool);
  const tables = (await pool.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows.map((r) => r.table_name);
  expect(tables).toEqual(expect.arrayContaining(["legacy_books", "legacy_translations", "glossaries", "queue", "books", "translations", "chapters", "jobs"]));
  // Старые данные на месте, связь глоссария со старой книгой цела.
  expect((await pool.query("select title from legacy_books")).rows[0].title).toBe("Старая книга");
  expect((await pool.query("select body from legacy_translations")).rows[0].body).toBe("Старый перевод");
  const fk = await pool.query(
    "select confrelid::regclass::text as target from pg_constraint where conrelid = 'glossaries'::regclass and contype = 'f'",
  );
  expect(fk.rows[0].target).toBe("legacy_books");
  // Новая схема работает.
  const { created } = await importChapter(pool as unknown as Db, {
    url: "https://new.example/novel/y/chapter-1",
    bookTitle: "Новая",
    chapterTitle: "Chapter 1",
    paragraphs: ["A line of invented text."],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
    source: "paste",
  });
  expect(created).toBe(true);
  // Повторный запуск ничего не трогает.
  await migrate(pool);
  expect((await pool.query("select count(*)::int as n from information_schema.tables where table_name like 'legacy_%'")).rows[0].n).toBe(2);
});

test("concurrent first runs do not trip over each other", async () => {
  await pool.query("drop schema public cascade; create schema public;");
  const pools = [0, 1, 2].map(() => new pg.Pool({ connectionString: url, max: 1 }));
  try {
    await Promise.all(pools.map((p) => migrate(p)));
    expect((await pool.query("select version from schema_meta")).rows[0].version).toBeGreaterThanOrEqual(1);
  } finally {
    await Promise.all(pools.map((p) => p.end()));
  }
});
