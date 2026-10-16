import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/lib/core/cost";
import { createLabelParser } from "@/lib/core/labels";
import { buildTranslateRequest, REGISTER_DESCRIPTIONS, renderStyleBlock, RULES, type TranslatePromptInput } from "@/lib/core/prompt";
import { loadChapter, makeAddress, makeBook, makeTerm, wordsParagraph } from "./helpers";

const lin = makeTerm({ id: "lin", en: "Lin Wei", ru: "Линь Вэй", gender: "m" });
const mei = makeTerm({ id: "mei", en: "Mei Su", ru: "Мэй Су", gender: "f" });
const hu = makeTerm({ id: "hu", en: "Elder Hu", ru: "старейшина Ху", gender: "m", status: "proposed" });
const gate = makeTerm({ id: "gate", en: "Ninefold Gate", ru: "Девятикратные Врата", kind: "org" });
const absent = makeTerm({ id: "absent", en: "Crimson Peak", ru: "Багровый пик", kind: "place" });
const terms = [lin, mei, hu, gate, absent];
const addresses = [
  makeAddress({ fromTermId: "lin", toTermId: "hu", form: "vy" }),
  makeAddress({ fromTermId: "mei", toTermId: "lin", form: "ty" }),
  makeAddress({ fromTermId: "lin", toTermId: "absent", form: "ty" }),
];

function input(p: Partial<TranslatePromptInput> = {}): TranslatePromptInput {
  return {
    book: makeBook({ narratorPerson: 1, narratorGender: "m", register: "live", honorifics: "shixiong — «старший брат», без транскрипции" }),
    chapterNumber: 12,
    paragraphs: loadChapter(),
    terms,
    addresses,
    previousTail: [],
    summary: null,
    ...p,
  };
}

describe("RULES", () => {
  it("сохраняет суть правил «Толмача» и новые правила", () => {
    for (const piece of [
      "ГЛОССАРИЙ ОБЯЗАТЕЛЕН",
      "«Куда мы едем?», а не «Где мы едем?»",
      "Каждая реплика начинается с тире на новой строке",
      "три точки",
      "Ничего не сокращай",
      "Не смягчай",
      "⟦12⟧",
      "⟦0⟧",
      "[предложено]",
      "«ты» и «вы»",
      "м — мужской, ж — женский",
      "РАССКАЗЧИК",
      "Прим. переводчика",
    ]) {
      expect(RULES).toContain(piece);
    }
  });

  it("не просит объяснять решения (повод для отказа reasoning_extraction)", () => {
    expect(RULES).not.toMatch(/объясни|поясни свой|обоснуй/i);
  });
});

describe("renderStyleBlock", () => {
  it("стиль, рассказчик и обращения из настроек книги", () => {
    const block = renderStyleBlock(makeBook({ register: "elevated", narratorPerson: 1, narratorGender: "f", honorifics: "senpai — «сэмпай»" }));
    expect(block).toContain(REGISTER_DESCRIPTIONS.elevated);
    expect(block).toContain("от первого лица, женщина");
    expect(block).toContain("senpai — «сэмпай»");
    expect(block).toContain("The Lantern Bridge");
  });

  it("у всех трёх регистров своё описание", () => {
    expect(REGISTER_DESCRIPTIONS.live).toMatch(/^Живой/);
    expect(REGISTER_DESCRIPTIONS.plain).toMatch(/^Ровный/);
    expect(REGISTER_DESCRIPTIONS.elevated).toMatch(/^Возвышенный/);
  });

  it("без настроек — нейтральные строки, без обращений", () => {
    const block = renderStyleBlock(makeBook({ narratorPerson: null, narratorGender: null, honorifics: null }));
    expect(block).toContain("Рассказчик: не указан");
    expect(block).not.toContain("Вежливые обращения");
  });
});

