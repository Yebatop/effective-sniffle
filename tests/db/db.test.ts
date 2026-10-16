import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testDb, type Db } from "@/lib/db/client";
import { importChapter, listBooks, listChapters, neighbors, getParagraphs, getChapter, updateBook, findChapterByUrl } from "@/lib/db/books";
import { createTranslation, upsertParagraph, getParagraphsSince, finishTranslation, tailOfChapter, deleteParagraphRange, addTranslationCost } from "@/lib/db/translations";
import { mergeProposals, listTerms, listAddresses, updateTerm } from "@/lib/db/terms";
import { createOrGetJob, claimJob, heartbeat, setJobState, releaseJob, staleJobs, unblockJobs, liveJobForChapter } from "@/lib/db/jobs";
import { reserve, settle, budgetState, recordApiCall, monthKey, spendByBook } from "@/lib/db/money";
import { getSettings, saveSettings, savePosition, getPosition, createReport, getReportByToken, getSecret, setSecret, getOrCreateSecret, beginLoginAttempt, loginSucceeded } from "@/lib/db/misc";
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
function chapter(n: number, extra: Partial<ExtractedChapter> = {}): ExtractedChapter {
  return {
    url: `https://serialhall.example/fiction/4242/glass-river/chapter/${9000 + n}/chapter-${n}`,
    bookTitle: "Glass River",
    chapterTitle: `Chapter ${n}: The Ferry`,
    paragraphs: [`The ferry left at dawn on day ${n}.`, "Mara counted the gulls.", "Nobody spoke."],
    nextUrl: `https://serialhall.example/fiction/4242/glass-river/chapter/${9001 + n}/chapter-${n + 1}`,
    prevUrl: null,
    coverUrl: null,
    words: 12,
    looksLocked: false,
    looksLikeIndex: false,
    ...extra,
  };
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 };

