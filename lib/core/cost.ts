/**
 * Токены в деньги и оценка цены до вызова.
 *
 * Профиль из замера «Толмача» (14.09.2026, 10 глав, медиана 1 738 слов):
 * ~31 225 «входных эквивалентов» на главу при цене выхода 5× входа,
 * то есть ~17 966 на 1 000 английских слов. Отсюда оценки.
 */

import type { Effort, ModelId, Usage } from "../types";
import { DEFAULT_CHUNK_WORDS } from "./chunk";
import { MODELS, type ModelSpec } from "./models";
import { wordsIn } from "./words";

/** Пакетный API Anthropic — половина цены. */
export const BATCH_DISCOUNT = 0.5;

/**
 * Длинный промпт у Haiku 5.5 считается по второму тарифу целиком: вход,
 * выход и кэш дорожают одинаково (×5), если весь промпт — свежий вход,
 * чтение и запись кэша вместе — длиннее порога.
 */
function longPromptFactor(spec: ModelSpec, promptTokens: number): number {
  return spec.longPromptThreshold !== null && promptTokens > spec.longPromptThreshold ? spec.longPromptMultiplier : 1;
}

function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Фактическая цена вызова в долларах. batch — скидка 50%. */
/**
 * Цены моделей, которыми Anthropic может ответить вместо запрошенной при
 * серверном повторе после отказа (fallbacks: "default"). Их нет в MODELS —
 * выбирать их нельзя, но платить за их ответ приходится.
 */
const FALLBACK_PRICES: Record<string, Pick<ModelSpec, "inputPerMTok" | "outputPerMTok" | "cacheReadPerMTok">> = {
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
};

/** Цены для модели из ответа: своя, запасная или — если неизвестна — запрошенной модели. */
export function priceSpec(model: string, requested: ModelId): ModelSpec {
  if (model in MODELS) return MODELS[model as ModelId];
  const extra = FALLBACK_PRICES[model] ?? FALLBACK_PRICES[model.replace(/-\d{8}$/, "")];
  return extra ? { ...MODELS[requested], ...extra, longPromptThreshold: null, longPromptMultiplier: 1 } : MODELS[requested];
}

export function usageCostUsd(model: ModelId | string, usage: Usage, opts?: { batch?: boolean; requested?: ModelId }): number {
  const spec = priceSpec(String(model), opts?.requested ?? (model in MODELS ? (model as ModelId) : "claude-sonnet-5-5"));
  const input = n(usage.inputTokens);
  const output = n(usage.outputTokens);
  const write5m = n(usage.cacheWrite5mTokens);
  const write1h = n(usage.cacheWrite1hTokens);
  const read = n(usage.cacheReadTokens);

  const perMTok =
    input * spec.inputPerMTok +
    write5m * spec.inputPerMTok * spec.cacheWrite5mMultiplier +
    write1h * spec.inputPerMTok * spec.cacheWrite1hMultiplier +
    read * spec.cacheReadPerMTok +
    output * spec.outputPerMTok;

  const factor = longPromptFactor(spec, input + read + write5m + write1h);
  const usd = (perMTok * factor) / 1_000_000;
  return opts?.batch ? usd * BATCH_DISCOUNT : usd;
}

// ── Оценка до вызова ───────────────────────────────────────────────────
//
// Разложение замера на части (Sonnet, effort medium, 1 738 слов ≈ $0,0625):
// английский текст на входе, неизменный префикс (правила + стиль, пишется
// в кэш в первой части и читается из него в остальных), то, что меняется от
// части к части (глоссарий, конец прошлого текста), русский текст на выходе
// с метками и обдумывание. Больше трёх четвертей цены — русский выход.
// Числа ниже — приближение, уточняется замером на этапе 2.

/** Токенов на английское слово во входе (≈ 5,5 символа на слово / 4). */
export const EN_TOKENS_PER_WORD = 1.35;
/** Токенов русского перевода на английское слово. То же число берёт prompt.ts для max_tokens. */
export const RU_TOKENS_PER_EN_WORD = 2.9;
/** Метки ⟦idx⟧ в выводе: ~250 токенов на главу в 1 700–2 000 слов. */
export const LABEL_TOKENS_PER_WORD = 0.13;
/** Правила и стиль книги — неизменная часть system (держать близко к estimateTokens(RULES + стиль)). */
export const STATIC_PREFIX_TOKENS = 1450;
/** Глоссарий части, конец прошлого текста, заголовки — на каждую часть. */
export const PER_CHUNK_CONTEXT_TOKENS = 350;
/**
 * Обдумывание на часть. Замер «Толмача»: на переводе модели почти не думают
 * (расход шёл ровно по прайсу), поэтому числа маленькие; Opus 5.5 думает
 * всегда — ему добавка.
 */
