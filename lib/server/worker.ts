/**
 * Исполнитель задачи перевода. Вызывается из after() в маршрутах; один
 * вызов работает не дольше ~200 с (предел функции на Vercel Hobby — 300 с,
 * и при превышении не выполняются ни catch, ни finally), затем передаёт
 * эстафету POST-запросом на /api/jobs/run с секретом эстафеты.
 *
 * Шаги: захват (claimJob) → возврат резерва, оставшегося от убитого захода →
 * разбор терминов, если ещё не было (до перевода!) → части по порядку с
 * next_chunk; в части переводятся только недостающие абзацы: готовые после
 * обрыва не оплачиваются второй раз. На каждый вызов модели: резерв бюджета
 * (на задаче тоже — чтобы его можно было вернуть) → вызов со сторожем аренды
 * и предельным сроком → учёт фактического расхода, даже если поток оборвался.
 * Отказ модели — следующая модель цепочки, потом половинки, одиночный абзац —
 * заменитель. На одну часть — не больше трёх заходов, потом пропущенное
 * получает заменитель, а перевод идёт дальше.
 *
 * Состояние задачи пишет только та попытка, которая её держит: сменённый
 * исполнитель тихо выходит, не затирая работу нового.
 */

import { db, type Db } from "../db/client";
import { getBook, getChapter, getParagraphs, isFirstChapterOfBook, neighbors, updateBook } from "../db/books";
import {
  bumpChunkTries,
  bumpRetries,
  claimJob,
  createOrGetJob,
  getJob,
  heartbeat,
  latestJobForChapter,
  releaseJob,
  setJobStateIf,
  takeOrphanReservation,
  trackReservation,
} from "../db/jobs";
import { budgetState, monthKey, recordApiCall, reserve, settle } from "../db/money";
import { getOrCreateSecret, getSettings } from "../db/misc";
import { listAddresses, listTerms, mergeProposals } from "../db/terms";
import {
  addTranslationCost,
  createTranslation,
  doneIdx,
  deleteParagraphRange,
  failTranslation,
  finishTranslation,
  reviveTranslation,
  tailBefore,
  tailOfChapter,
  upsertParagraph,
} from "../db/translations";
import { halveRange, splitIntoChunks } from "../core/chunk";
import { missingIdx } from "../core/labels";
import { MODELS, refusalChain } from "../core/models";
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
  /** Как часто продлевать аренду во время вызова модели, мс. */
  heartbeatMs?: number;
}

/** Новую часть начинаем, только если до предела функции хватит времени на неё. */
const DEFAULT_BUDGET_MS = 150_000;
/** Подразбиения (пропуски, отказы) — пока прошло меньше этого. */
const HARD_STOP_MS = 210_000;
/** Любой вызов модели обрывается к этой отметке: до 300 с остаётся запас на учёт и эстафету. */
const CALL_DEADLINE_MS = 270_000;
/** Повторов после временных ошибок (перегрузка, сеть) на одну часть. */
const MAX_RETRIES = 5;
/** Заходов на одну часть, после которых недостающее получает заменитель. */
const MAX_CHUNK_TRIES = 3;
const REFUSED_PLACEHOLDER = "[Модель отказалась переводить этот абзац]";
const SKIPPED_PLACEHOLDER = "[Абзац не переведён]";
const HEARTBEAT_MS = 20_000;

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
  heartbeatMs: number;
  calls: number;
}

