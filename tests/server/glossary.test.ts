import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testDb, __setDbForTests, type Db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import { claimGlossaryJob, getGlossaryJob, trackGlossaryReservation } from "@/lib/db/glossary-jobs";
import { budgetState, monthKey, reserve } from "@/lib/db/money";
import { saveSettings } from "@/lib/db/misc";
import { listRefTerms, refCounts, upsertRefChapter } from "@/lib/db/reference";
import { listTerms } from "@/lib/db/terms";
import { createOrGetJob } from "@/lib/db/jobs";
import { refSummary, runGlossaryJob, startGlossaryJob, stopGlossary } from "@/lib/server/glossary";
import { runJob } from "@/lib/server/worker";
import { __resetClientForTests } from "@/lib/server/anthropic";
import { startMockAnthropic } from "./mock-anthropic";
import type { ExtractedChapter } from "@/lib/types";

let d: Db & { end(): Promise<void>; reset(): Promise<void> };
let mock: Awaited<ReturnType<typeof startMockAnthropic>>;

beforeAll(async () => {
  d = await testDb();
  __setDbForTests(d);
  mock = await startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  __resetClientForTests(null);
});
afterAll(async () => {
  __setDbForTests(null);
  await mock.close();
  await d.end();
});
beforeEach(async () => {
  await d.reset();
  mock.calls.length = 0;
  mock.control.failNext = 0;
  await saveSettings(d, { translateModel: "claude-sonnet-5-5", monthlyLimitRub: 300, usdRub: 92 });
});

// Текст придуман для тестов: и английский, и «готовый перевод».
const EN: Record<number, string[]> = {
  3: ["Mara pushed the ferry off the bank while Fen counted the coins.", "Beyond the reeds lay Misty Crossing, silent as ever."],
  4: ["Fen asked Mara whether the lantern would last the night.", "She only shrugged and steered toward Misty Crossing."],
  5: ["At dawn old Waldo waved from the tower, and Mara waved back."],
};
const RU: Record<number, string[]> = {
  1: ["Вальдо зажёг маяк раньше обычного.", "Мара смотрела на огонь с берега."],
  2: ["Вальдо рассказывал Маре о старых паромах.", "Над водой стелился туман."],
  3: ["Мара оттолкнула паром от берега, а Фэн пересчитывал монеты.", "За камышами лежала Туманная Переправа, тихая как всегда."],
  4: ["Фэн спросил Мару, хватит ли фонаря на ночь.", "Она лишь пожала плечами и повела паром к Туманной Переправе."],
};

function enChapter(n: number): ExtractedChapter {
  return {
    url: `https://serialhall.example/fiction/77/lantern-ferry/chapter/${500 + n}/chapter-${n}`,
    bookTitle: "Lantern Ferry",
    chapterTitle: `Chapter ${n}: Crossing`,
    paragraphs: EN[n],
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
  };
}

async function setupBook(): Promise<string> {
  let bookId = "";
  for (const n of [3, 4]) {
    const { book } = await importChapter(d, { ...enChapter(n), source: "button", bookId: bookId || undefined });
    bookId = book.id;
  }
  for (const n of [1, 2, 3, 4]) {
    await upsertRefChapter(d, bookId, { number: n, title: `Глава ${n}. Переправа`, paragraphs: RU[n], url: `https://ranobe.example/b/ferry/c${n}` });
  }
  return bookId;
}

async function runToEnd(jobId: string, budgetMs = 150_000) {
  for (let i = 0; i < 20; i++) {
    const r = await runGlossaryJob(jobId, { budgetMs, relay: async () => undefined, sleep: async () => undefined });
    if (r !== "relayed") return r;
  }
  throw new Error("задача не закончилась");
}

