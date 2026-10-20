/**
 * Сбор глоссария по готовому переводу — фоновая задача, как перевод главы:
 * аренда, эстафета на /api/glossary/run, резерв бюджета на каждый вызов.
 *
 * Этап scan: главы готового перевода пачками (до 4 глав и ~9 тыс. слов) —
 * дешёвая модель выписывает русские имена и термины в ref_terms. Каждая
 * пачка помечается прочитанной сразу после записи: обрыв не заставит
 * платить за неё снова.
 *
 * Этап align: главы, которые есть и по-английски, и в готовом переводе
 * (последние, до ALIGN_MAX), — модель составляет пары «английское →
 * русское» и пишет их в глоссарий (source = reference). В конце имена
 * готового перевода связываются с терминами; несвязанные остаются
 * подсказками для разбора новых глав.
 */

import { db, type Db } from "../db/client";
import { getBook, getParagraphs } from "../db/books";
import {
  addGlossarySpent,
  bumpGlossaryRetries,
  claimGlossaryJob,
  createOrGetGlossaryJob,
  glossaryHeartbeat,
  latestGlossaryJob,
  releaseGlossaryJob,
  setGlossaryStateIf,
  takeOrphanGlossaryReservation,
  trackGlossaryReservation,
} from "../db/glossary-jobs";
import { budgetState, monthKey, recordApiCall, reserve, settle } from "../db/money";
import { getSettings } from "../db/misc";
import {
  getRefChapter,
  linkRefTerms,
  markScanned,
  mergeRefTerms,
  refCounts,
  refPairCount,
  refPairs,
  refTermCounts,
  unscannedRefChapters,
} from "../db/reference";
import { listTerms, mergeReferenceTerms } from "../db/terms";
import { estimateGlossaryUsd, estimateTokens, usageCostUsd, worstCaseUsd } from "../core/cost";
import { alignRefTerms, scanRefTerms, type JsonOutcome } from "./anthropic";
import { relaySecret } from "./worker";
import type { ErrorCode, GlossaryJob, ModelId, RefSummary, Usage } from "../types";

/** Модель сбора: имена читает и дешёвая. */
export const GLOSSARY_MODEL: ModelId = "claude-haiku-5-5";
/** Пачка чтения: глав и слов не больше этого (вход Haiku дорожает после 100K токенов). */
export const SCAN_BATCH_CHAPTERS = 4;
export const SCAN_BATCH_WORDS = 9000;
/** Пар глав на сверку: последние, в них нынешние герои. */
export const ALIGN_MAX = 12;
/** Текст главы в сверке режется до этого — цена предсказуема и для огромных глав. */
const ALIGN_MAX_CHARS = 40_000;
/** Известных пар в запросе сверки — не больше. */
const ALIGN_KNOWN_MAX = 150;

const DEFAULT_BUDGET_MS = 150_000;
const CALL_DEADLINE_MS = 270_000;
const HEARTBEAT_MS = 20_000;
const MAX_RETRIES = 5;

const usd6 = (x: number) => Math.ceil(x * 1e6) / 1e6;

export interface GlossaryDeps {
  origin?: string;
  relay?: (jobId: string) => Promise<void>;
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
}

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
  job: GlossaryJob;
  limitUsd: number;
  month: string;
  started: number;
  now: () => number;
  heartbeatMs: number;
  calls: number;
}

