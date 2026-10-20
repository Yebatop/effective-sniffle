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
  /**
   * Поток прерван: вышел срок вызова, исполнителя сменили или упала запись
   * абзаца. Уже выданные абзацы сохранены; usage — сколько успели потратить
   * (выход оплачивается и у оборванного ответа). cause — исходная ошибка.
   */
  | { kind: "aborted"; paragraphs: Array<{ idx: number; text: string }>; usage: Usage; model: string; cause: unknown }
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean; usage: Usage; model: string };

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
  opts?: { signal?: AbortSignal },
): Promise<TranslateOutcome> {
  let parser = createLabelParser(expected);
  const done = new Map<number, string>();
  // Расход по событиям потока: если поток оборвётся, мы всё равно знаем,
  // сколько входа и выхода уже оплачено.
  let seen: RawUsage = {};
  let served = model as string;
  let callbackError: unknown = null;
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
  const options = opts?.signal ? { signal: opts.signal } : undefined;

  try {
    const stream = MODELS[model].serverFallback
      ? anthropic().beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" }, options)
      : anthropic().messages.stream(params, options);

    type Event = {
      type: string;
      message?: { model?: string; usage?: RawUsage };
      content_block?: { type: string };
      delta?: { type: string; text?: string };
      usage?: RawUsage;
    };
    for await (const event of stream as AsyncIterable<Event>) {
      if (event.type === "message_start" && event.message) {
        served = event.message.model ?? served;
        seen = { ...seen, ...(event.message.usage ?? {}) };
        continue;
      }
      if (event.type === "message_delta" && event.usage) {
        seen = { ...seen, ...event.usage };
        continue;
      }
      if (event.type === "content_block_start" && event.content_block?.type === "fallback") {
        // Модель отказала посреди ответа, Anthropic продолжил другой моделью:
        // она переводит всё заново, а её абзацы заменят уже показанные.
        parser = createLabelParser(expected);
        continue;
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        try {
          await emit(parser.push(event.delta.text));
        } catch (e) {
          // Ошибка записи абзаца (или исполнителя сменили) — не ошибка
          // Anthropic: прерываем поток и отдаём причину наверх как есть.
          callbackError = e;
          stream.abort();
          break;
        }
      }
    }
    if (callbackError) return { kind: "aborted", paragraphs: toList(done), usage: toUsage(seen), model: served, cause: callbackError };

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
    try {
      await emit(parser.finish());
    } catch (e) {
      return { kind: "aborted", paragraphs: toList(done), usage, model: final.model, cause: e };
    }
    return { kind: "ok", paragraphs: toList(done), usage, model: final.model, stopReason: final.stop_reason ?? "end_turn" };
  } catch (e) {
    if (callbackError) return { kind: "aborted", paragraphs: toList(done), usage: toUsage(seen), model: served, cause: callbackError };
    if (e instanceof Anthropic.APIUserAbortError || opts?.signal?.aborted) {
      return { kind: "aborted", paragraphs: toList(done), usage: toUsage(seen), model: served, cause: e };
    }
    return { kind: "error", ...mapError(e), usage: toUsage(seen), model: served };
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
  /** usage есть и у ошибки: ответ, который не разобрался по схеме, всё равно оплачен. */
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean; usage: Usage; model: string };

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
- Если дан список «ИМЕНА ИЗ ГОТОВОГО ПЕРЕВОДА» и новый термин главы — одно из них (тот же персонаж, место, предмет), ru бери ровно оттуда: читатель привык к этим написаниям.

КАК ПЕРЕВОДИТЬ
- Китайские имена в пиньине — по системе Палладия (Lin Wei → Линь Вэй, Xiao → Сяо, Zhang → Чжан). Корейские — по Концевичу (Kim Min-jun → Ким Мин Чжун). Японские — по Поливанову (Shinji → Синдзи). Европейские и выдуманные имена — практической транскрипцией.
- Говорящие названия техник, сект, мест, предметов и уровней — переводи по смыслу, а не транслитерируй (Azure Cloud Sect → секта Лазурных Облаков). Устоявшиеся слова культивации передавай принятыми в русских переводах формами (qi → ци, dantian → даньтянь).
- kind: name — персонажи; title — титулы и обращения; technique — техники, навыки, уровни; place; org — секты, кланы, организации; item; other.
- gender — только для персонажей: m, f, n (бесполое/существо), unknown, если из текста не ясно. Для остального — null.
- note — до 10 слов: что это или кто это. Всегда — для предметов, техник, званий, событий и слов, смысл которых не ясен из самого слова (по главе: обряд, артефакт, катастрофа…). Для персонажей — если без пометки легко ошибиться («младший брат по секте», «он же Призрачный Клинок»). Иначе null.

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
  /** Имена готового перевода, ещё не сопоставленные с английскими. */
  hints?: Array<{ ru: string; kind: string; gender: string | null; note: string | null }>;
}, opts?: { signal?: AbortSignal }): Promise<ExtractOutcome> {
  const known = [...input.known]
    .sort((a, b) => a.en.localeCompare(b.en))
    .map((t) => `${t.en} → ${t.ru} (${t.kind})${t.aliases.length ? ` [другие имена: ${t.aliases.join(", ")}]` : ""}`)
    .join("\n");
  const addresses = input.knownAddresses.map((a) => `${a.fromEn} → ${a.toEn}: ${a.form === "ty" ? "ты" : "вы"}`).join("\n");
  const hints = (input.hints ?? []).map(hintLine).join("\n");
  const context = [
    input.isFirstChapterOfBook ? "Это первая глава книги, которую мы переводим." : null,
    known ? `ИЗВЕСТНЫЕ ТЕРМИНЫ\n${known}` : "Известных терминов пока нет.",
    addresses ? `ИЗВЕСТНЫЕ ОБРАЩЕНИЯ\n${addresses}` : null,
    hints ? `ИМЕНА ИЗ ГОТОВОГО ПЕРЕВОДА (по-русски; английское написание пока неизвестно)\n${hints}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const format = zodOutputFormat(ExtractionSchema);
  let usage: Usage = { ...ZERO_USAGE };
  let served: string = input.model;
  try {
    // create, а не parse: если ответ не разберётся по схеме (например, оборван
    // на max_tokens), parse бросил бы ошибку без usage — и оплаченный вызов
    // пропал бы из учёта.
    const response = await anthropic().messages.create(
      {
        model: input.model,
        max_tokens: 8000,
        system: [{ type: "text", text: EXTRACT_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `${context}\n\nГЛАВА\n\n${input.chapterText}` }],
        output_config: { effort: "low", format: { type: format.type, schema: format.schema } },
      },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    usage = toUsage(response.usage as RawUsage);
    served = response.model;
    if (response.stop_reason === "refusal") return { kind: "refused", usage, model: served };
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let parsed: z.infer<typeof ExtractionSchema>;
    try {
      parsed = format.parse(text);
    } catch {
      return { kind: "error", code: "unknown", message: "Модель ответила не по схеме.", retryable: false, usage, model: served };
    }
    return {
      kind: "ok",
      usage,
      model: served,
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
    return { kind: "error", ...mapError(e), usage, model: served };
  }
}

const KIND_RU: Record<string, string> = {
  name: "персонаж",
  title: "титул/обращение",
  technique: "техника/навык",
  place: "место",
  org: "организация",
  item: "предмет",
  other: "термин",
};
const GENDER_RU: Record<string, string> = { m: "м", f: "ж", n: "ср" };

function hintLine(h: { ru: string; kind: string; gender: string | null; note: string | null }): string {
  const what = [KIND_RU[h.kind] ?? "термин", h.gender && GENDER_RU[h.gender] ? GENDER_RU[h.gender] : null].filter(Boolean).join(", ");
  return `${h.ru} (${what})${h.note ? ` — ${h.note}` : ""}`;
}

// ── Глоссарий по готовому переводу ──────────────────────────────────────

export type JsonOutcome<T> =
  | { kind: "ok"; result: T; usage: Usage; model: string }
  | { kind: "refused"; usage: Usage; model: string }
  /** truncated — ответ оборвался на max_tokens: повтор того же запроса не поможет. */
  | { kind: "error"; code: ErrorCode; message: string; retryable: boolean; usage: Usage; model: string; truncated?: boolean };

const KIND_ENUM = z.enum(["name", "title", "technique", "place", "org", "item", "other"]);

const ScanSchema = z.object({
  terms: z.array(
    z.object({
      ru: z.string(),
      kind: KIND_ENUM,
      gender: z.enum(["m", "f", "n", "unknown"]).nullable(),
      note: z.string().nullable(),
      chapters: z.array(z.number()),
    }),
  ),
});
export type ScanResult = z.infer<typeof ScanSchema>;

export const SCAN_INSTRUCTIONS = `Тебе дают несколько глав готового русского перевода веб-новеллы. Читатель привык к этому переводу, и наш переводчик продолжит книгу с тех же имён. Выпиши из глав имена собственные и особые термины так, как они написаны в этом переводе.

ЧТО ВЫПИСЫВАТЬ
- Персонажей (имена, фамилии, прозвища), титулы и звания, места, страны, организации, фракции, техники и навыки, уровни силы, особые предметы, расы и существа, системные и игровые термины, названия событий.
- Не выписывай обычные слова, которые переводятся как обычно.

КАК ЗАПИСЫВАТЬ
- ru — начальная форма, как в словаре: именительный падеж, единственное число («Павла» → «Павел», «генералу Гарсии» → «Гарсия»). Звание отдельно от имени, если это не постоянное прозвище.
- Полное имя и короткое (Максимилиан / Макс) — отдельными строками, у короткого в note напиши, чьё это сокращение.
- kind: name — персонажи; title — титулы, звания, обращения; technique — техники, навыки, уровни; place; org — организации, фракции, кланы; item; other.
- gender — только для персонажей: m, f, n (существо без пола), unknown. Для остального — null.
- note — до 10 слов: кто это или что это (роль персонажа, суть предмета, события, звания). Если по главам не понять — null.
- chapters — номера глав (из заголовков «ГЛАВА N» ниже), в которых встречается.

Отвечай строго по схеме.`;

/** Предел ответа: список имён короткий, но место нужно и на обдумывание, если модель решит подумать. */
export const SCAN_MAX_TOKENS = 12000;
export const ALIGN_MAX_TOKENS = 12000;

/** Имена и термины из пачки глав готового перевода. Structured outputs, effort low. */
export async function scanRefTerms(
  input: { model: ModelId; chapters: Array<{ number: number; title: string; text: string }> },
  opts?: { signal?: AbortSignal },
): Promise<JsonOutcome<ScanResult>> {
  const body = input.chapters.map((c) => `ГЛАВА ${c.number}${c.title ? ` — ${c.title}` : ""}\n\n${c.text}`).join("\n\n");
  return jsonCall(input.model, SCAN_INSTRUCTIONS, body, ScanSchema, SCAN_MAX_TOKENS, opts);
}

const AlignSchema = z.object({
  pairs: z.array(
    z.object({
      en: z.string(),
      ru: z.string(),
      kind: KIND_ENUM,
      gender: z.enum(["m", "f", "n", "unknown"]).nullable(),
      aliases: z.array(z.string()),
      note: z.string().nullable(),
    }),
  ),
});
export type AlignResult = z.infer<typeof AlignSchema>;

export const ALIGN_INSTRUCTIONS = `Тебе дают одну главу веб-новеллы по-английски и ту же главу в готовом русском переводе. Составь словарь: как в этом переводе переданы имена собственные и особые термины английского текста.

- en — как в английском тексте (начальная форма, без притяжательного 's).
- ru — как в русском переводе, в начальной форме: именительный падеж, единственное число.
- Бери персонажей, титулы и звания, места, организации, техники, уровни, предметы, расы, системные термины. Обычные слова не бери.
- Если в русском тексте соответствия нет или ты не уверен — пропусти термин.
- aliases — другие английские имена того же персонажа или предмета в этой главе.
- kind: name, title, technique, place, org, item, other. gender — только для персонажей (m, f, n, unknown), иначе null.
- note — до 10 слов: кто это или что это; null, если и так ясно.
- Не повторяй пары из списка «УЖЕ ИЗВЕСТНО».

Отвечай строго по схеме.`;

/** Пары «английское → русское» по одной главе в двух версиях. */
export async function alignRefTerms(
  input: { model: ModelId; number: number; en: string; ru: string; known: Array<{ en: string; ru: string }> },
  opts?: { signal?: AbortSignal },
): Promise<JsonOutcome<AlignResult>> {
  const known = input.known.map((k) => `${k.en} → ${k.ru}`).join("\n");
  const body = [
    known ? `УЖЕ ИЗВЕСТНО\n${known}` : null,
    `ГЛАВА ${input.number} ПО-АНГЛИЙСКИ\n\n${input.en}`,
    `ГЛАВА ${input.number} В ГОТОВОМ ПЕРЕВОДЕ\n\n${input.ru}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return jsonCall(input.model, ALIGN_INSTRUCTIONS, body, AlignSchema, ALIGN_MAX_TOKENS, opts);
}

/** Вызов со structured outputs: create (а не parse), чтобы оплаченный ответ не пропал из учёта. */
async function jsonCall<T>(
  model: ModelId,
  instructions: string,
  userText: string,
  schema: z.ZodType<T>,
  maxTokens: number,
  opts?: { signal?: AbortSignal },
): Promise<JsonOutcome<T>> {
  const format = zodOutputFormat(schema);
  let usage: Usage = { ...ZERO_USAGE };
  let served: string = model;
  try {
    const response = await anthropic().messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
        output_config: { effort: "low", format: { type: format.type, schema: format.schema } },
      },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    usage = toUsage(response.usage as RawUsage);
    served = response.model;
    if (response.stop_reason === "refusal") return { kind: "refused", usage, model: served };
    if (response.stop_reason === "max_tokens") {
      return { kind: "error", code: "unknown", message: "Ответ модели оборвался.", retryable: false, usage, model: served, truncated: true };
    }
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    try {
      return { kind: "ok", result: format.parse(text) as T, usage, model: served };
    } catch {
      return { kind: "error", code: "unknown", message: "Модель ответила не по схеме.", retryable: false, usage, model: served };
    }
  } catch (e) {
    return { kind: "error", ...mapError(e), usage, model: served };
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