describe("сбор глоссария по готовому переводу", () => {
  test("читает главы, сверяет пары и пишет глоссарий; имена без пары остаются подсказками", async () => {
    const bookId = await setupBook();
    const before = await refSummary(d, bookId);
    expect(before.count).toBe(4);
    expect(before.pairs).toBe(2);
    expect(before.unscanned).toBe(4);
    expect(before.estimateUsd).toBeGreaterThan(0);

    const { job, created } = await startGlossaryJob(bookId);
    expect(created).toBe(true);
    expect(job.scanTotal).toBe(4);
    expect(job.alignTotal).toBe(2);
    expect(await runToEnd(job.id)).toBe("done");

    const terms = await listTerms(d, bookId);
    const byEn = new Map(terms.map((t) => [t.en, t]));
    expect(byEn.get("Fen")?.ru).toBe("Фэн");
    expect(byEn.get("Fen")?.source).toBe("reference");
    expect(byEn.get("Mara")?.ru).toBe("Мара");
    expect(byEn.get("Misty Crossing")?.ru).toBe("Туманная Переправа");
    expect(byEn.has("Waldo")).toBe(false);

    const ref = await listRefTerms(d, bookId);
    const waldo = ref.find((r) => r.ru === "Вальдо");
    expect(waldo?.termId).toBeNull();
    expect(waldo?.firstNumber).toBe(1);
    expect(waldo?.lastNumber).toBe(2);
    expect(ref.find((r) => r.ru === "Фэн")?.termId).toBe(byEn.get("Fen")?.id);

    const after = await refSummary(d, bookId);
    expect(after.unscanned).toBe(0);
    expect(after.hints).toBe(1);
    expect(after.matched).toBe(3);
    expect(after.job?.state).toBe("done");

    // Учёт: всё списано, резерв вернулся.
    const done = await getGlossaryJob(d, job.id);
    expect(done?.spentUsd).toBeGreaterThan(0);
    expect(done?.reservedUsd).toBe(0);
    const budget = await budgetState(d, 300 / 92);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBeCloseTo(done!.spentUsd, 6);
  });

  test("с эстафетой по частям — тот же итог, прочитанное не читается заново", async () => {
    const bookId = await setupBook();
    const { job } = await startGlossaryJob(bookId);
    // budgetMs = -1: после каждой пачки — эстафета.
    expect(await runToEnd(job.id, -1)).toBe("done");
    const scanCalls = mock.calls.filter((c) => JSON.stringify(c.body.system).includes("Выпиши из глав имена"));
    expect(scanCalls.length).toBe(1);
    expect((await refCounts(d, bookId)).unscanned).toBe(0);
    expect((await listTerms(d, bookId)).find((t) => t.en === "Fen")?.ru).toBe("Фэн");
  });

  test("проверенное человеком готовый перевод не трогает, предложенное моделью — поправляет", async () => {
    const bookId = await setupBook();
    // Обычный перевод главы 3 добавил «Fen → Фен» (auto) и «Mara → Мара».
    const { rows } = await d.query("select id from chapters where book_id = $1 and number = 3", [bookId]);
    const { job: tj } = await createOrGetJob(d, { chapterId: String(rows[0].id), model: "claude-sonnet-5-5", effort: "medium" });
    expect(await runJob(tj.id, { relay: async () => undefined })).toBe("done");
    const auto = await listTerms(d, bookId);
    expect(auto.find((t) => t.en === "Fen")?.ru).toBe("Фен");
    const mara = auto.find((t) => t.en === "Mara")!;
    await d.query("update terms set ru = 'Марра', status = 'checked' where id = $1", [mara.id]);

    const { job } = await startGlossaryJob(bookId);
    expect(await runToEnd(job.id)).toBe("done");
    const terms = await listTerms(d, bookId);
    expect(terms.find((t) => t.en === "Fen")?.ru).toBe("Фэн");
    expect(terms.find((t) => t.en === "Mara")?.ru).toBe("Марра");
  });

  test("запрос отклонён (400) — пачка делится пополам, все главы прочитаны, резерв вернулся", async () => {
    const bookId = await setupBook();
    const { job } = await startGlossaryJob(bookId);
    mock.control.failNext = 1;
    expect(await runToEnd(job.id)).toBe("done");
    expect((await refCounts(d, bookId)).unscanned).toBe(0);
    expect((await listRefTerms(d, bookId)).find((r) => r.ru === "Вальдо")?.lastNumber).toBe(2);
    const scanCalls = mock.calls.filter((c) => JSON.stringify(c.body.system).includes("Выпиши из глав имена"));
    expect(scanCalls.length).toBe(3);
    expect((await budgetState(d, 300 / 92)).reservedUsd).toBe(0);
  });

  test("нечего собирать — понятная ошибка", async () => {
    const { book } = await importChapter(d, { ...enChapter(3), source: "button" });
    await expect(startGlossaryJob(book.id)).rejects.toThrow(/Нет глав готового перевода/);
  });
});

