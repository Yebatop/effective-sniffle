import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import { testDb, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import { upsertRefChapter } from "@/lib/db/reference";
import type { ChapterView, ReadyView } from "@/lib/types";

// Адреса читают базу через db() — направляем его в тестовую.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/tolmach_test";
process.env.DATABASE_URL = TEST_URL;

let d: Db & { end(): Promise<void>; reset(): Promise<void> };
let bookId = "";
let chapterId = "";

beforeAll(async () => {
  d = await testDb(TEST_URL);
  await d.reset();
  // Текст придуман для тестов.
  const { book, chapter } = await importChapter(d, {
    url: "https://serialhall.example/fiction/88/salt-road/chapter/701/chapter-1",
    bookTitle: "Salt Road",
    chapterTitle: "Chapter 1: Wells",
    paragraphs: ["The caravan reached the first well.", "Odran counted the barrels."],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
    source: "button",
  });
  bookId = book.id;
  chapterId = chapter.id;
  await upsertRefChapter(d, bookId, { number: 0, title: "Глава 0. Пролог", paragraphs: ["До пути."], url: null });
  await upsertRefChapter(d, bookId, { number: 1, title: "Глава 1. Колодцы", paragraphs: ["Караван дошёл до колодца."], url: null });
});
afterAll(async () => {
  await d.end();
});

async function ready(number: string): Promise<{ status: number; body: ReadyView }> {
  const { GET } = await import("@/app/api/books/[id]/ready/[number]/route");
  const res = await GET(new NextRequest("http://localhost/"), { params: Promise.resolve({ id: bookId, number }) });
  return { status: res.status, body: (await res.json()) as ReadyView };
}

describe("адрес главы готового перевода", () => {
  test("пролог с номером 0 открывается, и на него ведёт «Назад»", async () => {
    const zero = await ready("0");
    expect(zero.status).toBe(200);
    expect(zero.body.chapter.title).toBe("Глава 0. Пролог");
    expect(zero.body.next).toEqual({ number: 1, href: `/book/${bookId}/ready/1`, kind: "ready" });

    const one = await ready("1");
    expect(one.body.prev?.href).toBe(`/book/${bookId}/ready/0`);
    // Своя английская глава того же номера — ссылкой со страницы готовой.
    expect(one.body.own).toEqual({ href: `/read/${chapterId}`, translated: false });
  });

  test("неверный или слишком большой номер — 404, а не ошибка базы", async () => {
    for (const n of ["-1", "1.5", "1e21", "3000000000", "abc"]) expect((await ready(n)).status, n).toBe(404);
  });

  test("своя глава без перевода предлагает готовую, «Назад» — пролог", async () => {
    const { GET } = await import("@/app/api/chapters/[id]/route");
    const res = await GET(new NextRequest("http://localhost/"), { params: Promise.resolve({ id: chapterId }) });
    const view = (await res.json()) as ChapterView;
    expect(view.readyHref).toBe(`/book/${bookId}/ready/1`);
    expect(view.prev.readyHref).toBe(`/book/${bookId}/ready/0`);
  });
});
