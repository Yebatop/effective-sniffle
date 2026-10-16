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
export function usageCostUsd(model: ModelId, usage: Usage, opts?: { batch?: boolean }): number {
  const spec = MODELS[model];
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
export function estimateTranslationUsd(model: ModelId, words: number, opts?: { effort?: Effort; batch?: boolean }): number {
  if (!(words > 0)) return 0;
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