export const THINKING_TOKENS_PER_CHUNK: Record<Effort, number> = { low: 0, medium: 100, high: 500 };
export const ALWAYS_THINKS_EXTRA_PER_CHUNK = 500;

/** Оценка цены перевода текста из `words` английских слов (вход + выход + обдумывание). */
/** Поиск имён до перевода: вся глава на входе, на выходе — только новые термины. */
export const EXTRACT_FIXED_INPUT_TOKENS = 2500;
/** В среднем по книге: в первых главах терминов много, потом единицы. */
export const EXTRACT_OUTPUT_TOKENS = 600;

// ── Глоссарий по готовому переводу ──
/** Токенов на русское слово (≈ 7 символов на слово / 2,6). */
export const RU_TOKENS_PER_RU_WORD = 2.7;
/** Правила чтения имён и заголовки — на каждый вызов. */
export const GLOSSARY_FIXED_INPUT_TOKENS = 1500;
/** Имена из пачки глав: в среднем несколько десятков коротких строк. */
export const GLOSSARY_SCAN_OUTPUT_TOKENS = 900;
/** Пары «английское → русское» из одной главы и известные пары во входе. */
export const GLOSSARY_ALIGN_OUTPUT_TOKENS = 1200;
export const GLOSSARY_ALIGN_KNOWN_TOKENS = 1500;

/**
 * Цена сбора глоссария: чтение русских глав пачками (scanCalls вызовов на
 * scanWords слов) и сверка пар глав (по-английски alignEnWords, по-русски
 * alignRuWords, alignPairs вызовов).
 */
export function estimateGlossaryUsd(
  model: ModelId,
  p: { scanWords: number; scanCalls: number; alignEnWords: number; alignRuWords: number; alignPairs: number },
): number {
  const zero = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 };
  const scan =
    p.scanCalls > 0
      ? usageCostUsd(model, {
          inputTokens: p.scanWords * RU_TOKENS_PER_RU_WORD + p.scanCalls * GLOSSARY_FIXED_INPUT_TOKENS,
          outputTokens: p.scanCalls * GLOSSARY_SCAN_OUTPUT_TOKENS,
          ...zero,
        })
      : 0;
  const align =
    p.alignPairs > 0
      ? usageCostUsd(model, {
          inputTokens:
            p.alignEnWords * EN_TOKENS_PER_WORD +
            p.alignRuWords * RU_TOKENS_PER_RU_WORD +
            p.alignPairs * (GLOSSARY_FIXED_INPUT_TOKENS + GLOSSARY_ALIGN_KNOWN_TOKENS),
          outputTokens: p.alignPairs * GLOSSARY_ALIGN_OUTPUT_TOKENS,
          ...zero,
        })
      : 0;
  return scan + align;
}

export function estimateExtractionUsd(model: ModelId, words: number): number {
  if (!(words > 0)) return 0;
  return usageCostUsd(model, {
    inputTokens: words * EN_TOKENS_PER_WORD + EXTRACT_FIXED_INPUT_TOKENS,
    outputTokens: EXTRACT_OUTPUT_TOKENS,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
  });
}

/**
 * Оценка цены главы. С extractModel — вместе с поиском имён: он идёт перед
 * каждым переводом и на дешёвой модели перевода стоит дороже самого перевода.
 */
export function estimateTranslationUsd(model: ModelId, words: number, opts?: { effort?: Effort; batch?: boolean; extractModel?: ModelId }): number {
  if (!(words > 0)) return 0;
  const extraction = opts?.extractModel ? estimateExtractionUsd(opts.extractModel, words) : 0;
  return extraction + estimateTranslationOnlyUsd(model, words, opts);
}

