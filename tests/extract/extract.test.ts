import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseHtml, checkFetchUrl, fetchChapter } from "@/lib/extract/server";
import { extractFromDocument, findNextLink, markHiddenByStyles } from "@/lib/extract/dom";
import { decodeMhtml } from "@/lib/extract/mhtml";
import { chapterFromPastedText, sharedUrl } from "@/lib/extract/text";
import { isChallengePage } from "@/lib/extract/challenge";
import { USERSCRIPT_BODY } from "@/lib/generated/userscript";

// Все страницы в fixtures придуманы для тестов.
const fx = (n: string) => readFileSync(`tests/fixtures/extract/${n}`, "utf8");
const extract = (file: string, url: string) => extractFromDocument(parseHtml(fx(file)), { url });

describe("pages", () => {
  test("normal chapter: title, paragraphs, links, no nav or comments", () => {
    const r = extract("chapter-normal.html", "https://inkwell.example/novel/the-glass-heron/chapter-12");
    expect(r.chapterTitle).toBe("Chapter 12: The Lantern Market");
    expect(r.bookTitle).toBe("The Glass Heron");
    expect(r.paragraphs.length).toBeGreaterThan(10);
    expect(r.paragraphs).toContain("* * *");
    expect(r.nextUrl).toBe("https://inkwell.example/novel/the-glass-heron/chapter-13");
    expect(r.prevUrl).toBe("https://inkwell.example/novel/the-glass-heron/chapter-11");
    expect(r.looksLocked).toBe(false);
    expect(r.looksLikeIndex).toBe(false);
  });

  test("minified html keeps paragraphs apart", () => {
    const r = extract("chapter-minified.html", "https://rust.example/series/rust-and-rain/chapter-3");
    expect(r.paragraphs.length).toBeGreaterThanOrEqual(8);
    for (const p of r.paragraphs) expect(p).not.toMatch(/[a-z][.!?”"][A-Z“"]/);
  });

  test("paragraphs hidden by a <style> rule are dropped", () => {
    const r = extract("royalroad-like.html", "https://serialhall.example/fiction/48213/ashes/chapter/900200/chapter-7");
    // В fixture абзац с классом .kQ3vX9tRz2bL скрыт правилом display:none во внутреннем <style>.
    expect(r.paragraphs.join("\n")).not.toContain("taken without permission");
    expect(r.paragraphs.length).toBeGreaterThanOrEqual(6);
    expect(markHiddenByStyles(parseHtml(fx("royalroad-like.html")))).toBeGreaterThan(0);
  });

  test("rules inside @media print do not hide text on screen", () => {
    const html = `<html><head><style>@media print { .ad, .keep { display: none; } }</style></head><body><article>
      <h1>Chapter 1</h1>${Array.from({ length: 6 }, (_, i) => `<p class="keep">Visible paragraph number ${i + 1} with enough words to count as prose here.</p>`).join("")}
    </article></body></html>`;
    const r = extractFromDocument(parseHtml(html), { url: "https://x.example/novel/a/chapter-1" });
    expect(r.paragraphs).toHaveLength(6);
  });

  test("table of contents is recognised", () => {
    expect(extract("toc.html", "https://inkwell.example/novel/the-ninth-lock").looksLikeIndex).toBe(true);
  });

  test("locked teaser vs long chapter with a Patreon footer", () => {
    expect(extract("locked.html", "https://inkwell.example/novel/salt-and-ember/chapter-88").looksLocked).toBe(true);
    const long = extract("long-patreon.html", "https://inkwell.example/novel/salt-and-ember/chapter-41");
    expect(long.looksLocked).toBe(false);
    expect(long.paragraphs.length).toBeGreaterThan(10);
  });

  test("challenge page is detected", () => {
    expect(isChallengePage({ status: 403, html: fx("challenge.html") })).toBe(true);
    expect(isChallengePage({ status: 200, headers: { "cf-mitigated": "challenge" }, html: "<html></html>" })).toBe(true);
    expect(isChallengePage({ status: 200, html: fx("chapter-normal.html") })).toBe(false);
  });

  test("next link variants", () => {
    const doc = (body: string) => parseHtml(`<html><body><p>text</p>${body}</body></html>`);
    const base = "https://x.example/novel/a/chapter-2";
    expect(findNextLink(doc('<a rel="next" href="/novel/a/chapter-3">→</a>'), base)).toBe("https://x.example/novel/a/chapter-3");
    expect(findNextLink(doc('<a href="/novel/a/chapter-1">Previous Chapter</a><a href="/novel/a/chapter-3#top">Next Chapter</a>'), base)).toBe("https://x.example/novel/a/chapter-3");
    expect(findNextLink(doc('<a class="btn next-chap" href="/novel/a/chapter-3">»</a>'), base)).toBe("https://x.example/novel/a/chapter-3");
    expect(findNextLink(doc('<a href="/novel/a/chapter-3">Следующая глава</a>'), base)).toBe("https://x.example/novel/a/chapter-3");
    expect(findNextLink(doc('<a href="/novel/a/chapter-1">Previous</a>'), base)).toBeNull();
  });
});

