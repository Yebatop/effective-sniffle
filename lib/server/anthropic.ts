/**
 * Вызовы Claude: перевод части потоком и разбор терминов.
 *
 * - Клиент: new Anthropic() — ключ из ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL
 *   переопределяет адрес (так тесты подставляют поддельный сервер).
 * - Перевод — всегда потоком. Для Sonnet/Opus — серверный fallbacks:
 *   "default" (beta server-side-fallback-2026-07-01): при отказе Anthropic сам
 *   повторяет запрос подходящей моделью. Для Haiku серверного повтора нет —
 *   его заменяет своя цепочка в исполнителе.
 * - effort передаётся всегда явно (output_config.effort); thinking не
 *   передаётся (на Opus 5.5 его нельзя выключить; adaptive — по умолчанию).
 * - Отказ — HTTP 200 со stop_reason "refusal": kind "refused", начатый
 *   текст выбрасывает исполнитель. max_tokens — kind "truncated".
 * - Ошибки SDK → ErrorCode через typed-классы, не по тексту сообщения,
 *   кроме двух случаев, у которых нет своего класса: «credit balance is too
 *   low» → credit_low, «specified API usage limits» → console_limit.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createLabelParser } from "../core/labels";
import { MODELS } from "../core/models";
import { polish } from "../core/polish";
import type { BuiltRequest } from "../core/prompt";
import type { ProposedAddress, ProposedTerm } from "../db/terms";
import type { Effort, ErrorCode, ModelId, Usage } from "../types";

export type TranslateOutcome =
  | { kind: "ok"; paragraphs: Array<{ idx: number; text: string }>; usage: Usage; model: string; stopReason: string }
  | { kind: "refused"; usage: Usage; model: string; category: string | null }
  | { kind: "truncated"; paragraphs: Array<{ idx: number; text: string }>; usage: Usage; model: string }
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean; usage?: Usage; model?: string };

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;

/** Один клиент на процесс. Таймаут — меньше предела функции: зависший поток не должен съесть все 300 с. */
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 150_000 });
  return client;
}

/** Для тестов: подменить клиента (или сбросить, чтобы он пересоздался с новым ANTHROPIC_BASE_URL). */
export function __resetClientForTests(c: Anthropic | null = null): void {
  client = c;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 };

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

export function toUsage(u: RawUsage | null | undefined): Usage {
  if (!u) return { ...ZERO_USAGE };
  const split = u.cache_creation;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWrite5mTokens: split ? split.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: split?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** Ошибка SDK → код для экрана и решение, есть ли смысл повторять. */
export function mapError(e: unknown): { code: ErrorCode; message: string; retryable: boolean } {
  const text = e instanceof Error ? e.message : String(e);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { code: "auth", message: "Ключ Anthropic не подходит.", retryable: false };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { code: "rate_limit", message: "Слишком много запросов подряд — Anthropic просит подождать.", retryable: true };
  }
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance is too low/i.test(text)) {
      return { code: "credit_low", message: "На счёте Anthropic закончились деньги.", retryable: false };
    }
    if (/specified API usage limits/i.test(text)) {
      return { code: "console_limit", message: "Сработал лимит трат в Anthropic Console.", retryable: false };
    }
    return { code: "unknown", message: `Anthropic отклонил запрос: ${text}`, retryable: false };
  }
  if (e instanceof Anthropic.InternalServerError) {
    return { code: "overloaded", message: "Anthropic перегружен — попробую ещё раз.", retryable: true };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { code: "network", message: "Не получилось связаться с Anthropic.", retryable: true };
  }
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    if (status === 529 || status >= 500) return { code: "overloaded", message: "Anthropic перегружен — попробую ещё раз.", retryable: true };
    return { code: "unknown", message: text, retryable: false };
  }
  return { code: "unknown", message: text, retryable: false };
}

/**
 * Перевести часть. onParagraph вызывается для каждого завершённого абзаца
 * по мере потока — так читалка видит текст до конца части. Абзацы приходят
 * уже с polish().
 */