describe("buildTranslateRequest", () => {
  it("system — правила и стиль одним блоком с одной меткой кэша", () => {
    const req = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    expect(req.system).toHaveLength(1);
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.system[0].text.startsWith(RULES)).toBe(true);
    expect(req.system[0].text).toContain("СТИЛЬ ЭТОЙ КНИГИ");
    expect(req.system[0].text).toContain("от первого лица, мужчина");
  });

  it("в system нет ничего, что меняется от части к части", () => {
    const a = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    const b = buildTranslateRequest(
      input({ paragraphs: [{ idx: 40, text: "Crimson Peak loomed." }], chapterNumber: 13, previousTail: ["— Пойдём."], summary: "Они встретились на мосту." }),
      "claude-sonnet-5-5",
      "medium",
    );
    expect(b.system).toEqual(a.system);
  });

  it("сообщение: глоссарий только этой части, обращения, текст с метками", () => {
    const req = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    expect(req.messages).toHaveLength(1);
    const user = req.messages[0].content;
    expect(user).toContain("- Lin Wei → Линь Вэй (имя, м)");
    expect(user).toContain("- Mei Su → Мэй Су (имя, ж)");
    expect(user).toContain("- Elder Hu → старейшина Ху (имя, м) [предложено]");
    expect(user).toContain("Ninefold Gate → Девятикратные Врата");
    expect(user).not.toContain("Crimson Peak");
    expect(user).toContain("- Lin Wei → Elder Hu: «вы»");
    expect(user).toContain("- Mei Su → Lin Wei: «ты»");
    expect(user).toContain("⟦0⟧ Chapter 12: The Lantern Market");
    expect(user).toContain("⟦12⟧ Far below the bridge");
    expect(user).toContain("ПЕРЕВЕДИ: абзацы 0–12, 13 шт.");
  });

  it("концовка прошлого текста и сводка — перед текстом, без меток", () => {
    const req = buildTranslateRequest(
      input({ previousTail: ["— Ты опоздал.", "⟦9⟧ Он кивнул."], summary: "Линь Вэй вернулся в город." }),
      "claude-sonnet-5-5",
      "medium",
    );
    const user = req.messages[0].content;
    const iSummary = user.indexOf("ЧТО БЫЛО РАНЬШЕ (для связности, не переводить)");
    const iTail = user.indexOf("КОНЕЦ ПРЕДЫДУЩЕГО ТЕКСТА (для связности, не переводить)");
    const iText = user.indexOf("ПЕРЕВЕДИ:");
    expect(iSummary).toBeGreaterThan(0);
    expect(iTail).toBeGreaterThan(iSummary);
    expect(iText).toBeGreaterThan(iTail);
    expect(user).toContain("[9] Он кивнул.");
    // Разбор ответа не должен видеть в подсказках чужих меток.
    const before = user.slice(0, iText);
    expect(before).not.toMatch(/⟦\d+⟧/);
  });

  it("без глоссария, концовки и сводки — только текст", () => {
    const req = buildTranslateRequest(input({ terms: [], addresses: [], paragraphs: [{ idx: 3, text: "Rain fell." }] }), "claude-sonnet-5-5", "low");
    expect(req.messages[0].content).toBe("ПЕРЕВЕДИ: абзац 3\n\n⟦3⟧ Rain fell.");
  });

  it("детерминирован: тот же вход в другом порядке даёт тот же запрос", () => {
    const a = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    const shuffled = input({ paragraphs: [...loadChapter()].reverse(), terms: [...terms].reverse(), addresses: [...addresses].reverse() });
    const b = buildTranslateRequest(shuffled, "claude-sonnet-5-5", "medium");
    expect(b).toEqual(a);
  });

  it("метки запроса совпадают с тем, что ждёт парсер ответа", () => {
    const req = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    const text = req.messages[0].content.split("ПЕРЕВЕДИ:")[1];
    const parser = createLabelParser({ from: 0, to: 12 });
    const got = [...parser.push(text), ...parser.finish()].map((p) => p.idx);
    expect(got).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it("inputTokensEstimate — по всему тексту запроса", () => {
    const req = buildTranslateRequest(input(), "claude-sonnet-5-5", "medium");
    const plain = estimateTokens(req.system[0].text) + estimateTokens(req.messages[0].content);
    expect(req.inputTokensEstimate).toBeGreaterThanOrEqual(plain);
    expect(req.inputTokensEstimate).toBeLessThan(plain * 1.2);
  });

  it("maxTokens: ожидаемый вывод × 1,5 + запас на обдумывание, Opus — больше, потолок 64 000", () => {
    // 1 000 слов в 10 абзацах: 2,9 × 1000 + 20 × 10 = 3 100 → × 1,5 = 4 650.
    const paragraphs = Array.from({ length: 10 }, (_, i) => wordsParagraph(i + 1, 100));
    const base = input({ paragraphs, terms: [], addresses: [] });
    expect(buildTranslateRequest(base, "claude-sonnet-5-5", "low").maxTokens).toBe(4650 + 4000);
    expect(buildTranslateRequest(base, "claude-sonnet-5-5", "medium").maxTokens).toBe(4650 + 8000);
    expect(buildTranslateRequest(base, "claude-sonnet-5-5", "high").maxTokens).toBe(4650 + 16000);
    expect(buildTranslateRequest(base, "claude-opus-5-5", "medium").maxTokens).toBe(4650 + 8000 + 4000);
    const huge = input({ paragraphs: [wordsParagraph(1, 20000)], terms: [], addresses: [] });
    expect(buildTranslateRequest(huge, "claude-opus-5-5", "high").maxTokens).toBe(64000);
  });

  it("пустая часть — ошибка программиста", () => {
    expect(() => buildTranslateRequest(input({ paragraphs: [] }), "claude-sonnet-5-5", "low")).toThrow();
  });
});