describe("saved page (.mht from Chrome)", () => {
  test("decodes the html part as UTF-8, skipping the preamble", () => {
    const m = decodeMhtml(readFileSync("tests/fixtures/extract/chrome-page.mht"));
    expect(m.url).toBe("https://inkwell.example/novel/the-glass-heron/chapter-14");
    const r = extractFromDocument(parseHtml(m.html), { url: m.url });
    const text = r.paragraphs.join("\n");
    expect(text).toContain("“They burned blue again,” Tobin said — and");
    expect(text).not.toMatch(/â|Ã/);
  });
});

describe("pasted text", () => {
  test("menus and comments are cut at the edges only", () => {
    const r = chapterFromPastedText(fx("pasted.txt"));
    expect(r.chapterTitle).toBe("Chapter 13: Cloves and Lamp Oil");
    const text = r.paragraphs.join("\n");
    expect(text).not.toMatch(/^Next Chapter$/m);
    expect(text).not.toMatch(/Comments \(/);
    expect(r.paragraphs.length).toBeGreaterThan(5);
  });

  test("a short chapter ending with «Next Chapter» keeps its text", () => {
    // Регресс: строка навигации в конце короткой вставки срезала всю главу.
    const r = chapterFromPastedText(
      "Chapter 7: The Lantern Ferry\n\nMara stood at the rail.\n\n\"Sleep,\" Fen said.\n\nThe lantern went out.\n\nNext Chapter",
    );
    expect(r.chapterTitle).toBe("Chapter 7: The Lantern Ferry");
    expect(r.paragraphs).toEqual(["Mara stood at the rail.", "\"Sleep,\" Fen said.", "The lantern went out."]);
  });

  test("shared text that is just a link", () => {
    expect(sharedUrl("Chapter 12 — The Glass Heron https://inkwell.example/novel/the-glass-heron/chapter-12")).toBe(
      "https://inkwell.example/novel/the-glass-heron/chapter-12",
    );
    const long = "The ferry crossed the river at dawn while the gulls circled overhead and nobody on board said a word. ".repeat(3);
    expect(sharedUrl(`${long} https://x.example/page ${long}`)).toBeNull();
  });
});

describe("server fetch", () => {
  test("refuses internal addresses", () => {
    for (const u of ["http://localhost/a", "http://127.0.0.1/a", "http://10.1.2.3/a", "http://192.168.0.5/", "http://169.254.169.254/latest", "http://[::1]/", "file:///etc/passwd", "http://printer.local/"]) {
      expect(checkFetchUrl(u).ok).toBe(false);
    }
    expect(checkFetchUrl("https://inkwell.example/novel/a/chapter-1").ok).toBe(true);
  });

  test("challenge → site_blocked; chapter → ok", async () => {
    const respond = (status: number, html: string, headers: Record<string, string> = {}) =>
      (async () => new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } })) as unknown as typeof fetch;
    const blocked = await fetchChapter("https://inkwell.example/novel/a/chapter-1", { fetchImpl: respond(403, fx("challenge.html")) });
    expect(blocked).toMatchObject({ ok: false, code: "site_blocked" });
    const ok = await fetchChapter("https://inkwell.example/novel/the-glass-heron/chapter-12", { fetchImpl: respond(200, fx("chapter-normal.html")) });
    expect(ok.ok).toBe(true);
    const index = await fetchChapter("https://inkwell.example/novel/the-ninth-lock", { fetchImpl: respond(200, fx("toc.html")) });
    expect(index).toMatchObject({ ok: false, code: "not_chapter" });
  });
});

describe("site button bundle", () => {
  test("has placeholders and no require()", () => {
    expect(USERSCRIPT_BODY.length).toBeGreaterThan(1000);
    expect(USERSCRIPT_BODY).toContain("__TOLMACH_APP_ORIGIN__");
    expect(USERSCRIPT_BODY).toContain("__TOLMACH_IMPORT_TOKEN__");
    expect(USERSCRIPT_BODY).not.toMatch(/\brequire\(/);
  });
});