export async function translateChunk(
  req: BuiltRequest,
  model: ModelId,
  effort: Effort,
  expected: { from: number; to: number },
  onParagraph: (p: { idx: number; text: string }) => Promise<void> | void,
): Promise<TranslateOutcome> {
  let parser = createLabelParser(expected);
  const done = new Map<number, string>();
  const emit = async (items: Array<{ idx: number; text: string }>) => {
    for (const item of items) {
      const text = polish(item.text);
      if (!text) continue;
      done.set(item.idx, text);
      await onParagraph({ idx: item.idx, text });
    }
  };

  const params = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    output_config: { effort },
  };

  try {
    const stream = MODELS[model].serverFallback
      ? anthropic().beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" })
      : anthropic().messages.stream(params);

    for await (const event of stream as AsyncIterable<{ type: string; content_block?: { type: string }; delta?: { type: string; text?: string } }>) {
      if (event.type === "content_block_start" && event.content_block?.type === "fallback") {
        // Модель отказала посреди ответа, Anthropic продолжил другой моделью:
        // она переводит всё заново, а её абзацы заменят уже показанные.
        parser = createLabelParser(expected);
        continue;
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        await emit(parser.push(event.delta.text));
      }
    }
    const final = (await stream.finalMessage()) as unknown as {
      model: string;
      stop_reason: string | null;
      stop_details?: { category?: string | null } | null;
      usage: RawUsage;
    };
    const usage = toUsage(final.usage);
    if (final.stop_reason === "refusal") {
      return { kind: "refused", usage, model: final.model, category: final.stop_details?.category ?? null };
    }
    if (final.stop_reason === "max_tokens") {
      // Последний абзац оборван на полуслове — его не берём.
      return { kind: "truncated", paragraphs: toList(done), usage, model: final.model };
    }
    await emit(parser.finish());
    return { kind: "ok", paragraphs: toList(done), usage, model: final.model, stopReason: final.stop_reason ?? "end_turn" };
  } catch (e) {
    return { kind: "error", ...mapError(e) };
  }
}

function toList(done: Map<number, string>): Array<{ idx: number; text: string }> {
  return [...done.entries()].sort((a, b) => a[0] - b[0]).map(([idx, text]) => ({ idx, text }));
}

// ── Разбор терминов ─────────────────────────────────────────────────────

export interface ExtractionResult {
  terms: ProposedTerm[];
  addresses: ProposedAddress[];
  narrator: { person: 1 | 3 | null; gender: "m" | "f" | "unknown" | null } | null;
  /** Предложение стиля по жанру: live/plain/elevated. */
  register: "live" | "plain" | "elevated" | null;
}

export type ExtractOutcome =
  | { kind: "ok"; result: ExtractionResult; usage: Usage; model: string }
  | { kind: "refused"; usage: Usage; model: string }
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean };

const ExtractionSchema = z.object({
  terms: z.array(
    z.object({
      en: z.string(),
      ru: z.string(),
      kind: z.enum(["name", "title", "technique", "place", "org", "item", "other"]),
      gender: z.enum(["m", "f", "n", "unknown"]).nullable(),
      aliases: z.array(z.string()),
      note: z.string().nullable(),
    }),
  ),
  addresses: z.array(z.object({ from: z.string(), to: z.string(), form: z.enum(["ty", "vy"]) })),
  narrator: z
    .object({
      person: z.enum(["first", "third"]).nullable(),
      gender: z.enum(["m", "f", "unknown"]).nullable(),
    })
    .nullable(),
  register: z.enum(["live", "plain", "elevated"]).nullable(),
});

export const EXTRACT_INSTRUCTIONS = `Ты готовишь глоссарий для перевода англоязычной веб-новеллы на русский. Тебе дают одну главу и уже известные термины книги. Найди в главе то, чего в глоссарии ещё нет.

ЧТО СОБИРАТЬ
- Имена персонажей и их прозвища, титулы и обращения (Master, Elder, Young Master, Your Highness), названия мест, сект, кланов, организаций, техник и навыков, уровней силы, особых предметов, рас и существ, игровые термины (системные окна, классы, характеристики).
- Не собирай обычные слова, которые переводятся как обычно.
- Не повторяй уже известные термины. Если у известного персонажа в главе появилось другое имя или прозвище, верни этот термин с тем же en и новым именем в aliases.

КАК ПЕРЕВОДИТЬ
- Китайские имена в пиньине — по системе Палладия (Lin Wei → Линь Вэй, Xiao → Сяо, Zhang → Чжан). Корейские — по Концевичу (Kim Min-jun → Ким Мин Чжун). Японские — по Поливанову (Shinji → Синдзи). Европейские и выдуманные имена — практической транскрипцией.
- Говорящие названия техник, сект, мест, предметов и уровней — переводи по смыслу, а не транслитерируй (Azure Cloud Sect → секта Лазурных Облаков). Устоявшиеся слова культивации передавай принятыми в русских переводах формами (qi → ци, dantian → даньтянь).
- kind: name — персонажи; title — титулы и обращения; technique — техники, навыки, уровни; place; org — секты, кланы, организации; item; other.
- gender — только для персонажей: m, f, n (бесполое/существо), unknown, если из текста не ясно. Для остального — null.
- note — до 10 слов, только если без пометки легко ошибиться (например, «младший брат по секте» или «он же Призрачный Клинок»). Иначе null.

КТО К КОМУ ОБРАЩАЕТСЯ
- Для пар персонажей, которые в этой главе говорят друг с другом, реши, как по-русски один обращается к другому: ty или vy. Учитывай возраст, статус, близость, вежливость речи. from и to — английские имена (en) персонажей.

РАССКАЗЧИК И СТИЛЬ
- narrator: person = first, если повествование от первого лица («I»), third — от третьего; gender рассказчика от первого лица, если понятно.
- register: live — лёгкий разговорный текст (LitRPG, городское фэнтези, комедия); elevated — сянься, уся, исторический или торжественный слог; plain — всё остальное.

Отвечай строго по схеме.`;