export async function runJob(jobId: string, deps: WorkerDeps = {}): Promise<"done" | "relayed" | "blocked" | "failed" | "busy"> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const d = await db();
  const job = await claimJob(d, jobId);
  if (!job) return "busy";

  // Прошлый заход убили посреди вызова — его резерв вернуть в лимит.
  const orphan = await takeOrphanReservation(d, job.id);
  if (orphan.usd > 0) await settle(d, orphan.usd, 0, orphan.month ?? monthKey());

  const relay = async () => {
    await releaseJob(d, job.id, job.attempt);
    if (deps.relay) return deps.relay(job.id);
    if (deps.origin) return defaultRelay(d, deps.origin, job.id);
    // Без адреса эстафету подхватит опрос читалки или ежедневный крон.
  };
  const finish = (state: Parameters<typeof setJobStateIf>[3], error?: { code: ErrorCode; message: string }) =>
    setJobStateIf(d, job.id, job.attempt, state, error ?? null);

  let ctx: Ctx | null = null;
  try {
    ctx = await prepare(d, job, now, deps.heartbeatMs ?? HEARTBEAT_MS);

    if (!job.termsExtracted) {
      await extractStep(ctx);
      await beat(ctx, { termsExtracted: true });
      ctx.terms = await listTerms(d, ctx.book.id);
      ctx.addresses = await listAddresses(d, ctx.book.id);
      ctx.book = (await getBook(d, ctx.book.id)) ?? ctx.book;
    }

    const chunks = splitIntoChunks(ctx.paragraphs);
    await beat(ctx, { chunksTotal: chunks.length });
    for (let i = job.nextChunk; i < chunks.length; i += 1) {
      if (now() - ctx.started > budgetMs) {
        await relay();
        return "relayed";
      }
      const chunk = chunks[i];
      // Счётчик обнуляется, когда часть готова; здесь — +1 на каждый заход в неё.
      const tries = await bumpChunkTries(d, job.id, job.attempt);
      if (tries === null) throw new TakenOver();
      const have = await doneIdx(d, ctx.translationId, chunk.from, chunk.to);
      const missing = rangeIdx(chunk.from, chunk.to).filter((idx) => ctx!.byIdx.has(idx) && !have.has(idx));
      if (tries > MAX_CHUNK_TRIES) {
        // Часть снова и снова не укладывается — не платим за неё бесконечно.
        for (const idx of missing) await upsertParagraph(d, ctx.translationId, { idx, text: SKIPPED_PLACEHOLDER, refused: true });
      } else {
        for (const [a, b] of runs(missing)) await translateRange(ctx, a, b, 0);
      }
      await beat(ctx, { nextChunk: i + 1 });
    }

    await finishTranslation(d, ctx.translationId);
    await finish("done");
    return "done";
  } catch (e) {
    if (e instanceof TakenOver) return "busy";
    if (e instanceof OutOfTime) {
      await relay();
      return "relayed";
    }
    if (e instanceof BudgetBlocked) {
      const s = ctx ? await budgetState(d, ctx.limitUsd, ctx.month) : null;
      await finish("blocked_budget", {
        code: "budget_limit",
        message: s ? `Месячный лимит исчерпан: потрачено ${s.spentUsd.toFixed(2)} из ${s.limitUsd.toFixed(2)} $.` : "Месячный лимит исчерпан.",
      });
      return "blocked";
    }
    if (e instanceof ApiFailure) {
      if (e.code === "credit_low") {
        await finish("blocked_credit", { code: e.code, message: e.message });
        return "blocked";
      }
      if (e.retryable && (await bumpRetries(d, job.id)) <= MAX_RETRIES) {
        await sleep(Math.min(30_000, 5_000 * Math.max(1, job.retries + 1)));
        await relay();
        return "relayed";
      }
      if (await finish("failed", { code: e.code, message: e.message })) {
        if (ctx) await failTranslation(d, ctx.translationId);
      }
      return "failed";
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("runJob", e);
    if (await finish("failed", { code: "unknown", message })) {
      if (ctx) await failTranslation(d, ctx.translationId).catch(() => undefined);
    }
    return "failed";
  }
}

async function prepare(d: Db, job: Job, now: () => number, heartbeatMs: number): Promise<Ctx> {
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
  } else {
    // Продолжаем прерванную версию после «Повторить».
    await reviveTranslation(d, translationId);
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
    heartbeatMs,
    calls: 0,
  };
}

async function beat(ctx: Ctx, patch?: Parameters<typeof heartbeat>[3]): Promise<void> {
  if (!(await heartbeat(ctx.d, ctx.job.id, ctx.job.attempt, patch))) throw new TakenOver();
}

