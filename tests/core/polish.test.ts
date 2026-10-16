import { describe, expect, it } from "vitest";
import { polish } from "@/lib/core/polish";

// Случаи из exttran:src/selftest.ts («типографика правится, а текст не страдает»).
describe("polish", () => {
  it("сводит ряд точек к многоточию, не съедая его целиком", () => {
    const fromSite = ["— Да. Куда мы поедем?", "", "— ......В библиотеку."].join("\n");
    const fixed = polish(fromSite);
    expect(fixed).not.toContain("....");
    expect(fixed).toContain("...");
    expect(fixed.split("\n\n")).toHaveLength(2);
  });

  it("дефис в начале реплики становится тире", () => {
    expect(polish("- Да.").startsWith("— ")).toBe(true);
    expect(polish("– Нет.\n- Да.")).toBe("— Нет.\n— Да.");
  });

  it("не трогает тире внутри фразы", () => {
    const dash = "Он — человек слова.";
    expect(polish(dash)).toBe(dash);
  });

  it("не склеивает абзацы", () => {
    const paragraphs = "Первый.\n\nВторой.";
    expect(polish(paragraphs)).toBe(paragraphs);
  });

  it("не трогает обычное многоточие", () => {
    const three = "Ну... ладно.";
    expect(polish(three)).toBe(three);
  });

  it("убирает пробел перед знаками, двойные пробелы и лишние пустые строки", () => {
    expect(polish("Ну , ладно !")).toBe("Ну, ладно!");
    expect(polish("Два  пробела   тут.")).toBe("Два пробела тут.");
    expect(polish("А.\n\n\n\nБ.")).toBe("А.\n\nБ.");
    expect(polish("  края  \n")).toBe("края");
  });
});