/**
 * Разбор главы до перевода: новые имена и термины (с родом персонажей и
 * другими именами), кто к кому на «ты/вы», рассказчик, стиль. Модель видит
 * уже известные термины с русскими написаниями и обращения, чтобы не
 * дублировать. Structured outputs, effort low.
 */
export async function extractTerms(input: {
  model: ModelId;
  chapterText: string;
  known: Array<{ en: string; ru: string; kind: string; aliases: string[] }>;
  knownAddresses: Array<{ fromEn: string; toEn: string; form: "ty" | "vy" }>;
  isFirstChapterOfBook: boolean;
}): Promise<ExtractOutcome> {
  const known = [...input.known]
    .sort((a, b) => a.en.localeCompare(b.en))
    .map((t) => `${t.en} → ${t.ru} (${t.kind})${t.aliases.length ? ` [другие имена: ${t.aliases.join(", ")}]` : ""}`)
    .join("\n");
  const addresses = input.knownAddresses.map((a) => `${a.fromEn} → ${a.toEn}: ${a.form === "ty" ? "ты" : "вы"}`).join("\n");
  const context = [
    input.isFirstChapterOfBook ? "Это первая глава книги, которую мы переводим." : null,
    known ? `ИЗВЕСТНЫЕ ТЕРМИНЫ\n${known}` : "Известных терминов пока нет.",
    addresses ? `ИЗВЕСТНЫЕ ОБРАЩЕНИЯ\n${addresses}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await anthropic().messages.parse({
      model: input.model,
      max_tokens: 8000,
      system: [{ type: "text", text: EXTRACT_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `${context}\n\nГЛАВА\n\n${input.chapterText}` }],
      output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
    });
    const usage = toUsage(response.usage as RawUsage);
    if (response.stop_reason === "refusal") return { kind: "refused", usage, model: response.model };
    const parsed = response.parsed_output;
    if (!parsed) return { kind: "error", code: "unknown", message: "Модель ответила не по схеме.", retryable: false };
    return {
      kind: "ok",
      usage,
      model: response.model,
      result: {
        terms: parsed.terms.map((t) => ({ en: t.en, ru: t.ru, kind: t.kind, gender: t.gender, aliases: t.aliases, note: t.note })),
        addresses: parsed.addresses.map((a) => ({ fromEn: a.from, toEn: a.to, form: a.form })),
        narrator: parsed.narrator
          ? { person: parsed.narrator.person === "first" ? 1 : parsed.narrator.person === "third" ? 3 : null, gender: parsed.narrator.gender }
          : null,
        register: parsed.register,
      },
    };
  } catch (e) {
    return { kind: "error", ...mapError(e) };
  }
}

let keyCheck: { at: number; result: { ok: boolean; message?: string } } | null = null;

/** Проверка ключа без трат (models.retrieve). Результат держим 10 минут. */
export async function checkKey(): Promise<{ ok: boolean; message?: string }> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, message: "Ключ не задан: добавьте ANTHROPIC_API_KEY в настройках Vercel." };
  }
  if (keyCheck && Date.now() - keyCheck.at < 10 * 60_000) return keyCheck.result;
  let result: { ok: boolean; message?: string };
  try {
    await anthropic().models.retrieve("claude-sonnet-5-5");
    result = { ok: true };
  } catch (e) {
    result = { ok: false, message: mapError(e).message };
  }
  keyCheck = { at: Date.now(), result };
  return result;
}
