import { describe, expect, it } from "vitest";
import { addressesFor, renderGlossaryBlock, termsInText } from "@/lib/core/glossary";
import { makeAddress, makeTerm } from "./helpers";

const lin = makeTerm({ id: "lin", en: "Lin Wei", ru: "Линь Вэй", gender: "m", aliases: ["Wei", "Little Wei"] });
const mei = makeTerm({ id: "mei", en: "Mei Su", ru: "Мэй Су", gender: "f" });
const hu = makeTerm({ id: "hu", en: "Elder Hu", ru: "старейшина Ху", gender: "m", status: "proposed", note: "наставник" });
const sect = makeTerm({ id: "sect", en: "Azure Cloud Sect", ru: "секта Лазурного Облака", kind: "org" });
const sectWord = makeTerm({ id: "sectword", en: "Sect", ru: "секта", kind: "other" });
const qi = makeTerm({ id: "qi", en: "qi", ru: "ци", kind: "technique" });
const x = makeTerm({ id: "x", en: "X", ru: "Икс", kind: "item" });
const all = [lin, mei, hu, sect, sectWord, qi, x];

describe("termsInText", () => {
  it("находит по en и aliases без учёта регистра, результат отсортирован по en", () => {
    const found = termsInText(all, "ELDER HU nodded. Little Wei bowed to mei su.");
    expect(found.map((t) => t.id)).toEqual(["hu", "lin", "mei"]);
  });

  it("только по границам слов, в том числе для коротких имён", () => {
    expect(termsInText([qi], "The qi gathered.").map((t) => t.id)).toEqual(["qi"]);
    expect(termsInText([qi], "A quiet technique.")).toEqual([]);
    expect(termsInText([lin], "Weird weather.")).toEqual([]);
    expect(termsInText([lin], "Wei's sword.").map((t) => t.id)).toEqual(["lin"]);
  });

  it("границы по Unicode: буквы с диакритикой не считаются границей", () => {
    const zoe = makeTerm({ id: "zoe", en: "Zoë", ru: "Зоя", gender: "f" });
    expect(termsInText([zoe], "Zoë smiled.").map((t) => t.id)).toEqual(["zoe"]);
    expect(termsInText([zoe], "Zoëlle smiled.")).toEqual([]);
    const ri = makeTerm({ id: "ri", en: "Ri", ru: "Ри" });
    expect(termsInText([ri], "Éri waved.")).toEqual([]);
  });

  it("длинный термин занимает свой кусок: «Sect» внутри «Azure Cloud Sect» отдельно не идёт", () => {
    expect(termsInText(all, "He joined the Azure Cloud Sect.").map((t) => t.id)).toEqual(["sect"]);
    expect(termsInText(all, "The Azure Cloud Sect is not the only sect.").map((t) => t.id)).toEqual(["sect", "sectword"]);
  });

  it("пробелы и перенос строки внутри составного имени не мешают", () => {
    expect(termsInText([sect], "the Azure  Cloud\nSect").map((t) => t.id)).toEqual(["sect"]);
  });

  it("имена короче 2 символов не ищутся", () => {
    expect(termsInText([x], "X marks the spot.")).toEqual([]);
  });

  it("пустой текст или глоссарий", () => {
    expect(termsInText(all, "")).toEqual([]);
    expect(termsInText([], "Lin Wei")).toEqual([]);
  });

  it("спецсимволы в имени экранируются", () => {
    const plus = makeTerm({ id: "plus", en: "Sword+", ru: "Меч+", kind: "item" });
    expect(termsInText([plus], "He drew the Sword+ slowly.").map((t) => t.id)).toEqual(["plus"]);
    expect(termsInText([plus], "Swordd")).toEqual([]);
  });
});