describe("перевод после готового перевода", () => {
  test("разбор новой главы видит подсказки, а первая своя глава — конец главы готового перевода", async () => {
    const bookId = await setupBook();
    const { job } = await startGlossaryJob(bookId);
    expect(await runToEnd(job.id)).toBe("done");

    const { chapter } = await importChapter(d, { ...enChapter(5), source: "button", bookId });
    // Своей главы 4 в переводе нет, а глава 4 готового перевода есть.
    await d.query("delete from chapters where book_id = $1 and number = 4", [bookId]);
    mock.calls.length = 0;
    const { job: tj } = await createOrGetJob(d, { chapterId: chapter.id, model: "claude-sonnet-5-5", effort: "medium" });
    expect(await runJob(tj.id, { relay: async () => undefined })).toBe("done");

    const extract = mock.calls.find((c) => !c.stream);
    expect(JSON.stringify(extract?.body.messages)).toContain("ИМЕНА ИЗ ГОТОВОГО ПЕРЕВОДА");
    const waldo = (await listTerms(d, bookId)).find((t) => t.en === "Waldo");
    expect(waldo?.ru).toBe("Вальдо");
    // Подсказка сопоставлена и больше не подсказка.
    expect((await listRefTerms(d, bookId)).find((r) => r.ru === "Вальдо")?.termId).toBe(waldo?.id);

    const translate = mock.calls.find((c) => c.stream);
    const prompt = JSON.stringify(translate?.body);
    expect(prompt).toContain("КОНЕЦ ПРЕДЫДУЩЕГО ТЕКСТА");
    expect(prompt).toContain("повела паром к Туманной Переправе");
  });
});

describe("трудные главы и остановка", () => {
  test("глава, на которой ответ всегда обрывается, пропускается — остальные прочитаны, сбор доходит до конца", async () => {
    const bookId = await setupBook();
    await upsertRefChapter(d, bookId, { number: 2, title: "Глава 2", paragraphs: ["ОБОРВИ: здесь слишком много имён.", "Вальдо молчал."], url: null });
    const { job } = await startGlossaryJob(bookId);
    expect(await runToEnd(job.id)).toBe("done");
    expect((await refCounts(d, bookId)).unscanned).toBe(0);
    const ref = await listRefTerms(d, bookId);
    // Глава 2 пропущена, но Вальдо есть в главе 1.
    expect(ref.find((r) => r.ru === "Вальдо")?.lastNumber).toBe(1);
    expect(ref.find((r) => r.ru === "Фэн")).toBeTruthy();
    const scanCalls = mock.calls.filter((c) => JSON.stringify(c.body.system).includes("Выпиши из глав имена"));
    // 4 главы → пополам (2+2) → пара с плохой главой ещё пополам: 1 + 2 + 2 = 5 вызовов, не бесконечно.
    expect(scanCalls.length).toBe(5);
    expect((await budgetState(d, 300 / 92)).reservedUsd).toBe(0);
  });

  test("остановка задачи без живого исполнителя возвращает её резерв", async () => {
    const bookId = await setupBook();
    const { job } = await startGlossaryJob(bookId);
    const claimed = await claimGlossaryJob(d, job.id);
    expect(await reserve(d, 0.01, 300 / 92)).toBe(true);
    await trackGlossaryReservation(d, job.id, 0.01, claimed!.reservedMonth ?? monthKey());
    // Исполнителя убили: аренда истекла.
    await d.query("update glossary_jobs set lease_until = now() - interval '5 minutes' where id = $1", [job.id]);
    expect(await stopGlossary(d, bookId)).toBe(true);
    expect((await budgetState(d, 300 / 92)).reservedUsd).toBe(0);
    expect((await getGlossaryJob(d, job.id))?.state).toBe("stopped");
  });

  test("сверка идёт по списку, замороженному при переходе к ней", async () => {
    const bookId = await setupBook();
    const { job } = await startGlossaryJob(bookId);
    expect(await runToEnd(job.id)).toBe("done");
    expect((await getGlossaryJob(d, job.id))?.alignNumbers).toEqual([4, 3]);
  });
});