/**
 * Вызов модели под присмотром: пока он идёт, аренда продлевается сама (даже
 * когда модель долго думает и абзацев нет), а к CALL_DEADLINE_MS вызов
 * обрывается — чтобы успеть учесть расход до того, как Vercel убьёт функцию.
 * Если задачу перехватили, вызов тоже обрывается.
 */
async function supervised<T>(ctx: Ctx, fn: (signal: AbortSignal) => Promise<T>): Promise<{ result: T; takenOver: boolean; timedOut: boolean }> {
  const left = ctx.started + CALL_DEADLINE_MS - ctx.now();
  if (left < 5_000) throw new OutOfTime();
  const control = new AbortController();
  const deadline = AbortSignal.timeout(left);
  const signal = AbortSignal.any([control.signal, deadline]);
  let takenOver = false;
  const timer = setInterval(() => {
    heartbeat(ctx.d, ctx.job.id, ctx.job.attempt)
      .then((ok) => {
        if (!ok) {
          takenOver = true;
          control.abort();
        }
      })
      .catch(() => undefined);
  }, ctx.heartbeatMs);
  try {
    const result = await fn(signal);
    return { result, takenOver, timedOut: deadline.aborted };
  } finally {
    clearInterval(timer);
  }
}

/** Резерв бюджета под вызов — в общем лимите и на задаче (чтобы вернуть его, если заход убьют). */
async function reserveOrBlock(ctx: Ctx, usd: number): Promise<void> {
  if (!(await reserve(ctx.d, usd, ctx.limitUsd, ctx.month))) throw new BudgetBlocked();
  await trackReservation(ctx.d, ctx.job.id, usd, ctx.month);
}

/** Записать расход вызова: журнал (один раз на ключ), бюджет, стоимость версии; вернуть резерв. */
async function account(ctx: Ctx, purpose: "translate" | "extract", served: string, requested: ModelId, usage: Usage, reserved: number, stopReason: string | null): Promise<void> {
  ctx.calls += 1;
  // Модель ответа может отличаться от запрошенной (серверный повтор после
  // отказа) — цена берётся по ней, а если она неизвестна — по запрошенной.
  const usd = usd6(usageCostUsd(served, usage, { requested }));
  const fresh = await recordApiCall(ctx.d, {
    jobId: ctx.job.id,
    chapterId: ctx.chapter.id,
    bookId: ctx.book.id,
    purpose,
    idemKey: `${ctx.job.id}:${ctx.job.attempt}:${ctx.calls}`,
    model: served,
    usage,
    stopReason,
    usd,
  });
  await settle(ctx.d, reserved, fresh ? usd : 0, ctx.month);
  await trackReservation(ctx.d, ctx.job.id, -reserved, ctx.month);
  // Разбор терминов — тоже часть цены этой главы.
  if (fresh) await addTranslationCost(ctx.d, ctx.translationId, usd);
}

const hasUsage = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens > 0;

/**
 * Худшая цена вызова. Для моделей с серверным повтором — вдвое: при отказе
 * оплачиваются и отказ, и ответ запасной модели.
 */
function worstFor(model: ModelId, inputTokens: number, maxTokens: number): number {
  const once = worstCaseUsd(model, inputTokens, maxTokens);
  return usd6(MODELS[model].serverFallback ? once * 2 : once);
}

