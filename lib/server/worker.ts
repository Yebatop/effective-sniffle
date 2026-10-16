/**
 * Исполнитель задачи перевода. Вызывается из after() в маршрутах; один
 * вызов работает не дольше ~200 с (предел функции на Vercel Hobby — 300 с,
 * и при превышении не выполняются ни catch, ни finally), затем передаёт
 * эстафету POST-запросом на /api/jobs/run с секретом эстафеты.
 *
 * Шаги: захват (claimJob) → разбор терминов, если ещё не было (до перевода!)
 * → части по порядку с next_chunk: резерв бюджета → translateChunk с
 * цепочкой моделей при отказе (refusalChain) → если все отказали — та же
 * часть половинками (halveRange), одиночный абзац — заменитель с
 * refused=true → запись абзацев, учёт расхода (recordApiCall с idemKey),
 * settle, heartbeat с nextChunk+1 → по завершении finishTranslation,
 * задача done. Недописанная часть при обрыве удаляется перед повтором.
 * Ошибки: credit_low → blocked_credit; бюджет → blocked_budget; auth и
 * прочие неповторяемые → failed; rate_limit/overloaded/network → эстафета
 * с паузой, до 6 попыток задачи.
 */

import { db, type Db } from "../db/client";
import { getBook, getChapter, getParagraphs, isFirstChapterOfBook, neighbors, updateBook } from "../db/books";
import { claimJob, createOrGetJob, getJob, heartbeat, releaseJob, setJobState } from "../db/jobs";
import { budgetState, monthKey, recordApiCall, reserve, settle } from "../db/money";
import { getOrCreateSecret, getSettings } from "../db/misc";
import { listAddresses, listTerms, mergeProposals } from "../db/terms";
import {
  addTranslationCost,
  createTranslation,
  deleteParagraphRange,
  failTranslation,
  finishTranslation,
  tailBefore,
  tailOfChapter,
  upsertParagraph,
} from "../db/translations";
import { halveRange, splitIntoChunks } from "../core/chunk";
import { missingIdx } from "../core/labels";
import { refusalChain } from "../core/models";
import { buildTranslateRequest } from "../core/prompt";
import { estimateTokens, usageCostUsd, worstCaseUsd } from "../core/cost";
import { extractTerms, translateChunk } from "./anthropic";
import { newToken } from "./auth";
import type { Book, Chapter, ErrorCode, Job, ModelId, Paragraph, Settings, Usage } from "../types";

export interface WorkerDeps {
  /** Адрес приложения, на который отправляется эстафета (из входящего запроса). */
  origin?: string;
  /** Как передать эстафету: по умолчанию fetch POST на /api/jobs/run. */
  relay?: (jobId: string) => Promise<void>;
  /** Сколько миллисекунд можно работать в одном вызове до начала новой части. */
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Новую часть начинаем, только если до предела функции хватит времени на неё. */
const DEFAULT_BUDGET_MS = 150_000;
/** Подразбиения (пропуски, отказы) — пока прошло меньше этого. */
const HARD_STOP_MS = 210_000;
/** После стольких попыток задача с повторяемой ошибкой сдаётся. */
const MAX_ATTEMPTS = 6;
const REFUSED_PLACEHOLDER = "[Модель отказалась переводить этот абзац]";
const SKIPPED_PLACEHOLDER = "[Абзац не переведён]";
const HEARTBEAT_EVERY_MS = 20_000;

/** Деньги в базе хранятся с точностью до 1e-6 $ — резерв и факт считаем так же, иначе остаются хвосты. */
const usd6 = (x: number) => Math.ceil(x * 1e6) / 1e6;

class BudgetBlocked extends Error {}
class TakenOver extends Error {}
class OutOfTime extends Error {}
class ApiFailure extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryable: boolean) {
    super(message);
  }
}

interface Ctx {
  d: Db;
  job: Job;
  chapter: Chapter;
  book: Book;
  paragraphs: Paragraph[];
  byIdx: Map<number, Paragraph>;
  translationId: string;
  settings: Settings;
  limitUsd: number;
  month: string;
  prevChapterTail: string[];
  terms: Awaited<ReturnType<typeof listTerms>>;
  addresses: Awaited<ReturnType<typeof listAddresses>>;
  started: number;
  now: () => number;
  lastBeat: number;
  calls: number;
}

