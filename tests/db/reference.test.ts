import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testDb, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import {
  appendRefChapterPart,
  deleteReference,
  linkRefTerms,
  listRefBooks,
  markScanned,
  mergeRefTerms,
  refCounts,
  refHints,
  refPairs,
  refTail,
  unscannedRefChapters,
  upsertRefChapter,
} from "@/lib/db/reference";
import { listTerms, mergeProposals, mergeReferenceTerms } from "@/lib/db/terms";
import { claimGlossaryJob, createOrGetGlossaryJob, glossaryHeartbeat, liveGlossaryJob, stopGlossaryJob } from "@/lib/db/glossary-jobs";
import type { ExtractedChapter } from "@/lib/types";

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
function chapter(n: number): ExtractedChapter {
  return {
    url: `https://serialhall.example/fiction/88/salt-road/chapter/${700 + n}/chapter-${n}`,
    bookTitle: "Salt Road",
    chapterTitle: `Chapter ${n}: Wells`,
    paragraphs: [`The caravan reached well number ${n}.`, "Odran counted the barrels."],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
  };
}

async function book(): Promise<string> {
  const { book: b } = await importChapter(d, { ...chapter(2), source: "button" });
  return b.id;
}

describe("главы готового перевода", () => {
  test("та же глава — без изменений, новый текст — заменяет и снова ждёт чтения", async () => {
    const bookId = await book();
    const input = { number: 1, title: "Глава 1. Колодцы", paragraphs: ["Караван дошёл до колодца.", "Одран считал бочки."], url: null };
    expect(await upsertRefChapter(d, bookId, input)).toEqual({ created: true, updated: false });
    expect(await upsertRefChapter(d, bookId, input)).toEqual({ created: false, updated: false });
    const [row] = await unscannedRefChapters(d, bookId, 10);
    await markScanned(d, [row.id]);
    expect((await refCounts(d, bookId)).unscanned).toBe(0);
    expect(await upsertRefChapter(d, bookId, { ...input, paragraphs: ["Караван дошёл до второго колодца."] })).toEqual({ created: false, updated: true });
    const c = await refCounts(d, bookId);
    expect(c).toMatchObject({ count: 1, minNumber: 1, maxNumber: 1, unscanned: 1 });
    expect(c.unscannedWords).toBeGreaterThan(0);
  });

  test("пары для сверки — номера, что есть в обеих версиях, сначала последние; конец главы — для стиля", async () => {
    const bookId = await book();
    await importChapter(d, { ...chapter(3), source: "button", bookId });
    for (const n of [1, 2, 3]) await upsertRefChapter(d, bookId, { number: n, title: `Глава ${n}`, paragraphs: [`Абзац ${n}.1`, `Абзац ${n}.2`, `Абзац ${n}.3`], url: null });
    expect((await refPairs(d, bookId, 10)).map((p) => p.number)).toEqual([3, 2]);
    expect(await refTail(d, bookId, 2, 2)).toEqual(["Абзац 2.2", "Абзац 2.3"]);
    expect(await refTail(d, bookId, 9, 2)).toEqual([]);
    expect((await listRefBooks(d)).find((b) => b.id === bookId)).toMatchObject({ chapters: 2, refChapters: 3 });
  });
});

describe("части глав", () => {
  test("часть 2 дописывается к главе один раз; повтор той же части ничего не меняет", async () => {
    const bookId = await book();
    await upsertRefChapter(d, bookId, { number: 5, title: "Глава 5.1", paragraphs: ["Первая часть."], url: "https://ranobe.example/c5-1" });
    expect(await appendRefChapterPart(d, bookId, { number: 5, title: "Глава 5.2", paragraphs: ["Вторая часть."], url: "https://ranobe.example/c5-2" })).toEqual({
      created: false,
      updated: true,
    });
    expect(await appendRefChapterPart(d, bookId, { number: 5, title: "Глава 5.2", paragraphs: ["Вторая часть."], url: "https://ranobe.example/c5-2" })).toEqual({
      created: false,
      updated: false,
    });
    expect(await refTail(d, bookId, 5, 5)).toEqual(["Первая часть.", "Вторая часть."]);
    // Части без начала — сама становится главой.
    expect(await appendRefChapterPart(d, bookId, { number: 6, title: "Глава 6.2", paragraphs: ["Середина."], url: null })).toEqual({ created: true, updated: false });
  });
});

