import { describe, expect, it } from "vitest";
import { checkTranslation, levenshtein, ruStem } from "@/lib/core/checks";
import { makeTerm } from "./helpers";

const lin = makeTerm({ id: "lin", en: "Lin Wei", ru: "Линь Вэй", gender: "m" });
const mei = makeTerm({ id: "mei", en: "Mei Su", ru: "Мэй Су", gender: "f" });
const kira = makeTerm({ id: "kira", en: "Kira", ru: "Кира", gender: "f" });
const zhang = makeTerm({ id: "zhang", en: "Zhang Haoran", ru: "Чжан Хаожань", gender: "m" });
const sect = makeTerm({ id: "sect", en: "Azure Cloud Sect", ru: "секта Лазурного Облака", kind: "org" });
const mana = makeTerm({ id: "mana", en: "mana", ru: "мана", kind: "other" });
const system = makeTerm({ id: "sys", en: "System", ru: "System", kind: "other" });
const terms = [lin, mei, kira, zhang, sect, mana, system];

const src = (idx: number, text: string) => ({ idx, text });
const tr = (idx: number, text: string, refused?: boolean) => ({ idx, text, ...(refused ? { refused } : {}) });
const kinds = (issues: ReturnType<typeof checkTranslation>) => issues.map((i) => `${i.idx}:${i.kind}`);

describe("checkTranslation — пропуски и отказы", () => {
  it("абзац без перевода и пустой перевод — missing; отказ — refused", () => {
    const issues = checkTranslation(
      [src(0, "Chapter 1"), src(1, "He nodded."), src(2, "She left."), src(3, "Rain.")],
      [tr(0, "Глава 1"), tr(2, "   "), tr(3, "[Модель отказалась переводить этот абзац]", true)],
      terms,
    );
    expect(kinds(issues)).toEqual(["1:missing", "2:missing", "3:refused"]);
    expect(issues[0].message).toMatch(/не переведён/);
  });

  it("пустой абзац оригинала не проверяется", () => {
    expect(checkTranslation([src(1, "  ")], [], terms)).toEqual([]);
  });

  it("чистый перевод — без замечаний", () => {
    const issues = checkTranslation(
      [src(1, "Lin Wei looked at Mei Su and said nothing for a long, long while.")],
      [tr(1, "Линь Вэй смотрел на Мэй Су и долго-долго молчал, не находя ни слова в ответ.")],
      terms,
    );
    expect(issues).toEqual([]);
  });
});

describe("checkTranslation — длина", () => {
  const long = "The river carried a thousand small lights toward the distant sea that night.";
  it("слишком короткий и слишком длинный перевод", () => {
    expect(kinds(checkTranslation([src(1, long)], [tr(1, "Река текла.")], terms))).toEqual(["1:length"]);
    const bloated = "Река несла тысячу маленьких огней к далёкому морю той ночью. ".repeat(4);
    expect(kinds(checkTranslation([src(1, long)], [tr(1, bloated)], terms))).toEqual(["1:length"]);
  });

  it("короткие абзацы (меньше 8 слов) по длине не проверяются", () => {
    expect(checkTranslation([src(1, "\"Sit,\" Elder Hu said.")], [tr(1, "— Сядь.")], terms)).toEqual([]);
  });
});

describe("checkTranslation — латиница", () => {
  it("находит непереведённые слова", () => {
    const issues = checkTranslation([src(1, "The quest began.")], [tr(1, "Начался quest, и Lin Wei пошёл.")], terms);
    expect(kinds(issues)).toEqual(["1:latin"]);
    expect(issues[0].message).toContain("quest");
    expect(issues[0].message).toContain("Lin");
  });

  it("белый список: аббревиатуры, римские цифры, термины с латиницей в ru, одиночные буквы", () => {
    const issues = checkTranslation(
      [src(1, "HP and LV rose.")],
      [tr(1, "HP и LV выросли, System молчала, Карл XIV кивнул, а S-ранг остался.")],
      terms,
    );
    expect(issues).toEqual([]);
  });

  it("латинская буква внутри русского слова", () => {
    const issues = checkTranslation([src(1, "Mana flowed.")], [tr(1, "Мaна текла.")], terms);
    expect(kinds(issues)).toEqual(["1:latin"]);
    expect(issues[0].message).toMatch(/внутри русского слова/);
  });
});