export async function runGlossaryJob(jobId: string, deps: GlossaryDeps = {}): Promise<"done" | "relayed" | "blocked" | "failed" | "busy"> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const d = await db();
  const job = await claimGlossaryJob(d, jobId);
  if (!job) return "busy";

  const orphan = await takeOrphanGlossaryReservation(d, job.id);
  if (orphan.usd > 0) await settle(d, orphan.usd, 0, orphan.month ?? monthKey());

  const relay = async () => {
    await releaseGlossaryJob(d, job.id, job.attempt);
    if (deps.relay) return deps.relay(job.id);
    if (deps.origin) return defaultRelay(d, deps.origin, job.id);
  };
  const finish = (state: Parameters<typeof setGlossaryStateIf>[3], error?: { code: ErrorCode; message: string }) =>
    setGlossaryStateIf(d, job.id, job.attempt, state, error ?? null);

  const settings = await getSettings(d);
  const ctx: Ctx = {
    d,
    job,
    limitUsd: settings.monthlyLimitRub / settings.usdRub,
    month: monthKey(),
    started: now(),
    now,
    heartbeatMs: deps.heartbeatMs ?? HEARTBEAT_MS,
    calls: 0,
  };

  try {
    if (!(await getBook(d, job.bookId))) throw new Error("Книга не найдена.");
    let stage = job.stage;
    let scanDone = job.scanDone;
    // Хотя бы один шаг за заход — иначе эстафета могла бы ходить по кругу.
    let worked = false;

    if (stage === "scan") {
      for (;;) {
        if (worked && now() - ctx.started > budgetMs) {
          await relay();
          return "relayed";
        }
        const batch = pickBatch(await unscannedRefChapters(d, job.bookId, SCAN_BATCH_CHAPTERS));
        if (batch.length === 0) break;
        await scanBatch(ctx, batch);
        worked = true;
        scanDone += batch.length;
        await beat(ctx, { scanDone });
      }
      const pairs = await refPairs(d, job.bookId, ALIGN_MAX);
      stage = "align";
      await beat(ctx, { stage, alignTotal: pairs.length, alignDone: 0 });
      job.alignDone = 0;
    }

    if (stage === "align") {
      const pairs = await refPairs(d, job.bookId, ALIGN_MAX);
      for (let i = job.alignDone; i < pairs.length; i += 1) {
        if (worked && now() - ctx.started > budgetMs) {
          await relay();
          return "relayed";
        }
        await alignPair(ctx, pairs[i]);
        worked = true;
        await beat(ctx, { alignDone: i + 1, alignTotal: pairs.length });
      }
    }

    await linkRefTerms(d, job.bookId);
    await finish("done");
    return "done";
  } catch (e) {
    if (e instanceof TakenOver) return "busy";
    if (e instanceof OutOfTime) {
      await relay();
      return "relayed";
    }
    if (e instanceof BudgetBlocked) {
      const s = await budgetState(d, ctx.limitUsd, ctx.month);
      await finish("blocked_budget", {
        code: "budget_limit",
        message: `Месячный лимит исчерпан: потрачено ${s.spentUsd.toFixed(2)} из ${s.limitUsd.toFixed(2)} $.`,
      });
      return "blocked";
    }
    if (e instanceof ApiFailure) {
      if (e.code === "credit_low") {
        await finish("blocked_credit", { code: e.code, message: e.message });
        return "blocked";
      }
      if (e.retryable && (await bumpGlossaryRetries(d, job.id)) <= MAX_RETRIES) {
        await sleep(Math.min(30_000, 5_000 * Math.max(1, job.retries + 1)));
        await relay();
        return "relayed";
      }
      await finish("failed", { code: e.code, message: e.message });
      return "failed";
    }
    console.error("runGlossaryJob", e);
    await finish("failed", { code: "unknown", message: e instanceof Error ? e.message : String(e) });
    return "failed";
  }
}

/** Пачка: подряд, пока не больше SCAN_BATCH_WORDS слов (первая глава берётся всегда). */
function pickBatch<T extends { words: number }>(list: T[]): T[] {
  const out: T[] = [];
  let words = 0;
  for (const c of list) {
    if (out.length > 0 && words + c.words > SCAN_BATCH_WORDS) break;
    out.push(c);
    words += c.words;
  }
  return out;
}