/** Разбор терминов до перевода. Неудача разбора не мешает переводу — кроме денег и ключа. */
async function extractStep(ctx: Ctx): Promise<void> {
  const model = ctx.settings.extractModel;
  const text = ctx.paragraphs.map((p) => p.text).join("\n\n");
  const worst = usd6(worstCaseUsd(model, estimateTokens(text) + 3000, 8000));
  await reserveOrBlock(ctx, worst);
  const isFirst = await isFirstChapterOfBook(ctx.d, ctx.chapter);
  const { result: out, takenOver, timedOut } = await supervised(ctx, (signal) =>
    extractTerms(
      {
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
        isFirstChapterOfBook: isFirst,
      },
      { signal },
    ),
  );
  await account(ctx, "extract", out.model, model, out.usage, worst, out.kind === "refused" ? "refusal" : out.kind === "error" ? "error" : "end_turn");
  if (takenOver) throw new TakenOver();
  if (timedOut) throw new OutOfTime();
  if (out.kind === "error") {
    if (out.code === "credit_low" || out.code === "auth" || out.code === "console_limit") throw new ApiFailure(out.code, out.message, false);
    return;
  }
  if (out.kind !== "ok") return;
  await mergeProposals(ctx.d, ctx.book.id, ctx.chapter.id, out.result.terms, out.result.addresses);
  // Рассказчик и стиль — только заполнить пустое: решения человека не трогаем.
  const patch: Parameters<typeof updateBook>[2] = {};
  if (ctx.book.narratorPerson == null && out.result.narrator?.person) patch.narratorPerson = out.result.narrator.person;
  if (ctx.book.narratorGender == null && out.result.narrator?.gender && out.result.narrator.person === 1) patch.narratorGender = out.result.narrator.gender;
  if (out.result.register && isFirst && ctx.book.register === "plain") patch.register = out.result.register;
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

  for (const model of refusalChain(ctx.job.model)) {
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
    if (ctx.started + CALL_DEADLINE_MS - ctx.now() < 5_000) throw new OutOfTime();
    const worst = worstFor(model, req.inputTokensEstimate, req.maxTokens);
    await reserveOrBlock(ctx, worst);

    const { result: outcome, takenOver, timedOut } = await supervised(ctx, (signal) =>
      translateChunk(req, model, ctx.job.effort, { from, to }, (p) => upsertParagraph(ctx.d, ctx.translationId, p).then(() => undefined), { signal }),
    );

    const stop =
      outcome.kind === "refused" ? "refusal" : outcome.kind === "truncated" ? "max_tokens" : outcome.kind === "ok" ? outcome.stopReason : outcome.kind;
    // Учёт — до любых решений: оборванный и неудачный вызовы тоже оплачены.
    if (outcome.kind === "error" && !hasUsage(outcome.usage)) {
      await settle(ctx.d, worst, 0, ctx.month);
      await trackReservation(ctx.d, ctx.job.id, -worst, ctx.month);
    } else {
      await account(ctx, "translate", outcome.model, model, outcome.usage, worst, stop);
    }
    if (takenOver) throw new TakenOver();
    if (outcome.kind === "aborted") {
      if (timedOut) throw new OutOfTime();
      // Ошибка записи абзаца или смена исполнителя — наверх как есть.
      throw outcome.cause instanceof Error ? outcome.cause : new Error(String(outcome.cause));
    }
    if (outcome.kind === "error") throw new ApiFailure(outcome.code, outcome.message, outcome.retryable);

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

function rangeIdx(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
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

/**
 * Запустить задачу главы (создать или взять живую) и вернуть её id. Сам
 * запуск — через after() в маршруте. Если прошлый перевод той же моделью
 * оборвался ошибкой, новая задача продолжает его: оплаченные части и разбор
 * терминов не повторяются.
 */
export async function startTranslation(chapterId: string, opts?: { model?: ModelId }): Promise<{ jobId: string; created: boolean; job: Job }> {
  const d = await db();
  const settings = await getSettings(d);
  const model = opts?.model ?? settings.translateModel;
  if (!model) throw new Error("Сначала выберите модель перевода в настройках.");
  const chapter = await getChapter(d, chapterId);
  const latest = await latestJobForChapter(d, chapterId);
  const resume =
    latest && latest.state === "failed" && latest.translationId && latest.model === model && !chapter?.currentTranslationId
      ? { translationId: latest.translationId, nextChunk: latest.nextChunk, chunksTotal: latest.chunksTotal, termsExtracted: latest.termsExtracted }
      : undefined;
  const { job, created } = await createOrGetJob(d, { chapterId, model, effort: settings.translateEffort, resume });
  return { jobId: job.id, created, job };
}

/** Нужно ли толкнуть задачу: она ждёт в очереди или её исполнитель пропал. */
export function needsKick(job: Job, nowMs: number = Date.now()): boolean {
  if (job.state === "queued") return true;
  if (job.state === "running") return !job.leaseUntil || Date.parse(job.leaseUntil) < nowMs;
  return false;
}

export { getJob };
