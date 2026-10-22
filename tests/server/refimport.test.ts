import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testDb, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import { markScanned, refTail, unscannedRefChapters } from "@/lib/db/reference";
import { importRefChapter } from "@/lib/server/refimport";

let d: Db & { end(): Promise<void>; reset(): Promise<void> };
beforeAll(async () => {
  d = await testDb();
});
afterAll(async () => {
  await d.end();
});
beforeEach(async () => {
  await d.reset();
});

// Текст придуман для тестов.
async function book(): Promise<string> {
  const { book: b } = await importChapter(d, {
    url: "https://serialhall.example/fiction/9/reed-lake/chapter/1/chapter-1",
    bookTitle: "Reed Lake",
    chapterTitle: "Chapter 1",
    paragraphs: ["Ilse rowed across the lake."],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
    source: "button",
  });
  return b.id;
}

const url = (v: number, c: string) => `https://ranobe.example/b/reed/v${v}/c${c}`;
const put = (bookId: string, title: string, u: string, text: string, expected: number | null, prevUrl: string | null = null) =>
  importRefChapter(d, bookId, { title, url: u, paragraphs: [text], expectedNumber: expected, prevUrl });

describe("приём глав готового перевода", () => {
  test("том 2 с нумерацией заново и главами из частей не затирает том 1", async () => {
    const bookId = await book();
    expect(await put(bookId, "Том 1 Глава 1", url(1, "1"), "Т1 Г1", null)).toMatchObject({ kind: "ok", number: 1 });
    expect(await put(bookId, "Том 1 Глава 2", url(1, "2"), "Т1 Г2", 2)).toMatchObject({ kind: "ok", number: 2 });
    expect(await put(bookId, "Том 2 Глава 1.1", url(2, "1-1"), "Т2 Г1 ч1", 3)).toMatchObject({ kind: "ok", number: 3 });
    expect(await put(bookId, "Том 2 Глава 1.2", url(2, "1-2"), "Т2 Г1 ч2", 4)).toMatchObject({ kind: "ok", number: 3 });
    expect(await put(bookId, "Том 2 Глава 2", url(2, "2"), "Т2 Г2", 4)).toMatchObject({ kind: "ok", number: 4 });
    expect(await refTail(d, bookId, 1, 5)).toEqual(["Т1 Г1"]);
    expect(await refTail(d, bookId, 2, 5)).toEqual(["Т1 Г2"]);
    expect(await refTail(d, bookId, 3, 5)).toEqual(["Т2 Г1 ч1", "Т2 Г1 ч2"]);
    expect(await refTail(d, bookId, 4, 5)).toEqual(["Т2 Г2"]);
  });

  test("обход начат заново посреди тома: номер — по ссылке «назад» на уже взятую главу", async () => {
    const bookId = await book();
    await put(bookId, "Том 1 Глава 1", url(1, "1"), "Т1 Г1", null);
    await put(bookId, "Том 1 Глава 2", url(1, "2"), "Т1 Г2", 2);
    await put(bookId, "Том 2 Глава 1", url(2, "1"), "Т2 Г1", 3);
    // Новый обход с «Том 2 Глава 2»: своего ожидаемого номера нет, но «назад» ведёт на взятую главу 3.
    expect(await put(bookId, "Том 2 Глава 2", url(2, "2"), "Т2 Г2", null, url(2, "1"))).toMatchObject({ kind: "ok", number: 4 });
    expect(await refTail(d, bookId, 2, 5)).toEqual(["Т1 Г2"]);
  });

  test("другая глава под тем же номером с другого адреса — не затирается", async () => {
    const bookId = await book();
    await put(bookId, "Глава 7", "https://ranobe.example/a/c7", "Книга А, глава 7", null);
    expect(await put(bookId, "Глава 7", "https://ranobe.example/b/c7", "Книга Б, глава 7", null)).toEqual({ kind: "conflict", number: 7 });
    expect(await refTail(d, bookId, 7, 5)).toEqual(["Книга А, глава 7"]);
    // Тот же адрес с новым текстом (сайт поправил главу) — заменяется.
    expect(await put(bookId, "Глава 7", "https://ranobe.example/a/c7", "Книга А, глава 7, правка", null)).toMatchObject({ kind: "ok", updated: true });
  });

  test("глава, дописанная, пока её читали, не помечается прочитанной", async () => {
    const bookId = await book();
    await put(bookId, "Глава 5.1", url(1, "5-1"), "Часть 1", null);
    const [row] = await unscannedRefChapters(d, bookId, 10);
    await put(bookId, "Глава 5.2", url(1, "5-2"), "Часть 2", 6);
    await markScanned(d, [{ id: row.id, sha: row.sha }]);
    expect((await unscannedRefChapters(d, bookId, 10)).map((r) => r.number)).toEqual([5]);
  });

  test("тот же адрес с хвостом из поиска, слэшем или www — та же глава, не конфликт", async () => {
    const bookId = await book();
    await put(bookId, "Глава 8", "https://ranobe.example/b/reed/c8", "Глава восемь", null);
    for (const u of ["https://ranobe.example/b/reed/c8/", "http://ranobe.example/b/reed/c8?ysclid=abc123", "https://www.ranobe.example/b/reed/c8?utm_source=tg"]) {
      expect(await put(bookId, "Глава 8", u, "Глава восемь, правка", null)).toMatchObject({ kind: "ok", number: 8 });
    }
    // «Назад» со слэшем на конце находит главу, записанную без него.
    expect(await put(bookId, "Эпилог", "https://ranobe.example/b/reed/c9", "Эпилог", null, "https://ranobe.example/b/reed/c8/")).toMatchObject({ kind: "ok", number: 9 });
  });

  test("первая часть главы из частей, пришедшая снова, главу не урезает", async () => {
    const bookId = await book();
    await put(bookId, "Глава 5.1", url(1, "5-1"), "Часть 1", null);
    await put(bookId, "Глава 5.2", url(1, "5-2"), "Часть 2", 6);
    expect(await put(bookId, "Глава 5.1", url(1, "5-1"), "Часть 1", null)).toMatchObject({ kind: "ok", created: false, updated: false });
    expect(await refTail(d, bookId, 5, 5)).toEqual(["Часть 1", "Часть 2"]);
  });

  test("обход начали со второй части — первая потом встаёт в начало", async () => {
    const bookId = await book();
    expect(await put(bookId, "Глава 5.2", url(1, "5-2"), "Часть 2", null)).toMatchObject({ kind: "ok", number: 5 });
    expect(await put(bookId, "Глава 5.1", url(1, "5-1"), "Часть 1", null)).toMatchObject({ kind: "ok", number: 5, updated: true });
    expect(await refTail(d, bookId, 5, 5)).toEqual(["Часть 1", "Часть 2"]);
  });

  test("часть 2 без связи с прошлой главой не дописывается к чужой главе", async () => {
    const bookId = await book();
    await put(bookId, "Глава 5", "https://ranobe.example/a/c5", "Книга А, глава 5", null);
    // Обход по другой книге сайта начат с «Глава 5.2»: ни ожидаемого номера, ни знакомой ссылки «назад».
    expect(await put(bookId, "Глава 5.2", "https://ranobe.example/b/c5-2", "Книга Б, 5.2", null, "https://ranobe.example/b/c5-1")).toEqual({
      kind: "conflict",
      number: 5,
    });
    expect(await refTail(d, bookId, 5, 5)).toEqual(["Книга А, глава 5"]);
  });
});