describe("books and chapters", () => {
  test("import is idempotent by content", async () => {
    const a = await importChapter(d, { ...chapter(1), source: "button" });
    const b = await importChapter(d, { ...chapter(1), source: "share" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.chapter.id).toBe(a.chapter.id);
    const paras = await getParagraphs(d, a.chapter.id);
    expect(paras[0]).toEqual({ idx: 0, text: "Chapter 1: The Ferry" });
    expect(paras).toHaveLength(4);
    expect(a.chapter.number).toBe(1);
  });

  test("concurrent imports create one book and one chapter", async () => {
    const results = await Promise.all([1, 1, 1, 2, 2].map((n) => importChapter(d, { ...chapter(n), source: "button" })));
    const books = new Set(results.map((r) => r.book.id));
    expect(books.size).toBe(1);
    const chapters = await listChapters(d, results[0].book.id);
    expect(chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(results.filter((r) => r.created)).toHaveLength(2);
  });

  test("pasted text without url makes its own book unless bookId given", async () => {
    const pasted = { ...chapter(5), url: null, nextUrl: null, source: "paste" as const };
    const a = await importChapter(d, pasted);
    const b = await importChapter(d, { ...pasted, paragraphs: ["Other text entirely."], bookId: a.book.id });
    expect(b.book.id).toBe(a.book.id);
    const c = await importChapter(d, { ...pasted, paragraphs: ["Third text."] });
    expect(c.book.id).not.toBe(a.book.id);
  });

  test("same url with new text replaces text while untranslated, keeps it once translated", async () => {
    const a = await importChapter(d, { ...chapter(3), source: "server" });
    const b = await importChapter(d, { ...chapter(3), paragraphs: ["Edited by the author."], source: "button" });
    expect(b.chapter.id).toBe(a.chapter.id);
    expect((await getParagraphs(d, a.chapter.id))[1].text).toBe("Edited by the author.");
    const t = await createTranslation(d, { chapterId: a.chapter.id, model: "claude-sonnet-5-5", mode: "sync", glossaryVersion: 0 });
    await finishTranslation(d, t.id);
    const c = await importChapter(d, { ...chapter(3), paragraphs: ["Edited again."], source: "button" });
    expect(c.chapter.id).toBe(a.chapter.id);
    expect((await getParagraphs(d, a.chapter.id))[1].text).toBe("Edited by the author.");
  });

  test("missing links are filled on re-import", async () => {
    const a = await importChapter(d, { ...chapter(4), nextUrl: null, source: "paste" });
    expect(a.chapter.nextUrl).toBeNull();
    const b = await importChapter(d, { ...chapter(4), source: "button" });
    expect(b.chapter.nextUrl).toContain("chapter-5");
  });

  test("neighbors by link and by number", async () => {
    const one = await importChapter(d, { ...chapter(1), source: "button" });
    const two = await importChapter(d, { ...chapter(2), source: "button" });
    const n1 = await neighbors(d, one.chapter);
    expect(n1.next?.id).toBe(two.chapter.id);
    const n2 = await neighbors(d, two.chapter);
    expect(n2.prev?.id).toBe(one.chapter.id);
    expect(n2.next).toBeNull();
    expect((await findChapterByUrl(d, chapter(2).url! + "?utm_source=x"))?.id).toBe(two.chapter.id);
  });

  test("library lists books with last read and next ready", async () => {
    const one = await importChapter(d, { ...chapter(1), source: "button" });
    const two = await importChapter(d, { ...chapter(2), source: "button" });
    const t = await createTranslation(d, { chapterId: two.chapter.id, model: "claude-sonnet-5-5", mode: "sync", glossaryVersion: 0 });
    await finishTranslation(d, t.id);
    await savePosition(d, { bookId: one.book.id, chapterId: one.chapter.id, paragraphIdx: 2 });
    const [item] = await listBooks(d);
    expect(item.chapters).toBe(2);
    expect(item.translated).toBe(1);
    expect(item.lastRead?.chapterId).toBe(one.chapter.id);
    expect(item.nextReady).toBe(true);
  });

  test("updating style bumps glossary version", async () => {
    const one = await importChapter(d, { ...chapter(1), source: "button" });
    const b = await updateBook(d, one.book.id, { register: "elevated" });
    expect(b.register).toBe("elevated");
    expect(b.glossaryVersion).toBe(one.book.glossaryVersion + 1);
  });

  test("garbage ids do not throw", async () => {
    expect(await getChapter(d, "not-a-uuid")).toBeNull();
  });
});

describe("translations", () => {
  test("seq grows on every upsert and since-polling sees updates", async () => {
    const { chapter: c } = await importChapter(d, { ...chapter(1), source: "button" });
    const t = await createTranslation(d, { chapterId: c.id, model: "claude-sonnet-5-5", mode: "sync", glossaryVersion: 0 });
    const s1 = await upsertParagraph(d, t.id, { idx: 0, text: "Глава 1" });
    const s2 = await upsertParagraph(d, t.id, { idx: 1, text: "Паром ушёл на рассвете." });
    expect(s2).toBeGreaterThan(s1);
    expect((await getParagraphsSince(d, t.id, s1)).map((p) => p.idx)).toEqual([1]);
    const s3 = await upsertParagraph(d, t.id, { idx: 0, text: "Глава 1: Паром" });
    const since = await getParagraphsSince(d, t.id, s2);
    expect(since).toEqual([{ idx: 0, text: "Глава 1: Паром", seq: s3, refused: undefined }]);
    await deleteParagraphRange(d, t.id, 1, 5);
    expect((await getParagraphsSince(d, t.id, 0)).map((p) => p.idx)).toEqual([0]);
  });

  test("finish sets the current pointer; tail reads the current version", async () => {
    const { chapter: c } = await importChapter(d, { ...chapter(1), source: "button" });
    const t = await createTranslation(d, { chapterId: c.id, model: "claude-sonnet-5-5", mode: "sync", glossaryVersion: 0 });
    await upsertParagraph(d, t.id, { idx: 0, text: "Глава" });
    await upsertParagraph(d, t.id, { idx: 1, text: "Один." });
    await upsertParagraph(d, t.id, { idx: 2, text: "Отказ", refused: true });
    await upsertParagraph(d, t.id, { idx: 3, text: "Три." });
    await addTranslationCost(d, t.id, 0.0123);
    await finishTranslation(d, t.id);
    expect((await getChapter(d, c.id))?.currentTranslationId).toBe(t.id);
    expect(await tailOfChapter(d, c.id, 2)).toEqual(["Один.", "Три."]);
  });
});

describe("glossary merge", () => {
  test("adds new, matches aliases, never touches checked, bumps version only on change", async () => {
    const { chapter: c, book } = await importChapter(d, { ...chapter(1), source: "button" });
    const r1 = await mergeProposals(
      d,
      book.id,
      c.id,
      [
        { en: "Mara", ru: "Мара", kind: "name", gender: null, aliases: ["Little Mara"] },
        { en: "Fen", ru: "Фен", kind: "name", gender: "m" },
        { en: "Glass River", ru: "Стеклянная река", kind: "place" },
        { en: "", ru: "пусто", kind: "other" },
      ],
      [{ fromEn: "Fen", toEn: "little mara", form: "ty" }],
    );
    expect(r1.addedTerms).toBe(3);
    expect(r1.addedAddresses).toBe(1);
    expect(r1.glossaryVersion).toBe(1);

    // Повтор того же — ничего не меняется, версия та же.
    const r2 = await mergeProposals(d, book.id, c.id, [{ en: "mara", ru: "Марa", kind: "name" }], [{ fromEn: "Fen", toEn: "Mara", form: "vy" }]);
    expect(r2.addedTerms).toBe(0);
    expect(r2.addedAddresses).toBe(0);
    expect(r2.glossaryVersion).toBe(1);

    // Пустой род заполняется, новые другие имена добавляются.
    const r3 = await mergeProposals(d, book.id, c.id, [{ en: "Mara", ru: "Мара", kind: "name", gender: "f", aliases: ["the ferry girl"] }], []);
    expect(r3.glossaryVersion).toBe(2);
    let mara = (await listTerms(d, book.id)).find((t) => t.en === "Mara")!;
    expect(mara.gender).toBe("f");
    expect(mara.aliases).toEqual(["Little Mara", "the ferry girl"]);

    // Проверенный человеком термин модель не трогает.
    await updateTerm(d, mara.id, { ru: "Мáра" });
    await mergeProposals(d, book.id, c.id, [{ en: "Mara", ru: "Мара", kind: "name", aliases: ["M."] }], []);
    mara = (await listTerms(d, book.id)).find((t) => t.en === "Mara")!;
    expect(mara.status).toBe("checked");
    expect(mara.ru).toBe("Мáра");
    expect(mara.aliases).not.toContain("M.");

    const addresses = await listAddresses(d, book.id);
    expect(addresses).toHaveLength(1);
    expect(addresses[0].form).toBe("ty");
  });

  test("concurrent merges do not duplicate terms", async () => {
    const { chapter: c, book } = await importChapter(d, { ...chapter(1), source: "button" });
    await Promise.all([1, 2, 3].map(() => mergeProposals(d, book.id, c.id, [{ en: "Oskar", ru: "Оскар", kind: "name" }], [])));
    expect((await listTerms(d, book.id)).filter((t) => t.en === "Oskar")).toHaveLength(1);
  });
});

describe("jobs", () => {
  test("one live job per chapter; concurrent claim has one winner", async () => {
    const { chapter: c } = await importChapter(d, { ...chapter(1), source: "button" });
    const [a, b] = await Promise.all([
      createOrGetJob(d, { chapterId: c.id, model: "claude-sonnet-5-5", effort: "medium" }),
      createOrGetJob(d, { chapterId: c.id, model: "claude-sonnet-5-5", effort: "medium" }),
    ]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const claims = await Promise.all([1, 2, 3, 4].map(() => claimJob(d, a.job.id)));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    const job = winners[0]!;
    expect(job.attempt).toBe(1);

    expect(await heartbeat(d, job.id, job.attempt, { nextChunk: 1, chunksTotal: 3 })).toBe(true);
    expect(await heartbeat(d, job.id, job.attempt + 5)).toBe(false);
    expect((await liveJobForChapter(d, c.id))?.nextChunk).toBe(1);
  });

  test("released lease can be reclaimed; terminal state frees the slot", async () => {
    const { chapter: c } = await importChapter(d, { ...chapter(1), source: "button" });
    const { job } = await createOrGetJob(d, { chapterId: c.id, model: "claude-sonnet-5-5", effort: "medium" });
    const first = (await claimJob(d, job.id))!;
    expect(await claimJob(d, job.id)).toBeNull(); // аренда ещё действует
    await releaseJob(d, job.id, first.attempt);
    expect((await staleJobs(d)).map((j) => j.id)).toContain(job.id);
    const second = (await claimJob(d, job.id))!;
    expect(second.attempt).toBe(2);
    expect(await heartbeat(d, job.id, first.attempt)).toBe(false); // старый исполнитель видит, что его сменили
    await setJobState(d, job.id, "done");
    const again = await createOrGetJob(d, { chapterId: c.id, model: "claude-opus-5-5", effort: "low" });
    expect(again.created).toBe(true);
    expect(again.job.id).not.toBe(job.id);
  });

  test("blocked jobs are unblocked back to queued", async () => {
    const { chapter: c } = await importChapter(d, { ...chapter(1), source: "button" });
    const { job } = await createOrGetJob(d, { chapterId: c.id, model: "claude-sonnet-5-5", effort: "medium" });
    await claimJob(d, job.id);
    await setJobState(d, job.id, "blocked_budget", { code: "budget_limit", message: "лимит" });
    expect(await unblockJobs(d)).toEqual([job.id]);
    expect((await liveJobForChapter(d, c.id))?.state).toBe("queued");
    expect(await claimJob(d, job.id)).not.toBeNull();
  });
});

describe("money", () => {
  test("reserve respects the limit even concurrently; settle moves reserve to spent", async () => {
    const month = "2026-10";
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(d, 0.3, 1.0, month)));
    expect(results.filter(Boolean)).toHaveLength(3);
    let s = await budgetState(d, 1.0, month);
    expect(s.reservedUsd).toBeCloseTo(0.9);
    await settle(d, 0.3, 0.05, month);
    s = await budgetState(d, 1.0, month);
    expect(s.reservedUsd).toBeCloseTo(0.6);
    expect(s.spentUsd).toBeCloseTo(0.05);
    expect(await reserve(d, 0.3, 1.0, month)).toBe(true);
    expect(monthKey(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01");
  });

  test("api calls are recorded once per idempotency key", async () => {
    const { chapter: c, book } = await importChapter(d, { ...chapter(1), source: "button" });
    const rec = { chapterId: c.id, bookId: book.id, purpose: "translate" as const, idemKey: "job:1:0:1:sonnet", model: "claude-sonnet-5-5", usage: ZERO, usd: 0.02 };
    expect(await recordApiCall(d, rec)).toBe(true);
    expect(await recordApiCall(d, rec)).toBe(false);
    expect(await recordApiCall(d, { ...rec, idemKey: null })).toBe(true);
    const [row] = await spendByBook(d);
    expect(row.calls).toBe(2);
    expect(row.usd).toBeCloseTo(0.04);
  });
});

describe("misc", () => {
  test("settings defaults, merge and validation", async () => {
    const s0 = await getSettings(d);
    expect(s0.translateModel).toBeNull();
    expect(s0.monthlyLimitRub).toBe(300);
    const s1 = await saveSettings(d, { translateModel: "claude-opus-5-5", monthlyLimitRub: 500 });
    expect(s1.translateModel).toBe("claude-opus-5-5");
    expect(s1.monthlyLimitRub).toBe(500);
    await expect(saveSettings(d, { usdRub: -1 })).rejects.toThrow();
    await d.query("insert into settings (key, value) values ('autostart', '\"yes\"'::jsonb)");
    expect((await getSettings(d)).autostart).toBe(false);
  });

  test("secrets are separate from settings", async () => {
    await setSecret(d, "import_token_hash", "abc");
    expect(await getSecret(d, "import_token_hash")).toBe("abc");
    expect(JSON.stringify(await getSettings(d))).not.toContain("abc");
    const [x, y] = await Promise.all([getOrCreateSecret(d, "relay_secret", () => "one"), getOrCreateSecret(d, "relay_secret", () => "two")]);
    expect(x).toBe(y);
  });

  test("positions, reports, login attempts", async () => {
    const { chapter: c, book } = await importChapter(d, { ...chapter(1), source: "button" });
    await savePosition(d, { bookId: book.id, chapterId: c.id, paragraphIdx: 7 });
    await savePosition(d, { bookId: book.id, chapterId: c.id, paragraphIdx: 9, device: "phone" });
    expect((await getPosition(d, book.id))?.paragraphIdx).toBe(9);

    await createReport(d, { token: "t0k3n", chapterId: c.id, kind: "wrong_text", payload: { a: 1 } });
    expect((await getReportByToken(d, "t0k3n"))?.payload).toEqual({ a: 1 });
    expect(await getReportByToken(d, "nope")).toBeNull();

    // Неудачи считаются по адресу: чужие попытки не закрывают вход владельцу.
    for (let i = 0; i < 3; i += 1) await beginLoginAttempt(d, "6.6.6.6");
    const mine = await beginLoginAttempt(d, "1.2.3.4");
    expect(mine.failures).toBe(1);
    // Одновременные попытки не проскакивают мимо счётчика.
    const burst = await Promise.all(Array.from({ length: 8 }, () => beginLoginAttempt(d, "6.6.6.6")));
    expect(Math.max(...burst.map((b) => b.failures))).toBe(11);
    await loginSucceeded(d, mine.id, "1.2.3.4");
    expect((await beginLoginAttempt(d, "1.2.3.4")).failures).toBe(1);
  });
});