function estimateTranslationOnlyUsd(model: ModelId, words: number, opts?: { effort?: Effort; batch?: boolean }): number {
  const spec = MODELS[model];
  const effort = opts?.effort ?? "medium";

  // Части — как в chunk.ts: по ~1 400 слов, каждая отдельным запросом.
  const chunks = Math.max(1, Math.ceil(words / DEFAULT_CHUNK_WORDS));
  const perChunkWords = words / chunks;
  const thinking = THINKING_TOKENS_PER_CHUNK[effort] + (spec.alwaysThinks ? ALWAYS_THINKS_EXTRA_PER_CHUNK : 0);
  const freshInput = perChunkWords * EN_TOKENS_PER_WORD + PER_CHUNK_CONTEXT_TOKENS;
  const output = perChunkWords * (RU_TOKENS_PER_EN_WORD + LABEL_TOKENS_PER_WORD) + thinking;
  // Префикс короче порога модели молча не кэшируется — тогда он каждый раз свежий вход.
  const cacheable = STATIC_PREFIX_TOKENS >= spec.minCacheTokens;

  const first: Usage = {
    inputTokens: freshInput + (cacheable ? 0 : STATIC_PREFIX_TOKENS),
    outputTokens: output,
    cacheWrite5mTokens: cacheable ? STATIC_PREFIX_TOKENS : 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
  };
  const rest: Usage = {
    ...first,
    cacheWrite5mTokens: 0,
    cacheReadTokens: cacheable ? STATIC_PREFIX_TOKENS : 0,
  };

  const batch = { batch: opts?.batch };
  return usageCostUsd(model, first, batch) + (chunks - 1) * usageCostUsd(model, rest, batch);
}

/**
 * Худшая возможная цена одного запроса — для резерва в бюджете:
 * все входные токены по полной цене + max_tokens по цене выхода.
 *
 * «Полная» цена входа — самая дорогая из возможных: запись в кэш на 5 минут
 * (1,25× входа), потому что префикс с меткой кэша оплачивается именно так.
 * Иначе резерв мог бы оказаться на долю цента меньше факта. Скидку пакета
 * не учитываем: резерв больше факта — безопасно.
 */
export function worstCaseUsd(model: ModelId, inputTokensEstimate: number, maxTokens: number): number {
  const spec = MODELS[model];
  const input = n(inputTokensEstimate);
  const output = n(maxTokens);
  const inputRate = spec.inputPerMTok * Math.max(1, spec.cacheWrite5mMultiplier);
  const factor = longPromptFactor(spec, input);
  return ((input * inputRate + output * spec.outputPerMTok) * factor) / 1_000_000;
}

// ── Токены без API ─────────────────────────────────────────────────────

const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LATIN = /\p{Script=Latin}/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** Символов на токен: английский текст ~4, русский ~2,6 (кириллица дробится мельче). */
export const CHARS_PER_TOKEN_LATIN = 4;
export const CHARS_PER_TOKEN_CYRILLIC = 2.6;

/**
 * Грубая оценка числа токенов в тексте (английский или русский) без вызова API.
 *
 * Приближение: доля кириллицы среди букв задаёт смесь двух норм — ~4 символа
 * на токен для латиницы и ~2,6 для кириллицы; пробелы, цифры и знаки делятся
 * между ними в той же пропорции. Иероглифы и хангыль — примерно токен на знак.
 * Ошибка ±20%: для резерва бюджета и показа цены хватает, для точного
 * счёта есть usage из ответа.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cyr = text.match(CYRILLIC)?.length ?? 0;
  const lat = text.match(LATIN)?.length ?? 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const letters = cyr + lat;
  const share = letters > 0 ? cyr / letters : 0;
  const rest = text.length - cjk;
  const perChar = share / CHARS_PER_TOKEN_CYRILLIC + (1 - share) / CHARS_PER_TOKEN_LATIN;
  return Math.ceil(cjk + rest * perChar);
}

// ── Показ ──────────────────────────────────────────────────────────────

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Рубли по курсу, округлённые для показа: «≈ 3,5 ₽», «≈ 0,30 ₽».
 * Меньше 1 ₽ — две значащие цифры («≈ 0,29 ₽»), до 10 ₽ — один знак после
 * запятой, дальше — целые («≈ 12 ₽», «≈ 1 250 ₽»).
 */
export function formatRub(usd: number, usdRub: number): string {
  const rub = usd * usdRub;
  if (!Number.isFinite(rub)) return "≈ ? ₽";
  const sign = rub < 0 ? "−" : "";
  const abs = Math.abs(rub);

  let text: string;
  // Меньше тысячной рубля — это ноль для любого человеческого решения.
  if (abs < 0.001) text = "0";
  else if (Number(abs.toPrecision(2)) < 1) text = abs.toPrecision(2);
  else if (Number(abs.toFixed(1)) < 10) text = abs.toFixed(1);
  else text = groupThousands(Math.round(abs).toString());

  return `≈ ${text === "0" ? "" : sign}${text.replace(".", ",")} ₽`;
}

/** Число английских слов в абзацах. */
export function countWords(paragraphs: string[]): number {
  let total = 0;
  for (const p of paragraphs) total += wordsIn(p);
  return total;
}