export async function runJob(jobId: string, deps: WorkerDeps = {}): Promise<"done" | "relayed" | "blocked" | "failed" | "busy"> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const d = await db();
  const job = await claimJob(d, jobId);
  if (!job) return "busy";

  const relay = async () => {
    await releaseJob(d, job.id, job.attempt);
    if (deps.relay) return deps.relay(job.id);
    if (deps.origin) return defaultRelay(d, deps.origin, job.id);
    // Без адреса эстафету подхватит опрос читалки или ежедневный крон.
  };

  let ctx: Ctx | null = null;
  try {
    ctx = await prepare(d, job, now);

    if (!job.termsExtracted) {
      await extractStep(ctx);
      await beat(ctx, { termsExtracted: true }, true);
      ctx.terms = await listTerms(d, ctx.book.id);
      ctx.addresses = await listAddresses(d, ctx.book.id);
      ctx.book = (await getBook(d, ctx.book.id)) ?? ctx.book;
    }

    const chunks = splitIntoChunks(ctx.paragraphs);
    await beat(ctx, { chunksTotal: chunks.length }, true);
    for (let i = job.nextChunk; i < chunks.length; i += 1) {
      if (now() - ctx.started > budgetMs) {
        await relay();
        return "relayed";
      }
      const chunk = chunks[i];
      // Остатки прерванной попытки этой части — выбросить и перевести заново.
      await deleteParagraphRange(d, ctx.translationId, chunk.from, chunk.to);
      await translateRange(ctx, chunk.from, chunk.to, 0);
      await beat(ctx, { nextChunk: i + 1 }, true);
    }

    await finishTranslation(d, ctx.translationId);
    await setJobState(d, job.id, "done");
    return "done";
  } catch (e) {
    if (e instanceof TakenOver) return "busy";
    if (e instanceof OutOfTime) {
      await relay();
      return "relayed";
    }
    if (e instanceof BudgetBlocked) {
      const s = ctx ? await budgetState(d, ctx.limitUsd, ctx.month) : null;
      await setJobState(d, job.id, "blocked_budget", {
        code: "budget_limit",
        message: s ? `Месячный лимит исчерпан: потрачено ${s.spentUsd.toFixed(2)} из ${s.limitUsd.toFixed(2)} $.` : "Месячный лимит исчерпан.",
      });
      return "blocked";
    }
    if (e instanceof ApiFailure) {
      if (e.code === "credit_low") {
        await setJobState(d, job.id, "blocked_credit", { code: e.code, message: e.message });
        return "blocked";
      }
      if (e.retryable && job.attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(30_000, 5_000 * job.attempt));
        await relay();
        return "relayed";
      }
      await setJobState(d, job.id, "failed", { code: e.code, message: e.message });
      if (ctx) await failTranslation(d, ctx.translationId);
      return "failed";
    }
    const message = e instanceof Error ? e.message : String(e);
    await setJobState(d, job.id, "failed", { code: "unknown", message });
    if (ctx) await failTranslation(d, ctx.translationId).catch(() => undefined);
    return "failed";
  }
}

async function prepare(d: Db, job: Job, now: () => number): Promise<Ctx> {
  const chapter = await getChapter(d, job.chapterId);
  if (!chapter) throw new Error("Глава не найдена.");
  const book = await getBook(d, chapter.bookId);
  if (!book) throw new Error("Книга не найдена.");
  const [paragraphs, settings, terms, addresses] = await Promise.all([
    getParagraphs(d, chapter.id),
    getSettings(d),
    listTerms(d, book.id),
    listAddresses(d, book.id),
  ]);
  let translationId = job.translationId;
  if (!translationId) {
    const t = await createTranslation(d, { chapterId: chapter.id, model: job.model, mode: "sync", glossaryVersion: book.glossaryVersion });
    translationId = t.id;
    if (!(await heartbeat(d, job.id, job.attempt, { translationId }))) throw new TakenOver();
  }
  const { prev } = await neighbors(d, chapter);
  const prevChapterTail = prev ? await tailOfChapter(d, prev.id, 3) : [];
  return {
    d,
    job,
    chapter,
    book,
    paragraphs,
    byIdx: new Map(paragraphs.map((p) => [p.idx, p])),
    translationId,
    settings,
    limitUsd: settings.monthlyLimitRub / settings.usdRub,
    month: monthKey(),
    prevChapterTail,
    terms,
    addresses,
    started: now(),
    now,
    lastBeat: now(),
    calls: 0,
  };
}

