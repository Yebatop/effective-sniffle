import { describe, expect, it } from "vitest";
import {
  countWords,
  estimateTokens,
  estimateTranslationUsd,
  formatRub,
  STATIC_PREFIX_TOKENS,
  usageCostUsd,
  worstCaseUsd,
} from "@/lib/core/cost";
import { RULES, renderStyleBlock } from "@/lib/core/prompt";
import type { Usage } from "@/lib/types";
import { makeBook } from "./helpers";

const zero: Usage = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 };

describe("usageCostUsd", () => {
  it("считает вход и выход по прайсу", () => {
    // Sonnet: $2 / $10 за миллион.
    expect(usageCostUsd("claude-sonnet-5-5", { ...zero, inputTokens: 1_000_000 })).toBeCloseTo(2, 10);
    expect(usageCostUsd("claude-sonnet-5-5", { ...zero, outputTokens: 1_000_000 })).toBeCloseTo(10, 10);
    expect(usageCostUsd("claude-opus-5-5", { ...zero, inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.024, 10);
  });

  it("кэш: чтение по своей цене, запись 5 минут ×1,25, час ×2 от входа", () => {
    expect(usageCostUsd("claude-sonnet-5-5", { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 10);
    expect(usageCostUsd("claude-sonnet-5-5", { ...zero, cacheWrite5mTokens: 1_000_000 })).toBeCloseTo(2.5, 10);
    expect(usageCostUsd("claude-sonnet-5-5", { ...zero, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(4, 10);
    expect(usageCostUsd("claude-haiku-5-5", { ...zero, cacheReadTokens: 50_000 })).toBeCloseTo(0.0005, 12);
  });

  it("пакет — половина цены", () => {
    const u: Usage = { ...zero, inputTokens: 5000, outputTokens: 7000, cacheReadTokens: 2000 };
    const full = usageCostUsd("claude-sonnet-5-5", u);
    expect(usageCostUsd("claude-sonnet-5-5", u, { batch: true })).toBeCloseTo(full / 2, 12);
  });

  it("Haiku: промпт длиннее 100K (вход + кэш) — всё по второму тарифу ×5", () => {
    const short: Usage = { ...zero, inputTokens: 60_000, cacheReadTokens: 40_000, outputTokens: 1000 };
    const long: Usage = { ...short, cacheWrite5mTokens: 1 };
    const shortUsd = usageCostUsd("claude-haiku-5-5", short);
    expect(shortUsd).toBeCloseTo((60_000 * 0.1 + 40_000 * 0.01 + 1000 * 0.5) / 1e6, 12);
    const longUsd = usageCostUsd("claude-haiku-5-5", long);
    expect(longUsd).toBeCloseTo(((60_000 * 0.1 + 40_000 * 0.01 + 1 * 0.125 + 1000 * 0.5) * 5) / 1e6, 12);
    // У Sonnet порога нет.
    const big: Usage = { ...zero, inputTokens: 300_000 };
    expect(usageCostUsd("claude-sonnet-5-5", big)).toBeCloseTo(0.6, 10);
  });

  it("не ломается на мусоре в usage", () => {
    const bad = { ...zero, inputTokens: Number.NaN, outputTokens: -5 } as Usage;
    expect(usageCostUsd("claude-sonnet-5-5", bad)).toBe(0);
  });
});

describe("estimateTranslationUsd", () => {
  it("калибровка: Sonnet, 1 738 слов, medium ≈ $0,0625 (замер 5,75 ₽ при 92 ₽/$) ±15%", () => {
    const usd = estimateTranslationUsd("claude-sonnet-5-5", 1738, { effort: "medium" });
    expect(usd).toBeGreaterThan(0.0625 * 0.85);
    expect(usd).toBeLessThan(0.0625 * 1.15);
    // И держимся близко к середине, а не на краю допуска.
    expect(Math.abs(usd / 0.0625 - 1)).toBeLessThan(0.07);
  });

  it("пакет вдвое дешевле", () => {
    const sync = estimateTranslationUsd("claude-sonnet-5-5", 1738);
    expect(estimateTranslationUsd("claude-sonnet-5-5", 1738, { batch: true })).toBeCloseTo(sync / 2, 12);
  });

  it("effort по умолчанию — medium; low < medium < high", () => {
    const low = estimateTranslationUsd("claude-sonnet-5-5", 2000, { effort: "low" });
    const med = estimateTranslationUsd("claude-sonnet-5-5", 2000, { effort: "medium" });
    const high = estimateTranslationUsd("claude-sonnet-5-5", 2000, { effort: "high" });
    expect(estimateTranslationUsd("claude-sonnet-5-5", 2000)).toBe(med);
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });

  it("Opus дороже двух Sonnet (думает всегда), Haiku — порядка 1/20 Sonnet", () => {
    const sonnet = estimateTranslationUsd("claude-sonnet-5-5", 1738);
    const opus = estimateTranslationUsd("claude-opus-5-5", 1738);
    const haiku = estimateTranslationUsd("claude-haiku-5-5", 1738);
    expect(opus).toBeGreaterThan(sonnet * 2);
    expect(opus).toBeLessThan(sonnet * 2.4);
    expect(haiku).toBeGreaterThan(sonnet / 25);
    expect(haiku).toBeLessThan(sonnet / 15);
  });

  it("цена за 1 000 слов почти не зависит от длины главы", () => {
    const short = estimateTranslationUsd("claude-sonnet-5-5", 1000) / 1000;
    const long = estimateTranslationUsd("claude-sonnet-5-5", 6000) / 6000;
    expect(Math.abs(long / short - 1)).toBeLessThan(0.15);
  });

  it("ноль слов — ноль", () => {
    expect(estimateTranslationUsd("claude-sonnet-5-5", 0)).toBe(0);
    expect(estimateTranslationUsd("claude-sonnet-5-5", -3)).toBe(0);
  });

  it("STATIC_PREFIX_TOKENS близок к настоящему размеру правил и стиля", () => {
    const real = estimateTokens(`${RULES}\n\n${renderStyleBlock(makeBook({ honorifics: "shixiong — «старший брат»" }))}`);
    expect(STATIC_PREFIX_TOKENS / real).toBeGreaterThan(0.75);
    expect(STATIC_PREFIX_TOKENS / real).toBeLessThan(1.25);
  });
});

describe("worstCaseUsd", () => {
  it("весь вход по самой дорогой ставке (запись кэша) + max_tokens по цене выхода", () => {
    expect(worstCaseUsd("claude-sonnet-5-5", 10_000, 20_000)).toBeCloseTo((10_000 * 2.5 + 20_000 * 10) / 1e6, 12);
  });

  it("не меньше фактической цены при любом раскладе того же входа", () => {
    const input = 6000;
    const max = 12_000;
    const worst = worstCaseUsd("claude-sonnet-5-5", input, max);
    const variants: Usage[] = [
      { ...zero, inputTokens: input, outputTokens: max },
      { ...zero, inputTokens: 1000, cacheWrite5mTokens: 5000, outputTokens: max },
      { ...zero, inputTokens: 1000, cacheReadTokens: 5000, outputTokens: max },
    ];
    for (const v of variants) expect(usageCostUsd("claude-sonnet-5-5", v)).toBeLessThanOrEqual(worst + 1e-12);
  });

  it("Haiku с промптом за порогом — ×5", () => {
    const base = worstCaseUsd("claude-haiku-5-5", 100_000, 1000);
    const over = worstCaseUsd("claude-haiku-5-5", 100_001, 1000);
    expect(over / base).toBeGreaterThan(4.9);
  });
});

describe("estimateTokens", () => {
  it("английский — около 4 символов на токен", () => {
    const en = "The lantern market opened at dusk, and the bridge was full of people. ".repeat(10);
    expect(estimateTokens(en)).toBe(Math.ceil(en.length / 4));
  });

  it("русский — около 2,6 символа на токен", () => {
    const ru = "Рынок фонарей открылся в сумерках, и мост был полон людей. ".repeat(10);
    expect(estimateTokens(ru)).toBe(Math.ceil(ru.length / 2.6));
  });

  it("смесь — между двумя нормами по доле кириллицы", () => {
    const en = "Lantern market at dusk. ".repeat(20);
    const ru = "Рынок фонарей в сумерках. ".repeat(20);
    const mixed = estimateTokens(en + ru);
    expect(mixed).toBeGreaterThan(estimateTokens(en));
    expect(mixed).toBeLessThan(estimateTokens(en) + estimateTokens(ru) + 5);
    expect(mixed).toBeGreaterThan((en.length + ru.length) / 4);
    expect(mixed).toBeLessThan((en.length + ru.length) / 2.6);
  });

  it("пустая строка — 0, иероглифы — около токена на знак", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("天下第一")).toBe(4);
  });
});

describe("formatRub", () => {
  it("до 1 ₽ — две значащие цифры с запятой", () => {
    expect(formatRub(0.29 / 92, 92)).toBe("≈ 0,29 ₽");
    expect(formatRub(0.3 / 92, 92)).toBe("≈ 0,30 ₽");
    expect(formatRub(0.0421 / 92, 92)).toBe("≈ 0,042 ₽");
  });

  it("до 10 ₽ — один знак после запятой", () => {
    expect(formatRub(3.5 / 92, 92)).toBe("≈ 3,5 ₽");
    expect(formatRub(0.0625, 92)).toBe("≈ 5,8 ₽");
    expect(formatRub(1 / 92, 92)).toBe("≈ 1,0 ₽");
  });

  it("на границах округления переходит к следующему формату", () => {
    expect(formatRub(0.996 / 92, 92)).toBe("≈ 1,0 ₽");
    expect(formatRub(9.97 / 92, 92)).toBe("≈ 10 ₽");
  });

  it("от 10 ₽ — целые, тысячи через пробел", () => {
    expect(formatRub(12.4 / 92, 92)).toBe("≈ 12 ₽");
    expect(formatRub(300 / 92, 92)).toBe("≈ 300 ₽");
    expect(formatRub(1250 / 92, 92)).toBe("≈ 1 250 ₽");
  });

  it("ноль и мусор", () => {
    expect(formatRub(0, 92)).toBe("≈ 0 ₽");
    expect(formatRub(Number.NaN, 92)).toBe("≈ ? ₽");
  });
});

describe("countWords", () => {
  it("считает куски с буквой или цифрой", () => {
    expect(countWords(["Lin Wei arrived late — as always..."])).toBe(6);
    expect(countWords(["Chapter 12: The Lantern Market", "  ", "\"Sit,\" Elder Hu said."])).toBe(9);
    expect(countWords(["......", "— ...", ""])).toBe(0);
    expect(countWords([])).toBe(0);
  });

  it("понимает кириллицу и переносы строк", () => {
    expect(countWords(["— Да.\n— Нет, не так."])).toBe(4);
  });
});
