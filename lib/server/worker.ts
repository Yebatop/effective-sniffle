/**
 * Исполнитель задачи перевода. Вызывается из after() в маршрутах; один
 * вызов работает не дольше ~200 с (предел функции на Vercel Hobby — 300 с,
 * и при превышении не выполняются ни catch, ни finally), затем передаёт
 * эстафету POST-запросом на /api/jobs/run с секретом эстафеты.
 *
 * Шаги: захват (claimJob) → разбор терминов, если ещё не было (до перевода!)
 * → части по порядку с next_chunk: резерв бюджета → translateChunk с
 * цепочкой моделей при отказе (refusalChain) → если все отказали — та же
 * часть половинками (halveRange), одиночный абзац — заменитель
 * «[Модель отказалась переводить этот абзац]» с refused=true → запись
 * абзацев, учёт расхода (recordApiCall с idemKey), settle, heartbeat с
 * nextChunk+1 → по завершении finishTranslation, задача done.
 * Недописанная часть при обрыве удаляется (deleteParagraphRange) перед повтором.
 * Ошибки: credit_low → blocked_credit; budget → blocked_budget; auth →
 * failed; rate_limit/overloaded → до 3 повторов с паузой, потом эстафета.
 */

export interface WorkerDeps {
  /** Как передать эстафету: по умолчанию fetch POST на /api/jobs/run. */
  relay?: (jobId: string) => Promise<void>;
  /** Сколько миллисекунд можно работать в одном вызове. */
  budgetMs?: number;
  now?: () => number;
}

export async function runJob(jobId: string, deps?: WorkerDeps): Promise<"done" | "relayed" | "blocked" | "failed" | "busy"> {
  throw new Error("not implemented");
}

/** Запустить задачу главы (создать или взять живую) и вернуть её id. Сам запуск — через after(). */
export async function startTranslation(chapterId: string, opts?: { model?: import("../types").ModelId }): Promise<{ jobId: string; created: boolean }> {
  throw new Error("not implemented");
}