async function beat(ctx: Ctx, patch?: Parameters<typeof heartbeat>[3], force = false): Promise<void> {
  if (!force && ctx.now() - ctx.lastBeat < HEARTBEAT_EVERY_MS) return;
  ctx.lastBeat = ctx.now();
  if (!(await heartbeat(ctx.d, ctx.job.id, ctx.job.attempt, patch))) throw new TakenOver();
}

/** Записать расход вызова: журнал (один раз на ключ), бюджет, стоимость версии. */
async function account(ctx: Ctx, purpose: "translate" | "extract", model: string, usage: Usage, reserved: number, stopReason: string | null): Promise<void> {
  ctx.calls += 1;
  const usd = usd6(usageCostUsd(model as ModelId, usage));
  const fresh = await recordApiCall(ctx.d, {
    jobId: ctx.job.id,
    chapterId: ctx.chapter.id,
    bookId: ctx.book.id,
    purpose,
    idemKey: `${ctx.job.id}:${ctx.job.attempt}:${ctx.calls}`,
    model,
    usage,
    stopReason,
    usd,
  });
  await settle(ctx.d, reserved, fresh ? usd : 0, ctx.month);
  // Разбор терминов — тоже часть цены этой главы.
  if (fresh) await addTranslationCost(ctx.d, ctx.translationId, usd);
}

async function reserveOrBlock(ctx: Ctx, usd: number): Promise<void> {
  if (!(await reserve(ctx.d, usd, ctx.limitUsd, ctx.month))) throw new BudgetBlocked();
}

/** Разбор терминов до перевода. Неудача разбора не мешает переводу — кроме денег и ключа. */
async function extractStep(ctx: Ctx): Promise<void> {
  const model = ctx.settings.extractModel;
  const text = ctx.paragraphs.map((p) => p.text).join("\n\n");
  const worst = usd6(worstCaseUsd(model, estimateTokens(text) + 3000, 8000));
  await reserveOrBlock(ctx, worst);
  const out = await extractTerms({
    model,
    chapterText: text,
    known: ctx.terms.map((t) => ({ en: t.en, ru: t.ru, kind: t.kind, aliases: t.aliases })),
    knownAddresses: ctx.addresses
      .map((a) => {
        const from = ctx.terms.find((t) => t.id === a.fromTermId);
        const to = ctx.terms.find((t) => t.id === a.toTermId);
        return from && to ? { fromEn: from.en, toEn: to.en, form: a.form } : null;
      })
      .filter((a): a is { fromEn: string; toEn: string; form: "ty" | "vy" } => a !== null),
    isFirstChapterOfBook: await isFirstChapterOfBook(ctx.d, ctx.chapter),
  });
  if (out.kind === "error") {
    await settle(ctx.d, worst, 0, ctx.month);
    if (out.code === "credit_low" || out.code === "auth" || out.code === "console_limit") throw new ApiFailure(out.code, out.message, false);
    return;
  }
  await account(ctx, "extract", out.model, out.usage, worst, out.kind === "refused" ? "refusal" : "end_turn");
  if (out.kind !== "ok") return;
  await mergeProposals(ctx.d, ctx.book.id, ctx.chapter.id, out.result.terms, out.result.addresses);
  // Рассказчик и стиль — только заполнить пустое: решения человека не трогаем.
  const patch: Parameters<typeof updateBook>[2] = {};
  if (ctx.book.narratorPerson == null && out.result.narrator?.person) patch.narratorPerson = out.result.narrator.person;
  if (ctx.book.narratorGender == null && out.result.narrator?.gender && out.result.narrator.person === 1) patch.narratorGender = out.result.narrator.gender;
  if (out.result.register && (await isFirstChapterOfBook(ctx.d, ctx.chapter)) && ctx.book.register === "plain") patch.register = out.result.register;
  if (Object.keys(patch).length > 0) await updateBook(ctx.d, ctx.book.id, patch);
}

/**
 * Перевести диапазон абзацев [from, to]. Цепочка моделей при отказе, затем
 * половинки; пропущенные моделью абзацы — повтором только их.
 */
