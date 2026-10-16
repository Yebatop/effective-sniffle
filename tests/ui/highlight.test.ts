import { describe, expect, it } from "vitest";
import { compileTerms, highlight, highlightWith, termPattern } from "@/lib/client/highlight";

type T = { id: string; ru: string };
const t = (id: string, ru: string): T => ({ id, ru });

function marked(text: string, terms: T[]): Array<[string, string]> {
  return highlight(text, terms)
    .filter((s) => s.term)
    .map((s) => [s.text, (s.term as T).id]);
}

describe("подсветка терминов", () => {
  it("ловит падежные окончания", () => {
    const terms = [t("e", "Эбенхольц")];
    expect(marked("Он увидел Эбенхольца и пошёл за Эбенхольцем.", terms)).toEqual([
      ["Эбенхольца", "e"],
      ["Эбенхольцем", "e"],
    ]);
  });

  it("слово на гласную ищется по основе", () => {
    const terms = [t("l", "Лина"), t("p", "Печать")];
    expect(marked("У Лины была Печать; с Печатью и Линой.", terms)).toEqual([
      ["Лины", "l"],
      ["Печать", "p"],
      ["Печатью", "p"],
      ["Линой", "l"],
    ]);
  });

  it("без учёта регистра и с е = ё", () => {
    const terms = [t("o", "Орден"), t("y", "Ёж")];
    expect(marked("орден ОРДЕНА", terms)).toEqual([
      ["орден", "o"],
      ["ОРДЕНА", "o"],
    ]);
    const terms2 = [t("s", "Звёздный")];
    expect(marked("Звездный путь", terms2)).toEqual([["Звездный", "s"]]);
  });

  it("длинные термины раньше коротких", () => {
    const terms = [t("short", "Орден"), t("long", "Орден Стражей")];
    expect(marked("Пришёл Орден Стражей, а потом просто Орден.", terms)).toEqual([
      ["Орден Стражей", "long"],
      ["Орден", "short"],
    ]);
  });

  it("не подчёркивает часть другого слова", () => {
    const terms = [t("m", "мана")];
    expect(marked("манатки и манекен, но мана и маной", terms)).toEqual([
      ["мана", "m"],
      ["маной", "m"],
    ]);
    // Внутри слова слева тоже нельзя.
    expect(marked("Карамана", [t("r", "мана")])).toEqual([]);
  });

  it("пропускает термины короче трёх букв", () => {
    expect(compileTerms([t("a", "Гу"), t("b", " И ")])).toBeNull();
    expect(marked("Гу пришёл", [t("a", "Гу")])).toEqual([]);
  });

  it("регулярка собирается один раз и работает на многих абзацах подряд", () => {
    const compiled = compileTerms([t("e", "Эбенхольц")]);
    expect(compiled).not.toBeNull();
    for (let i = 0; i < 3; i += 1) {
      const segs = highlightWith("Эбенхольц и Эбенхольца", compiled);
      expect(segs.filter((s) => s.term).length).toBe(2);
    }
  });

  it("склоняет каждое слово в составном термине", () => {
    expect(marked("Ученик наставника Гу ждал.", [t("g", "наставник Гу")])).toEqual([["наставника Гу", "g"]]);
    expect(termPattern("наставник Гу")).toContain("\\s+");
  });

  it("собирает исходный текст без потерь", () => {
    const text = "Эбенхольц, мана и Орден Стражей.";
    const segs = highlight(text, [t("e", "Эбенхольц"), t("m", "мана"), t("o", "Орден Стражей")]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });
});
