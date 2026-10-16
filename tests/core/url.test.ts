import { describe, expect, it } from "vitest";
import { bookKeyFromUrl, chapterNumberFrom, normalizeUrl, siteOf } from "@/lib/core/url";

// Адреса выдуманы, но повторяют форму настоящих сайтов.
const RR = "https://www.royalroad.com/fiction/21220/some-slug/chapter/301778/chapter-12-the-lantern-market";
const RR_OTHER = "https://www.royalroad.com/fiction/40512/another-story/chapter/655001/chapter-1-rain";
const SH = "https://www.scribblehub.com/read/123456-some-slug/chapter/789012/";
const WN = "https://www.webnovel.com/book/some-title_12345678/chapter-title_98765";
const AO3 = "https://archiveofourown.org/works/123/chapters/456";
const AO3_OTHER = "https://archiveofourown.org/works/987/chapters/111";
const WW = "https://www.wuxiaworld.com/novel/some-novel/sn-chapter-12";

describe("normalizeUrl", () => {
  it("https, хост в нижнем регистре, без #, меток и / в конце", () => {
    expect(normalizeUrl("http://Example.COM/Novel/Chapter-12/?utm_source=x&utm_medium=y#comments")).toBe("https://example.com/Novel/Chapter-12");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/a//b/")).toBe("https://example.com/a/b");
  });

  it("убирает fbclid, ref, gclid, оставляет значимые параметры как есть", () => {
    expect(normalizeUrl("https://example.com/read?id=5&fbclid=abc&ref=home&page=2&gclid=z")).toBe("https://example.com/read?id=5&page=2");
    expect(normalizeUrl("https://archiveofourown.org/works/123/chapters/456?view_adult=true&ref_src=tw")).toBe(
      "https://archiveofourown.org/works/123/chapters/456?view_adult=true",
    );
    expect(normalizeUrl("https://example.com/s?q=a%20b")).toBe("https://example.com/s?q=a%20b");
  });

  it("Royal Road: канон /fiction/{id}/chapter/{chapterId} без слагов", () => {
    expect(normalizeUrl(RR)).toBe("https://www.royalroad.com/fiction/21220/chapter/301778");
    expect(normalizeUrl("https://www.royalroad.com/fiction/21220/some-slug")).toBe("https://www.royalroad.com/fiction/21220");
  });

  it("порты по умолчанию и учётные данные отбрасываются", () => {
    expect(normalizeUrl("http://user:pw@example.com:80/x")).toBe("https://example.com/x");
    expect(normalizeUrl("https://example.com:8443/x")).toBe("https://example.com:8443/x");
  });

  it("адрес без схемы дополняется, не-адреса — null", () => {
    expect(normalizeUrl("www.example.com/novel/ch-3")).toBe("https://www.example.com/novel/ch-3");
    expect(normalizeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
    for (const bad of ["", "просто текст", "not a url", "javascript:alert(1)", "ftp://example.com/x", "mailto:a@b.c", "chapter-12"]) {
      expect(normalizeUrl(bad)).toBeNull();
    }
  });
});

describe("bookKeyFromUrl", () => {
  it("Royal Road: по id книги, разные книги — разные ключи", () => {
    expect(bookKeyFromUrl(RR)).toBe("royalroad.com/fiction/21220");
    expect(bookKeyFromUrl("https://royalroad.com/fiction/21220/some-slug")).toBe("royalroad.com/fiction/21220");
    expect(bookKeyFromUrl(RR_OTHER)).toBe("royalroad.com/fiction/40512");
    expect(bookKeyFromUrl(RR)).not.toBe(bookKeyFromUrl(RR_OTHER));
    // Адрес без id книги — не угадываем.
    expect(bookKeyFromUrl("https://www.royalroad.com/fiction/chapter/301778")).toBeNull();
  });

  it("ScribbleHub: /read/{id}-slug и /series/{id} дают один ключ", () => {
    expect(bookKeyFromUrl(SH)).toBe("scribblehub.com/series/123456");
    expect(bookKeyFromUrl("https://www.scribblehub.com/series/123456/some-slug/")).toBe("scribblehub.com/series/123456");
  });

  it("Webnovel: id из хвоста слага", () => {
    expect(bookKeyFromUrl(WN)).toBe("webnovel.com/book/12345678");
    expect(bookKeyFromUrl("https://m.webnovel.com/book/12345678")).toBe("webnovel.com/book/12345678");
  });

  it("AO3: по work id, разные работы — разные ключи", () => {
    expect(bookKeyFromUrl(AO3)).toBe("archiveofourown.org/works/123");
    expect(bookKeyFromUrl("https://archiveofourown.org/works/123")).toBe("archiveofourown.org/works/123");
    expect(bookKeyFromUrl("https://archiveofourown.org/collections/fest/works/123/chapters/456")).toBe("archiveofourown.org/works/123");
    expect(bookKeyFromUrl(AO3_OTHER)).toBe("archiveofourown.org/works/987");
    expect(bookKeyFromUrl("https://archiveofourown.org/chapters/456")).toBeNull();
  });

  it("Wuxiaworld: по слагу новеллы", () => {
    expect(bookKeyFromUrl(WW)).toBe("wuxiaworld.com/novel/some-novel");
  });

  it("сайты переводчиков на WordPress", () => {
    expect(bookKeyFromUrl("https://translator.example/novel-name/chapter-12/")).toBe("translator.example/novel-name");
    expect(bookKeyFromUrl("https://translator.example/series/novel-name/ch-12")).toBe("translator.example/series/novel-name");
    expect(bookKeyFromUrl("https://translator.example/novel/name/chapter/12")).toBe("translator.example/novel/name");
    expect(bookKeyFromUrl("https://translator.example/novel/name/vol-2/chapter-5")).toBe("translator.example/novel/name");
    expect(bookKeyFromUrl("https://translator.example/novel/1234/chapter-5")).toBe("translator.example/novel/1234");
    expect(bookKeyFromUrl("https://translator.example/novel/name/116")).toBe("translator.example/novel/name");
    expect(bookKeyFromUrl("https://translator.example/b/12345/678.html")).toBe("translator.example/b/12345");
    // Слаг главы без номера — всё равно последний сегмент.
    expect(bookKeyFromUrl("https://translator.example/novel-name/the-long-night")).toBe("translator.example/novel-name");
  });

  it("одиночный сегмент — без номера главы", () => {
    expect(bookKeyFromUrl("https://translator.example/martial-peak-chapter-12/")).toBe("translator.example/martial-peak");
    expect(bookKeyFromUrl("https://translator.example/martial-peak-12")).toBe("translator.example/martial-peak");
    expect(bookKeyFromUrl("https://translator.example/martial-peak")).toBe("translator.example/martial-peak");
    expect(bookKeyFromUrl("https://translator.example/chapter-12")).toBe("translator.example");
    expect(bookKeyFromUrl("https://translator.example/music-12")).toBe("translator.example/music");
  });

  it("главы одной книги — один ключ, метки и регистр не мешают", () => {
    const a = bookKeyFromUrl("https://www.Translator.example/Novel-Name/chapter-1/?utm_source=x");
    const b = bookKeyFromUrl("https://translator.example/novel-name/chapter-2#comments");
    expect(a).toBe(b);
  });

  it("не адрес — null", () => {
    expect(bookKeyFromUrl("какой-то текст")).toBeNull();
  });
});

describe("chapterNumberFrom", () => {
  it("из заголовка — в первую очередь", () => {
    expect(chapterNumberFrom("Chapter 12: The Lantern Market", RR_OTHER)).toBe(12);
    expect(chapterNumberFrom("Ch. 7 - Rain", null)).toBe(7);
    expect(chapterNumberFrom("ch.15", null)).toBe(15);
    expect(chapterNumberFrom("Глава 42. Мост", null)).toBe(42);
    expect(chapterNumberFrom("Episode 3", null)).toBe(3);
    expect(chapterNumberFrom("The Lantern Bridge #19", null)).toBe(19);
    expect(chapterNumberFrom("Vol. 2 Chapter 30 — Ice", null)).toBe(30);
    expect(chapterNumberFrom("[Chapter 5] Return", null)).toBe(5);
    expect(chapterNumberFrom("Chapter 12.5: Interlude", null)).toBe(12.5);
    expect(chapterNumberFrom("12. The Return", null)).toBe(12);
  });

  it("заголовок без номера — из адреса", () => {
    expect(chapterNumberFrom("The Lantern Market", RR)).toBe(12);
    expect(chapterNumberFrom(null, WW)).toBe(12);
    expect(chapterNumberFrom(null, "https://translator.example/novel-name/chapter-12/")).toBe(12);
    expect(chapterNumberFrom(null, "https://translator.example/series/novel-name/ch-12")).toBe(12);
    expect(chapterNumberFrom(null, "https://translator.example/novel-name/c12")).toBe(12);
    expect(chapterNumberFrom(null, "https://translator.example/novel/name/116")).toBe(116);
    expect(chapterNumberFrom(null, "https://translator.example/novel/1234/chapter-5")).toBe(5);
    expect(chapterNumberFrom(null, "https://translator.example/novel/name/chapter/12")).toBe(12);
    expect(chapterNumberFrom(null, "https://translator.example/read?id=77&chapter=9")).toBe(9);
    expect(chapterNumberFrom(null, "https://translator.example/martial-peak-chapter-12-the-return/")).toBe(12);
  });

  it("никогда не берёт внутренний id главы", () => {
    // Royal Road: 301778 — id, не номер главы (ошибка exttran:src/book.ts chapterNumber).
    expect(chapterNumberFrom(null, "https://www.royalroad.com/fiction/21220/some-slug/chapter/301778/the-lantern-market")).toBeNull();
    expect(chapterNumberFrom(null, "https://www.royalroad.com/fiction/21220/chapter/301778")).toBeNull();
    expect(chapterNumberFrom(null, SH)).toBeNull();
    expect(chapterNumberFrom(null, AO3)).toBeNull();
    expect(chapterNumberFrom(null, WN)).toBeNull();
    expect(chapterNumberFrom(null, "https://www.webnovel.com/book/some-title_12345678/chapter-7-dawn_98765")).toBe(7);
    // Длинное голое число — скорее id, чем номер.
    expect(chapterNumberFrom(null, "https://translator.example/novel/name/301778")).toBeNull();
  });

  it("неясно — null", () => {
    expect(chapterNumberFrom(null, null)).toBeNull();
    expect(chapterNumberFrom("Prologue", null)).toBeNull();
    expect(chapterNumberFrom("", "https://translator.example/novel-name/the-long-night")).toBeNull();
    expect(chapterNumberFrom(null, "https://translator.example/search-12")).toBeNull();
    expect(chapterNumberFrom(null, "не адрес")).toBeNull();
  });
});

describe("siteOf", () => {
  it("хост без www. и m.", () => {
    expect(siteOf(RR)).toBe("royalroad.com");
    expect(siteOf("https://m.webnovel.com/book/1")).toBe("webnovel.com");
    expect(siteOf("https://archiveofourown.org/works/1")).toBe("archiveofourown.org");
    expect(siteOf("https://translator.example/x")).toBe("translator.example");
    expect(siteOf(null)).toBeNull();
    expect(siteOf("мусор")).toBeNull();
  });
});