describe("checkTranslation — написание терминов", () => {
  it("«Лин Вэй» при «Линь Вэй»", () => {
    const issues = checkTranslation([src(1, "Lin Wei nodded.")], [tr(1, "Лин Вэй кивнул.")], terms);
    expect(kinds(issues)).toEqual(["1:term_spelling"]);
    expect(issues[0].message).toContain("«Лин»");
    expect(issues[0].message).toContain("«Линь»");
  });

  it("склонения термина — не ошибка", () => {
    const issues = checkTranslation(
      [src(1, "Zhang Haoran and Lin Wei.")],
      [tr(1, "Он видел Чжана Хаоженя? Нет — Чжану Хаожаню и Линю Вэю, а потом с Линем, Кирой и Кире.")],
      terms,
    );
    // «Хаоженя» — искажённая основа (хаожен ≠ хаожан), остальное — законные формы.
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("«Хаоженя»")]);
  });

  it("одна буква в основе: «Джан» при «Чжан»", () => {
    const issues = checkTranslation([src(1, "Zhang left.")], [tr(1, "Джан ушёл.")], terms);
    expect(kinds(issues)).toEqual(["1:term_spelling"]);
  });

  it("обычное слово в начале предложения не принимается за имя, если оно есть строчным", () => {
    const issues = checkTranslation(
      [src(1, "There will be no peace. He wanted peace.")],
      [tr(1, "Мира не будет. Он хотел мира.")],
      terms,
    );
    expect(issues).toEqual([]);
  });

  it("строчные слова и нарицательные термины не проверяются", () => {
    const issues = checkTranslation([src(1, "The mana was thin.")], [tr(1, "Мина была тонкой, а кира — это не имя.")], terms);
    expect(issues).toEqual([]);
  });

  it("имя другого персонажа из глоссария — не ошибка", () => {
    const lina = makeTerm({ id: "lina", en: "Lina", ru: "Лина", gender: "f" });
    const issues = checkTranslation([src(1, "Lina and Lin Wei.")], [tr(1, "Лина и Линь Вэй.")], [...terms, lina]);
    expect(issues).toEqual([]);
  });

  it("одно замечание на слово в абзаце", () => {
    const issues = checkTranslation([src(1, "Lin Wei, Lin Wei!")], [tr(1, "Лин Вэй, Лин Вэй!")], terms);
    expect(issues).toHaveLength(1);
  });
});

describe("порядок замечаний", () => {
  it("по idx, затем по виду", () => {
    const long = "The lanterns swayed above the crowd as the evening wind rose from the river.";
    const issues = checkTranslation(
      [src(2, long), src(1, "Lin Wei nodded slowly.")],
      [tr(2, "Фонари quest."), tr(1, "Лин Вэй кивнул.")],
      terms,
    );
    expect(kinds(issues)).toEqual(["1:term_spelling", "2:length", "2:latin"]);
  });
});

describe("ruStem и levenshtein", () => {
  it("срезает окончания, ё → е", () => {
    expect(ruStem("Кирой")).toBe("кир");
    expect(ruStem("Линю")).toBe("лин");
    expect(ruStem("Лазурного")).toBe("лазурн");
    expect(ruStem("Лёд")).toBe("лед");
    expect(ruStem("Ли")).toBe("ли");
  });

  it("расстояние правок", () => {
    expect(levenshtein("чжан", "джан")).toBe(1);
    expect(levenshtein("хаожан", "хаожен")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
});
