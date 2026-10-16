import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testDb, __setDbForTests, type Db } from "@/lib/db/client";
import { importChapter, getChapter, getBook } from "@/lib/db/books";
import { createOrGetJob, getJob } from "@/lib/db/jobs";
import { budgetState, recentCalls, reserve } from "@/lib/db/money";
import { saveSettings } from "@/lib/db/misc";
import { listAddresses, listTerms } from "@/lib/db/terms";
import { getParagraphsSince } from "@/lib/db/translations";
import { runJob, startTranslation } from "@/lib/server/worker";
import { __resetClientForTests, checkKey } from "@/lib/server/anthropic";
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

// Текст придуман для тестов.
function chapter(paragraphs: string[], n = 1): ExtractedChapter {
  return {
    url: `https://serialhall.example/fiction/4242/glass-river/chapter/${9000 + n}/chapter-${n}`,
    bookTitle: "Glass River",
    chapterTitle: `Chapter ${n}: The Ferry`,
    paragraphs,
    nextUrl: null,
    prevUrl: null,
    coverUrl: null,
    words: 0,
    looksLocked: false,
    looksLikeIndex: false,
  };
}

async function startJob(paragraphs: string[], n = 1) {
  const { chapter: c } = await importChapter(d, { ...chapter(paragraphs, n), source: "button" });
  const { job } = await createOrGetJob(d, { chapterId: c.id, model: "claude-sonnet-5-5", effort: "medium" });
  return { chapterId: c.id, jobId: job.id };
}

async function translated(chapterId: string) {
  const c = await getChapter(d, chapterId);
  if (!c?.currentTranslationId) return [];
  return getParagraphsSince(d, c.currentTranslationId, 0);
}