async function scanBatch(ctx: Ctx, batch: Awaited<ReturnType<typeof unscannedRefChapters>>): Promise<void> {
  const chapters = batch.map((c) => ({ number: c.number, title: c.title, text: c.paragraphs.join("\n\n") }));
  const tokens = chapters.reduce((s, c) => s + estimateTokens(c.text), 0) + 2000;
  const worst = usd6(worstCaseUsd(GLOSSARY_MODEL, tokens, 6000));
  await reserveOrBlock(ctx, worst);
  const { result: out, takenOver, timedOut } = await supervised(ctx, (signal) => scanRefTerms({ model: GLOSSARY_MODEL, chapters }, { signal }));
  await account(ctx, out, worst);
  if (takenOver) throw new TakenOver();
  if (timedOut) throw new OutOfTime();
  if (out.kind === "error") throw new ApiFailure(out.code, out.message, out.retryable);
  if (out.kind === "ok") {
    const numbers = batch.map((c) => c.number);
    await mergeRefTerms(
      ctx.d,
      ctx.job.bookId,
      out.result.terms.map((t) => {
        const own = t.chapters.filter((n) => numbers.includes(n));
        return { ru: t.ru, kind: t.kind, gender: t.gender, note: t.note, numbers: own.length ? own : numbers };
      }),
    );
  }
  // Отказ модели — главу не мучаем: имена из неё соберутся из соседних.
  await markScanned(ctx.d, batch.map((c) => c.id));
}

async function alignPair(ctx: Ctx, pair: { number: number; chapterId: string; refId: string }): Promise<void> {
  const [en, ru, terms] = await Promise.all([getParagraphs(ctx.d, pair.chapterId), getRefChapter(ctx.d, pair.refId), listTerms(ctx.d, ctx.job.bookId)]);
  if (!ru || en.length === 0) return;
  const enText = en.map((p) => p.text).join("\n\n").slice(0, ALIGN_MAX_CHARS);
  const ruText = ru.paragraphs.join("\n\n").slice(0, ALIGN_MAX_CHARS);
  const known = terms
    .filter((t) => t.source === "reference" || t.status === "checked")
    .slice(0, ALIGN_KNOWN_MAX)
    .map((t) => ({ en: t.en, ru: t.ru }));
  const tokens = estimateTokens(enText) + estimateTokens(ruText) + 4000;
  const worst = usd6(worstCaseUsd(GLOSSARY_MODEL, tokens, 8000));
  await reserveOrBlock(ctx, worst);
  const { result: out, takenOver, timedOut } = await supervised(ctx, (signal) =>
    alignRefTerms({ model: GLOSSARY_MODEL, number: pair.number, en: enText, ru: ruText, known }, { signal }),
  );
  await account(ctx, out, worst);
  if (takenOver) throw new TakenOver();
  if (timedOut) throw new OutOfTime();
  if (out.kind === "error") throw new ApiFailure(out.code, out.message, out.retryable);
  if (out.kind !== "ok") return;
  await mergeReferenceTerms(
    ctx.d,
    ctx.job.bookId,
    pair.chapterId,
    out.result.pairs.map((p) => ({ en: p.en, ru: p.ru, kind: p.kind, gender: p.gender, aliases: p.aliases, note: p.note })),
  );
}

async function beat(ctx: Ctx, patch?: Parameters<typeof glossaryHeartbeat>[3]): Promise<void> {
  if (!(await glossaryHeartbeat(ctx.d, ctx.job.id, ctx.job.attempt, patch))) throw new TakenOver();
}

