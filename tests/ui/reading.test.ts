import { describe, expect, it } from "vitest";
import {
  READING_WPM,
  countWords,
  isLiveJobState,
  isStoppedJobState,
  maxSeq,
  mergeTranslated,
  minutesLeft,
  orderedParagraphs,
} from "@/lib/client/reading";

describe("время до конца главы", () => {
  it("считает русские слова", () => {
    expect(countWords("Он пошёл — и вернулся, 3 раза.")).toBe(6); // тире — не слово
    expect(countWords("   ")).toBe(0);
    expect(countWords("")).toBe(0);
  });

  it("180 слов в минуту, с округлением вверх, без названия главы", () => {
    const words = (n: number) => Array.from({ length: n }, () => "слово").join(" ");
    const paras = [
      { idx: 0, text: words(1000) }, // название не считается
      { idx: 1, text: words(READING_WPM) },
      { idx: 2, text: words(10) },
    ];
    expect(minutesLeft(paras, 1)).toBe(2);
    expect(minutesLeft(paras, 2)).toBe(1);
    expect(minutesLeft(paras, 3)).toBe(0);
    expect(minutesLeft([{ idx: 1, text: words(360) }], 1)).toBe(2);
  });
});

describe("слияние абзацев из опроса", () => {
  it("по idx, побеждает больший seq, порядок — по idx", () => {
    let m = mergeTranslated(new Map(), [
      { idx: 2, text: "два", seq: 2 },
      { idx: 1, text: "один", seq: 1 },
    ]);
    m = mergeTranslated(m, [
      { idx: 1, text: "один (исправлено)", seq: 5 },
      { idx: 2, text: "старое", seq: 1 },
      { idx: 0, text: "Название", seq: 3 },
    ]);
    expect(orderedParagraphs(m).map((p) => p.text)).toEqual(["Название", "один (исправлено)", "два"]);
    expect(maxSeq(orderedParagraphs(m))).toBe(5);
  });

  it("не меняет прежнюю карту", () => {
    const a = mergeTranslated(new Map(), [{ idx: 1, text: "x", seq: 1 }]);
    const b = mergeTranslated(a, [{ idx: 2, text: "y", seq: 2 }]);
    expect(a.size).toBe(1);
    expect(b.size).toBe(2);
  });

  it("состояния задачи", () => {
    expect(isLiveJobState("queued")).toBe(true);
    expect(isLiveJobState("running")).toBe(true);
    expect(isLiveJobState("done")).toBe(false);
    expect(isStoppedJobState("blocked_budget")).toBe(true);
    expect(isStoppedJobState("blocked_credit")).toBe(true);
    expect(isStoppedJobState("failed")).toBe(true);
    expect(isStoppedJobState("done")).toBe(false);
  });
});