async function translateRange(ctx: Ctx, from: number, to: number, depth: number): Promise<void> {
  if (depth > 0 && ctx.now() - ctx.started > HARD_STOP_MS) throw new OutOfTime();
  const paragraphs: Paragraph[] = [];
  for (let i = from; i <= to; i += 1) {
    const p = ctx.byIdx.get(i);
    if (p) paragraphs.push(p);
  }
  if (paragraphs.length === 0) return;

  const primary = ctx.job.model;
  for (const model of refusalChain(primary)) {
    const previousTail = from <= 1 ? ctx.prevChapterTail : await tailBefore(ctx.d, ctx.translationId, from, 3);
    const req = buildTranslateRequest(
      {
        book: ctx.book,
        chapterNumber: ctx.chapter.number,
        paragraphs,
        terms: ctx.terms,
        addresses: ctx.addresses,
        previousTail,
        summary: null,
      },
      model,
      ctx.job.effort,
    );
    const worst = usd6(worstCaseUsd(model, req.inputTokensEstimate, req.maxTokens));
    await reserveOrBlock(ctx, worst);

    const outcome = await translateChunk(req, model, ctx.job.effort, { from, to }, async (p) => {
      await upsertParagraph(ctx.d, ctx.translationId, p);
      await beat(ctx);
    });

    if (outcome.kind === "error") {
      await settle(ctx.d, worst, 0, ctx.month);
      throw new ApiFailure(outcome.code, outcome.message, outcome.retryable);
    }
    await account(ctx, "translate", outcome.model, outcome.usage, worst, outcome.kind === "refused" ? "refusal" : outcome.kind === "truncated" ? "max_tokens" : outcome.stopReason);

    if (outcome.kind === "refused") {
      await deleteParagraphRange(ctx.d, ctx.translationId, from, to);
      continue;
    }
    const got = outcome.paragraphs.map((p) => p.idx);
    const missing = missingIdx({ from, to }, got).filter((i) => ctx.byIdx.has(i));
    for (const [a, b] of runs(missing)) {
      if (from === to) {
        // Даже один абзац отдельным запросом не вернулся — честный заменитель.
        await upsertParagraph(ctx.d, ctx.translationId, { idx: a, text: SKIPPED_PLACEHOLDER, refused: true });
      } else if (depth < 2) {
        await translateRange(ctx, a, b, depth + 1);
      } else {
        // Последняя попытка — по одному абзацу: короткий запрос модель не урежет.
        for (let i = a; i <= b; i += 1) await translateRange(ctx, i, i, depth + 1);
      }
    }
    return;
  }

  // Все модели отказались: пробуем половинками, одиночный абзац — заменитель.
  const halves = halveRange(from, to);
  if (halves && depth < 4) {
    await translateRange(ctx, halves[0][0], halves[0][1], depth + 1);
    await translateRange(ctx, halves[1][0], halves[1][1], depth + 1);
    return;
  }
  for (let i = from; i <= to; i += 1) {
    if (ctx.byIdx.has(i)) await upsertParagraph(ctx.d, ctx.translationId, { idx: i, text: REFUSED_PLACEHOLDER, refused: true });
  }
}

/** [3,4,5,9,10] → [[3,5],[9,10]]. */
function runs(sorted: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

async function defaultRelay(d: Db, origin: string, jobId: string): Promise<void> {
  const secret = await relaySecret(d);
  try {
    await fetch(`${origin}/api/jobs/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-secret": secret },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Не дошло — задачу подхватит опрос читалки или крон: аренда уже отпущена.
  }
}

export async function relaySecret(d: Db): Promise<string> {
  return getOrCreateSecret(d, "relay_secret", newToken);
}

/** Запустить задачу главы (создать или взять живую) и вернуть её id. Сам запуск — через after() в маршруте. */
export async function startTranslation(chapterId: string, opts?: { model?: ModelId }): Promise<{ jobId: string; created: boolean; job: Job }> {
  const d = await db();
  const settings = await getSettings(d);
  const model = opts?.model ?? settings.translateModel;
  if (!model) throw new Error("Сначала выберите модель перевода в настройках.");
  const { job, created } = await createOrGetJob(d, { chapterId, model, effort: settings.translateEffort });
  return { jobId: job.id, created, job };
}

/** Нужно ли толкнуть задачу: она ждёт в очереди или её исполнитель пропал. */
export function needsKick(job: Job, nowMs: number = Date.now()): boolean {
  if (job.state === "queued") return true;
  if (job.state === "running") return !job.leaseUntil || Date.parse(job.leaseUntil) < nowMs;
  return false;
}

export { getJob };
