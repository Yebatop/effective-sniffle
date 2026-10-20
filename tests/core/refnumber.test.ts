import { describe, expect, it } from "vitest";
import { resolveRefNumber } from "@/lib/core/refnumber";
import { estimateGlossaryUsd } from "@/lib/core/cost";

describe("номер главы готового перевода", () => {
  it("обычная глава — номер из заголовка", () => {
    expect(resolveRefNumber("Том 1 Глава 12. Соль", null, null)).toEqual({ number: 12, append: false });
    expect(resolveRefNumber("Глава 13", null, 13)).toEqual({ number: 13, append: false });
  });
  it("часть 2 и дальше дописывается к главе", () => {
    expect(resolveRefNumber("Глава 5.1 Переправа", null, 5)).toEqual({ number: 5, append: false });
    expect(resolveRefNumber("Глава 5.2 Переправа", null, 6)).toEqual({ number: 5, append: true });
    expect(resolveRefNumber("Глава 5,3", null, 6)).toEqual({ number: 5, append: true });
    expect(resolveRefNumber("Chapter 7.2: Ferry", null, null)).toEqual({ number: 7, append: true });
  });
  it("тот же номер подряд при обходе — продолжение прошлой главы", () => {
    expect(resolveRefNumber("Глава 5 (продолжение)", null, 6)).toEqual({ number: 5, append: true });
  });
  it("нумерация началась заново (новый том) — берётся ожидаемый номер", () => {
    expect(resolveRefNumber("Том 2 Глава 1", null, 41)).toEqual({ number: 41, append: false });
    expect(resolveRefNumber("Том 2 Глава 1.1", null, 41)).toEqual({ number: 41, append: false });
  });
  it("том с нумерацией заново и главы из частей: части идут к своей главе, а не к главе первого тома", () => {
    expect(resolveRefNumber("Том 2 Глава 1.1", null, 41, "Том 1 Глава 40")).toEqual({ number: 41, append: false });
    expect(resolveRefNumber("Том 2 Глава 1.2", null, 42, "Том 2 Глава 1.1")).toEqual({ number: 41, append: true });
    expect(resolveRefNumber("Глава 1 (продолжение)", null, 42, "Том 2 Глава 1.1")).toEqual({ number: 41, append: true });
    expect(resolveRefNumber("Том 2 Глава 2.1", null, 42, "Том 2 Глава 1.1")).toEqual({ number: 42, append: false });
    expect(resolveRefNumber("Том 2 Глава 2.2", null, 43, "Том 2 Глава 2.1")).toEqual({ number: 42, append: true });
    expect(resolveRefNumber("Том 2 Глава 3", null, 43, "Том 2 Глава 2.1")).toEqual({ number: 43, append: false });
  });
  it("без номера — ожидаемый, а если и его нет — не понять", () => {
    expect(resolveRefNumber("Эпилог", null, 120)).toEqual({ number: 120, append: false });
    expect(resolveRefNumber("Эпилог", null, null)).toBeNull();
  });
  it("скачок вперёд (на сайте пропущены главы) — номер из заголовка", () => {
    expect(resolveRefNumber("Глава 30", null, 25)).toEqual({ number: 30, append: false });
  });
});

describe("цена сбора глоссария", () => {
  it("растёт линейно с числом глав: наценка за длинный вход — с вызова, а не с суммы", () => {
    const one = estimateGlossaryUsd("claude-haiku-5-5", { scanWords: 9000, scanCalls: 1, alignEnWords: 0, alignRuWords: 0, alignPairs: 0 });
    const many = estimateGlossaryUsd("claude-haiku-5-5", { scanWords: 9000 * 250, scanCalls: 250, alignEnWords: 0, alignRuWords: 0, alignPairs: 0 });
    expect(many / one).toBeCloseTo(250, 5);
    // ~1000 глав по ~2 250 слов на Haiku 5.5 — порядка доллара, а не пяти.
    expect(many).toBeLessThan(1.5);
  });
});