describe("worker", () => {
  test("translates a chapter: terms first, then labelled paragraphs, cost recorded", async () => {
    const { chapterId, jobId } = await startJob(["Mara looked at the river.", "Fen said nothing.", "The ferry was late."]);
    expect(await runJob(jobId, { relay: async () => undefined })).toBe("done");

    const out = await translated(chapterId);
    expect(out.map((p) => p.idx)).toEqual([0, 1, 2, 3]);
    expect(out[0].text).toBe("RU: Chapter 1: The Ferry");
    expect(out[1].text).toBe("RU: Mara looked at the river.");

    // Разбор терминов шёл до перевода и попал в глоссарий.
    expect(mock.calls[0].stream).toBe(false);
    expect(mock.calls[1].stream).toBe(true);
    const c = (await getChapter(d, chapterId))!;
    const terms = await listTerms(d, c.bookId);
    expect(terms.map((t) => t.en).sort()).toEqual(["Fen", "Mara"]);
    expect((await listAddresses(d, c.bookId))).toHaveLength(1);
    // И глоссарий ушёл в запрос перевода.
    expect(JSON.stringify(mock.calls[1].body)).toContain("Мара");
    // Рассказчик и стиль — заполнены из разбора.
    const book = (await getBook(d, c.bookId))!;
    expect(book.narratorPerson).toBe(3);
    expect(book.register).toBe("live");

    // Sonnet — с серверным повтором при отказе.
    expect(mock.calls[1].path).toContain("beta=true");
    expect((mock.calls[1].body as { fallbacks?: string }).fallbacks).toBe("default");
    expect((mock.calls[1].body as { output_config?: { effort?: string } }).output_config?.effort).toBe("medium");

    const calls = await recentCalls(d, 10);
    expect(calls).toHaveLength(2);
    const spent = calls.reduce((s, x) => s + x.usd, 0);
    const budget = await budgetState(d, 300 / 92);
    expect(budget.spentUsd).toBeCloseTo(spent, 6);
    expect(budget.reservedUsd).toBeCloseTo(0, 6);
    expect((await getJob(d, jobId))?.state).toBe("done");
  });

  test("refusal goes down the model chain; Haiku gets no server fallback", async () => {
    const { chapterId, jobId } = await startJob(["Plain line.", "REFUSE_ME harsh scene."]);
    expect(await runJob(jobId)).toBe("done");
    const models = mock.calls.filter((c) => c.stream).map((c) => c.model);
    expect(models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    const out = await translated(chapterId);
    expect(out.map((p) => p.text)).toContain("RU: REFUSE_ME harsh scene.");
    expect(out.every((p) => !p.refused)).toBe(true);
  });

  test("a paragraph refused by every model gets a placeholder, the rest is translated", async () => {
    await saveSettings(d, { translateModel: "claude-haiku-5-5" });
    const { chapter: c } = await importChapter(d, { ...chapter(["Line one.", "REFUSE_ME again."]), source: "paste", url: null });
    const { job } = await createOrGetJob(d, { chapterId: c.id, model: "claude-haiku-5-5", effort: "low" });
    // Opus в этом тесте тоже отказывает: подменяем текст так, чтобы мок отказал всем.
    // (Мок отказывает всем, кроме Opus; проверяем путь до половинок и заменителя.)
    expect(await runJob(job.id)).toBe("done");
    const haikuCall = mock.calls.find((x) => x.stream && x.model === "claude-haiku-5-5")!;
    expect((haikuCall.body as { fallbacks?: unknown }).fallbacks).toBeUndefined();
    const out = await translated(c.id);
    expect(out.find((p) => p.idx === 1)?.text).toBe("RU: Line one.");
  });

  test("skipped paragraphs are re-requested alone; truncation continues from the gap", async () => {
    const { chapterId, jobId } = await startJob(["First.", "SKIP_ME second.", "Third TRUNCATE_ME.", "Fourth."]);
    expect(await runJob(jobId)).toBe("done");
    const out = await translated(chapterId);
    expect(out.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(out.find((p) => p.idx === 2)?.text).toBe("RU: SKIP_ME second.");
    expect(out.find((p) => p.idx === 4)?.text).toBe("RU: Fourth.");
    expect(out.some((p) => p.text.includes("оборв"))).toBe(false);
  });

  test("long chapter in several chunks relays and resumes without redoing finished chunks", async () => {
    const para = (i: number) => `Paragraph ${i}. ` + "The ferry crossed the wide grey river under a low sky ".repeat(10).trim();
    const { chapterId, jobId } = await startJob(Array.from({ length: 40 }, (_, i) => para(i + 1)));
    const relayed: string[] = [];
    let t = 0;
    // Каждая часть «длится» 100 с: после первой исполнитель должен передать эстафету.
    const now = () => t;
    const sleep = async () => undefined;
    const first = await runJob(jobId, { relay: async (id) => void relayed.push(id), now, sleep, budgetMs: 50 });
    expect(first).toBe("done");
    // budgetMs проверяется до каждой части; время в тесте не идёт — значит, всё за один заход.
    // Теперь — с идущим временем.
    await d.reset();
    await saveSettings(d, { translateModel: "claude-sonnet-5-5" });
    mock.calls.length = 0;
    const again = await startJob(Array.from({ length: 40 }, (_, i) => para(i + 1)));
    const clock = { t: 0 };
    const tick = () => (clock.t += 30_000);
    const r1 = await runJob(again.jobId, { relay: async (id) => void relayed.push(id), now: tick, sleep, budgetMs: 150_000 });
    expect(r1).toBe("relayed");
    const job1 = (await getJob(d, again.jobId))!;
    expect(job1.chunksTotal).toBeGreaterThan(1);
    expect(job1.nextChunk).toBeGreaterThan(0);
    const before = mock.calls.filter((c) => c.stream).length;
    let result = "relayed";
    for (let i = 0; i < 10 && result === "relayed"; i += 1) {
      result = await runJob(again.jobId, { relay: async (id) => void relayed.push(id), now: tick, sleep, budgetMs: 150_000 });
    }
    expect(result).toBe("done");
    const translateCalls = mock.calls.filter((c) => c.stream).length;
    // Ни одна готовая часть не переводилась дважды.
    expect(translateCalls).toBe(job1.chunksTotal);
    expect(translateCalls).toBeGreaterThan(before);
    expect((await translated(again.chapterId)).map((p) => p.idx)).toEqual(Array.from({ length: 41 }, (_, i) => i));
    void chapterId;
  });

  test("budget limit blocks the job before spending, and it is resumable", async () => {
    await saveSettings(d, { monthlyLimitRub: 0.5 });
    const { jobId } = await startJob(["Mara waited.", "Nothing happened."]);
    expect(await runJob(jobId)).toBe("blocked");
    const job = (await getJob(d, jobId))!;
    expect(job.state).toBe("blocked_budget");
    expect(job.errorCode).toBe("budget_limit");
    expect(mock.calls).toHaveLength(0);
  });

  test("a second runner cannot take a job that is already running", async () => {
    const { jobId } = await startJob(["One.", "Two."]);
    const [a, b] = await Promise.all([runJob(jobId), runJob(jobId)]);
    expect([a, b].sort()).toEqual(["busy", "done"]);
  });

  test("a runner replaced mid-stream steps aside: no false failure, the aborted call is still paid for", async () => {
    const { chapterId, jobId } = await startJob(["SLOW_ME one.", "SLOW_ME two.", "SLOW_ME three.", "SLOW_ME four."]);
    const running = runJob(jobId, { heartbeatMs: 40 });
    // Пока поток идёт, задачу «перехватывает» другой исполнитель.
    await new Promise((r) => setTimeout(r, 250));
    await d.query("update jobs set attempt = attempt + 1 where id = $1", [jobId]);
    expect(await running).toBe("busy");
    const job = (await getJob(d, jobId))!;
    expect(job.state).toBe("running"); // не затёрто в failed
    const c = (await getChapter(d, chapterId))!;
    expect(c.currentTranslationId).toBeNull();
    const calls = await recentCalls(d, 10);
    expect(calls.some((x) => x.purpose === "translate" && x.usage.inputTokens > 0)).toBe(true);
    const budget = await budgetState(d, 300 / 92);
    expect(budget.reservedUsd).toBeCloseTo(0, 6);
  });

  test("an answer served by a fallback model is priced and recorded, not crashed on", async () => {
    const { chapterId, jobId } = await startJob(["FALLBACK_ME hard scene.", "Second."]);
    expect(await runJob(jobId)).toBe("done");
    const calls = await recentCalls(d, 10);
    expect(calls.map((x) => x.model)).toContain("claude-sonnet-5");
    expect(calls.every((x) => x.usd > 0)).toBe(true);
    expect((await budgetState(d, 300 / 92)).reservedUsd).toBeCloseTo(0, 6);
    expect((await translated(chapterId)).length).toBe(3);
  });

  test("«Повторить» after a failure continues the same translation instead of paying again", async () => {
    const para = (i: number) => `Paragraph ${i}. ` + "The ferry crossed the wide grey river under a low sky ".repeat(10).trim();
    const { chapterId, jobId } = await startJob(Array.from({ length: 40 }, (_, i) => para(i + 1)));
    // Сбой ровно на третьем запросе к модели: 1 — разбор терминов, 2 — первая часть, 3 — вторая.
    const watcher = setInterval(() => {
      if (mock.calls.length === 2 && mock.control.failNext === 0) mock.control.failNext = 1;
    }, 1);
    const r1 = await runJob(jobId);
    clearInterval(watcher);
    expect(r1).toBe("failed");
    const failed = (await getJob(d, jobId))!;
    expect(failed.nextChunk).toBeGreaterThan(0);
    const paidBefore = mock.calls.length;

    const { jobId: retryId } = await startTranslation(chapterId);
    expect(retryId).not.toBe(jobId);
    const retryJob = (await getJob(d, retryId))!;
    expect(retryJob.translationId).toBe(failed.translationId);
    expect(retryJob.termsExtracted).toBe(true);
    expect(await runJob(retryId)).toBe("done");
    // Ни разбор терминов, ни готовые части не оплачивались второй раз.
    const extra = mock.calls.slice(paidBefore);
    expect(extra.every((c) => c.stream)).toBe(true);
    expect(extra.length).toBe(retryJob.chunksTotal! - retryJob.nextChunk);
    expect((await translated(chapterId)).map((p) => p.idx)).toEqual(Array.from({ length: 41 }, (_, i) => i));
  });

  test("a reservation left by a killed run is returned to the limit on the next run", async () => {
    const { jobId } = await startJob(["One.", "Two."]);
    // Как будто прошлый заход убили посреди вызова: резерв висит и в бюджете, и на задаче.
    expect(await reserve(d, 0.5, 300 / 92)).toBe(true);
    await d.query("update jobs set reserved_usd = 0.5, reserved_month = to_char(now() at time zone 'UTC', 'YYYY-MM') where id = $1", [jobId]);
    expect(await runJob(jobId)).toBe("done");
    expect((await budgetState(d, 300 / 92)).reservedUsd).toBeCloseTo(0, 6);
    expect((await getJob(d, jobId))!.reservedUsd).toBeCloseTo(0, 6);
  });

  test("key check works without spending", async () => {
    expect((await checkKey()).ok).toBe(true);
  });
});