describe("addressesFor", () => {
  const present = [lin, mei, hu];

  it("оставляет обращения, где оба есть в тексте", () => {
    const list = [
      makeAddress({ fromTermId: "lin", toTermId: "hu", form: "vy" }),
      makeAddress({ fromTermId: "lin", toTermId: "sect", form: "ty" }),
    ];
    expect(addressesFor(list, present, 5).map((a) => a.toTermId)).toEqual(["hu"]);
  });

  it("учитывает fromChapter и берёт самое позднее действующее правило", () => {
    const list = [
      makeAddress({ id: "early", fromTermId: "lin", toTermId: "mei", form: "vy", fromChapter: null }),
      makeAddress({ id: "late", fromTermId: "lin", toTermId: "mei", form: "ty", fromChapter: 50 }),
    ];
    expect(addressesFor(list, present, 10).map((a) => a.id)).toEqual(["early"]);
    expect(addressesFor(list, present, 50).map((a) => a.id)).toEqual(["late"]);
    // Номер главы неизвестен — считаем главу свежей.
    expect(addressesFor(list, present, null).map((a) => a.id)).toEqual(["late"]);
  });

  it("правило, начинающееся позже главы, не действует", () => {
    const list = [makeAddress({ fromTermId: "mei", toTermId: "lin", form: "ty", fromChapter: 20 })];
    expect(addressesFor(list, present, 19)).toEqual([]);
  });

  it("при равном fromChapter проверенное важнее предложенного", () => {
    const list = [
      makeAddress({ id: "p", fromTermId: "mei", toTermId: "hu", form: "ty", status: "proposed" }),
      makeAddress({ id: "c", fromTermId: "mei", toTermId: "hu", form: "vy", status: "checked" }),
    ];
    expect(addressesFor(list, present, 1).map((a) => a.id)).toEqual(["c"]);
    expect(addressesFor([...list].reverse(), present, 1).map((a) => a.id)).toEqual(["c"]);
  });

  it("порядок детерминирован: по en того, кто говорит, затем кому", () => {
    const list = [
      makeAddress({ fromTermId: "mei", toTermId: "lin", form: "ty" }),
      makeAddress({ fromTermId: "lin", toTermId: "mei", form: "ty" }),
      makeAddress({ fromTermId: "lin", toTermId: "hu", form: "vy" }),
    ];
    const order = addressesFor(list, present, 1).map((a) => `${a.fromTermId}>${a.toTermId}`);
    expect(order).toEqual(["lin>hu", "lin>mei", "mei>lin"]);
    expect(addressesFor([...list].reverse(), present, 1).map((a) => `${a.fromTermId}>${a.toTermId}`)).toEqual(order);
  });
});

describe("renderGlossaryBlock", () => {
  it("термины по en с видом, родом, пометкой и [предложено], затем обращения", () => {
    const addresses = [
      makeAddress({ fromTermId: "lin", toTermId: "hu", form: "vy" }),
      makeAddress({ fromTermId: "hu", toTermId: "lin", form: "ty", status: "proposed" }),
    ];
    const block = renderGlossaryBlock([mei, lin, hu, sect], addresses, all);
    expect(block).toBe(
      [
        "ТЕРМИНЫ",
        "- Azure Cloud Sect → секта Лазурного Облака (организация)",
        "- Elder Hu → старейшина Ху (имя, м) — наставник [предложено]",
        "- Lin Wei (также: Little Wei, Wei) → Линь Вэй (имя, м)",
        "- Mei Su → Мэй Су (имя, ж)",
        "",
        "КТО К КОМУ ОБРАЩАЕТСЯ (первый говорит второму)",
        "- Elder Hu → Lin Wei: «ты» [предложено]",
        "- Lin Wei → Elder Hu: «вы»",
      ].join("\n"),
    );
  });

  it("одинаковый результат при любом порядке терминов", () => {
    const a = renderGlossaryBlock([lin, mei, hu], [], all);
    const b = renderGlossaryBlock([hu, mei, lin], [], all);
    expect(a).toBe(b);
  });

  it("пусто — пустая строка; переводы строк в заметке не ломают формат", () => {
    expect(renderGlossaryBlock([], [], all)).toBe("");
    const odd = makeTerm({ id: "odd", en: "Old Ox", ru: "Старый Вол", kind: "other", note: "фонарь\nв виде быка" });
    expect(renderGlossaryBlock([odd], [], all)).toBe("ТЕРМИНЫ\n- Old Ox → Старый Вол — фонарь в виде быка");
  });

  it("род не пишется, если неизвестен; термин без перевода пропускается", () => {
    const unknown = makeTerm({ id: "u", en: "Masked One", ru: "Маска", gender: "unknown" });
    const empty = makeTerm({ id: "e", en: "Blank", ru: "  " });
    expect(renderGlossaryBlock([unknown, empty], [], all)).toBe("ТЕРМИНЫ\n- Masked One → Маска (имя)");
  });
});
