/**
 * Модели и цены. Прайс Anthropic на 2026-10 (доллары за миллион токенов).
 * Цены меняются — перед подсчётом бюджета всерьёз сверяйтесь с прайсом.
 */

import type { Effort, ModelId } from "../types";

export interface ModelSpec {
  id: ModelId;
  /** Короткое имя для интерфейса. */
  label: string;
  /** Как описать человеку без опыта. */
  blurb: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** Запись в кэш на 5 минут — 1,25× входа, на час — 2× входа. */
  cacheWrite5mMultiplier: number;
  cacheWrite1hMultiplier: number;
  /** Порог в токенах, выше которого вход дорожает (у Haiku 5.5 — 100K, ×5). */
  longPromptThreshold: number | null;
  longPromptMultiplier: number;
  /** Поддерживает ли серверный fallbacks: "default" (beta server-side-fallback-2026-07-01). */
  serverFallback: boolean;
  /** Минимальный кэшируемый префикс, токенов. */
  minCacheTokens: number;
  /** Обдумывание нельзя выключить (Opus 5.5) — учитывать в оценке цены. */
  alwaysThinks: boolean;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  "claude-haiku-5-5": {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    blurb: "Дешёвая. Качество перевода на русский пока не проверено.",
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2,
    longPromptThreshold: 100_000,
    longPromptMultiplier: 5,
    serverFallback: false,
    minCacheTokens: 512,
    alwaysThinks: false,
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    blurb: "Хорошая. Прошлое поколение переводило приемлемо.",
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2,
    longPromptThreshold: null,
    longPromptMultiplier: 1,
    serverFallback: true,
    minCacheTokens: 512,
    alwaysThinks: false,
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    blurb: "Лучшая. Примерно вдвое дороже Sonnet.",
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWrite5mMultiplier: 1.25,
    cacheWrite1hMultiplier: 2,
    longPromptThreshold: null,
    longPromptMultiplier: 1,
    serverFallback: true,
    minCacheTokens: 512,
    alwaysThinks: true,
  },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && v in MODELS;
}

export function isEffort(v: unknown): v is Effort {
  return v === "low" || v === "medium" || v === "high";
}

/**
 * Порядок повторов при отказе модели: сначала выбранная, потом остальные.
 * Haiku → Sonnet → Opus; Sonnet → Opus → Haiku; Opus → Sonnet → Haiku.
 */
export function refusalChain(primary: ModelId): ModelId[] {
  switch (primary) {
    case "claude-haiku-5-5":
      return ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
    case "claude-sonnet-5-5":
      return ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];
    case "claude-opus-5-5":
      return ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  }
}