/** Вызов под присмотром: аренда продлевается, к сроку вызов обрывается (как в worker.ts). */
async function supervised<T>(ctx: Ctx, fn: (signal: AbortSignal) => Promise<T>): Promise<{ result: T; takenOver: boolean; timedOut: boolean }> {
  const left = ctx.started + CALL_DEADLINE_MS - ctx.now();
  if (left < 5_000) throw new OutOfTime();
  const control = new AbortController();
  const deadline = AbortSignal.timeout(left);
  const signal = AbortSignal.any([control.signal, deadline]);
  let takenOver = false;
  const timer = setInterval(() => {
    glossaryHeartbeat(ctx.d, ctx.job.id, ctx.job.attempt)
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

async function reserveOrBlock(ctx: Ctx, usd: number): Promise<void> {
  if (!(await reserve(ctx.d, usd, ctx.limitUsd, ctx.month))) throw new BudgetBlocked();
  await trackGlossaryReservation(ctx.d, ctx.job.id, usd, ctx.month);
}

async function account(ctx: Ctx, out: JsonOutcome<unknown>, reserved: number): Promise<void> {
  ctx.calls += 1;
  const usage: Usage = out.usage;
  const usd = usd6(usageCostUsd(out.model, usage, { requested: GLOSSARY_MODEL }));
  const fresh = await recordApiCall(ctx.d, {
    jobId: null,
    chapterId: null,
    bookId: ctx.job.bookId,
    purpose: "glossary",
    idemKey: `glossary:${ctx.job.id}:${ctx.job.attempt}:${ctx.calls}`,
    model: out.model,
    usage,
    stopReason: out.kind === "refused" ? "refusal" : out.kind === "error" ? "error" : "end_turn",
    usd,
  });
  await settle(ctx.d, reserved, fresh ? usd : 0, ctx.month);
  await trackGlossaryReservation(ctx.d, ctx.job.id, -reserved, ctx.month);
  if (fresh) await addGlossarySpent(ctx.d, ctx.job.id, usd);
}

async function defaultRelay(d: Db, origin: string, jobId: string): Promise<void> {
  const secret = await relaySecret(d);
  try {
    await fetch(`${origin}/api/glossary/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-secret": secret },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Не дошло — подхватит крон или открытая страница книги.
  }
}

/** Что сейчас стоит сбор: непрочитанные главы пачками + сверка последних пар. */
export async function glossaryEstimateUsd(d: Db, bookId: string): Promise<{ usd: number; scanTotal: number; alignTotal: number }> {
  const counts = await refCounts(d, bookId);
  const pairs = await refPairs(d, bookId, ALIGN_MAX);
  let alignEnWords = 0;
  let alignRuWords = 0;
  if (pairs.length > 0) {
    const r = await d.query(
      `select coalesce(sum(c.words), 0)::int as en, coalesce(sum(rc.words), 0)::int as ru
       from chapters c join ref_chapters rc on rc.id = any($2::uuid[]) and rc.number = c.number and rc.book_id = c.book_id
       where c.id = any($1::uuid[])`,
      [pairs.map((p) => p.chapterId), pairs.map((p) => p.refId)],
    );
    alignEnWords = Number(r.rows[0]?.en ?? 0);
    alignRuWords = Number(r.rows[0]?.ru ?? 0);
  }
  const scanCalls = Math.max(Math.ceil(counts.unscanned / SCAN_BATCH_CHAPTERS), Math.ceil(counts.unscannedWords / SCAN_BATCH_WORDS));
  const usd = estimateGlossaryUsd(GLOSSARY_MODEL, {
    scanWords: counts.unscannedWords,
    scanCalls,
    alignEnWords,
    alignRuWords,
    alignPairs: pairs.length,
  });
  return { usd, scanTotal: counts.unscanned, alignTotal: pairs.length };
}

/** Запустить сбор (или взять живую задачу). Сам запуск — через after() в маршруте. */
export async function startGlossaryJob(bookId: string): Promise<{ job: GlossaryJob; created: boolean }> {
  const d = await db();
  const { scanTotal, alignTotal } = await glossaryEstimateUsd(d, bookId);
  if (scanTotal === 0 && alignTotal === 0) throw new Error("Нет глав готового перевода — сначала соберите их кнопкой «Т» на сайте с переводом.");
  return createOrGetGlossaryJob(d, { bookId, model: GLOSSARY_MODEL, scanTotal, alignTotal });
}

export async function refSummary(d: Db, bookId: string): Promise<RefSummary> {
  const [counts, pairs, terms, est, job] = await Promise.all([
    refCounts(d, bookId),
    refPairCount(d, bookId),
    refTermCounts(d, bookId),
    glossaryEstimateUsd(d, bookId),
    latestGlossaryJob(d, bookId),
  ]);
  return {
    count: counts.count,
    minNumber: counts.minNumber,
    maxNumber: counts.maxNumber,
    pairs,
    unscanned: counts.unscanned,
    hints: terms.hints,
    matched: terms.matched,
    estimateUsd: est.usd,
    job,
  };
}

/** Нужно ли толкнуть задачу: в очереди или исполнитель пропал. */
export function glossaryNeedsKick(job: GlossaryJob, nowMs: number = Date.now()): boolean {
  if (job.state === "queued") return true;
  if (job.state === "running") return !job.leaseUntil || Date.parse(job.leaseUntil) < nowMs;
  return false;
}