describe("пары из готового перевода", () => {
  test("совпало только другое имя — основное русское написание термина не меняется", async () => {
    const bookId = await book();
    const ch = await d.query("select id from chapters where book_id = $1 limit 1", [bookId]);
    const chapterId = String(ch.rows[0].id);
    await mergeProposals(d, bookId, chapterId, [{ en: "Maximilian", ru: "Максимильян", kind: "name", aliases: ["Max"] }], []);
    await mergeReferenceTerms(d, bookId, chapterId, [{ en: "Max", ru: "Макс", kind: "name", gender: "m" }]);
    let t = (await listTerms(d, bookId)).find((x) => x.en === "Maximilian")!;
    expect(t.ru).toBe("Максимильян");
    expect(t.gender).toBe("m");
    // А по основному имени — готовый перевод главнее предложенного моделью.
    await mergeReferenceTerms(d, bookId, chapterId, [{ en: "Maximilian", ru: "Максимилиан", kind: "name" }]);
    t = (await listTerms(d, bookId)).find((x) => x.en === "Maximilian")!;
    expect(t).toMatchObject({ ru: "Максимилиан", source: "reference" });
  });
});

describe("имена готового перевода", () => {
  test("слияние считает главы и раздвигает первую/последнюю; подсказки — свежие сверху; связанные уходят", async () => {
    const bookId = await book();
    await mergeRefTerms(d, bookId, [
      { ru: "Одран", kind: "name", gender: "m", note: "караванщик", numbers: [1, 2] },
      { ru: "Лиса", kind: "name", gender: "f", note: null, numbers: [1] },
    ]);
    await mergeRefTerms(d, bookId, [
      { ru: "одран", kind: "name", gender: null, note: "другая заметка", numbers: [5] },
      { ru: "Соляной Путь", kind: "place", gender: "m", note: null, numbers: [4] },
    ]);
    const hints = await refHints(d, bookId, 10);
    expect(hints.map((h) => h.ru)).toEqual(["Одран", "Соляной Путь", "Лиса"]);
    const odran = hints[0];
    expect(odran).toMatchObject({ mentions: 3, firstNumber: 1, lastNumber: 5, gender: "m", note: "караванщик" });
    // Род бывает только у персонажей.
    expect(hints[1].gender).toBeNull();

    const ch = await d.query("select id from chapters where book_id = $1 limit 1", [bookId]);
    await mergeProposals(d, bookId, String(ch.rows[0].id), [{ en: "Odran", ru: "Одран", kind: "name" }], []);
    expect(await linkRefTerms(d, bookId)).toBe(1);
    expect((await refHints(d, bookId, 10)).map((h) => h.ru)).toEqual(["Соляной Путь", "Лиса"]);

    await deleteReference(d, bookId);
    expect(await refHints(d, bookId, 10)).toEqual([]);
  });
});

describe("задача сбора глоссария", () => {
  test("одна живая на книгу, захват с арендой, остановка", async () => {
    const bookId = await book();
    const a = await createOrGetGlossaryJob(d, { bookId, model: "claude-haiku-5-5", scanTotal: 3, alignTotal: 1 });
    const b = await createOrGetGlossaryJob(d, { bookId, model: "claude-haiku-5-5", scanTotal: 3, alignTotal: 1 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(a.job.stage).toBe("scan");

    const claimed = await claimGlossaryJob(d, a.job.id);
    expect(claimed?.state).toBe("running");
    expect(await claimGlossaryJob(d, a.job.id)).toBeNull();
    expect(await glossaryHeartbeat(d, a.job.id, claimed!.attempt, { scanDone: 2 })).toBe(true);

    expect(await stopGlossaryJob(d, bookId)).toHaveLength(1);
    expect(await liveGlossaryJob(d, bookId)).toBeNull();
    // Остановленную задачу её исполнитель больше не продлевает.
    expect(await glossaryHeartbeat(d, a.job.id, claimed!.attempt)).toBe(false);

    const onlyAlign = await createOrGetGlossaryJob(d, { bookId, model: "claude-haiku-5-5", scanTotal: 0, alignTotal: 2 });
    expect(onlyAlign.created).toBe(true);
    expect(onlyAlign.job.stage).toBe("align");
  });
});
