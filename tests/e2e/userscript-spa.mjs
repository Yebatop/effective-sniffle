// Кнопка «Т» на сайтах-приложениях, которые листают главы без перезагрузки
// (Next.js и подобные): менеджер скриптов запускает кнопку один раз на
// документ, дальше она сама должна замечать смену адреса.
// Запуск: node tests/e2e/userscript-spa.mjs (после npm run build или npm test —
// нужна собранная lib/generated/userscript.ts). Браузер — CHROMIUM или /opt/pw-browsers/chromium.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
const APP = "https://tolmach.example";

const generated = readFileSync(new URL("../../lib/generated/userscript.ts", import.meta.url), "utf8");
const body = JSON.parse(generated.slice(generated.indexOf("=") + 1).trim().replace(/;$/, ""))
  .split("__TOLMACH_APP_ORIGIN__")
  .join(APP)
  .split("__TOLMACH_IMPORT_TOKEN__")
  .join("test-token");

// Текст придуман для проверки.
const SENTENCES = [
  "The caravan crossed the salt flats before dawn, and every wheel left a pale scar that the wind erased within the hour.",
  "Odran counted the water barrels twice, then a third time, because the numbers refused to agree with the promises the guild had made.",
  "Nobody spoke about the missing scout, although each of them glanced at the empty saddle whenever the column slowed for a turn.",
  "By noon the heat had turned the horizon into a trembling sheet of glass, and the old mapmaker began muttering the names of wells.",
  "When the tower finally rose out of the haze, it looked smaller than the stories, and far more tired than anyone had expected.",
  "Lysa pressed her palm against the warm stone and felt, faintly, the slow heartbeat of the machine that still slept beneath it.",
];
function chapterHtml(n) {
  const paras = [];
  for (let i = 0; i < 9; i++) paras.push(`<p>${SENTENCES[(i + n) % SENTENCES.length]} ${SENTENCES[(i + n + 2) % SENTENCES.length]}</p>`);
  return `<article><h1>Chapter ${n}: The Salt Road</h1>${paras.join("")}
    <nav><a data-spa href="/book/ch-${n - 1}">Prev</a> <a data-spa href="/book/ch-${n + 1}">Next</a></nav></article>`;
}
function indexHtml() {
  const items = [];
  for (let n = 1; n <= 12; n++) items.push(`<li><a data-spa href="/book/ch-${n}">Chapter ${n}</a></li>`);
  return `<h1>The Salt Road</h1><p>A short blurb.</p><ul>${items.join("")}</ul>`;
}

// Одна оболочка на все адреса: содержимое рисует скрипт страницы, как у SPA.
const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Salt Road</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header>Site header</header><main id="app"></main><script>
const CH = ${chapterHtml.toString()};
const SENTENCES = ${JSON.stringify(SENTENCES)};
const IDX = ${indexHtml.toString()};
window.__lateMs = 0;
function render() {
  const m = location.pathname.match(/ch-(\\d+)/);
  const html = m ? CH(Number(m[1])) : IDX();
  const app = document.getElementById("app");
  app.innerHTML = "<p>Loading…</p>";
  const put = () => { app.innerHTML = html; document.title = m ? "Chapter " + m[1] : "Salt Road"; };
  if (window.__lateMs) setTimeout(put, window.__lateMs); else put();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[data-spa]");
  if (!a) return;
  e.preventDefault();
  history.pushState(null, "", a.getAttribute("href"));
  render();
});
window.addEventListener("popstate", render);
render();
</script></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(SHELL);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Менеджер скриптов понарошку: GM_* и запуск один раз на документ после
// DOMContentLoaded. Тень открыта, чтобы тест мог нажимать кнопки внутри.
const INIT = `(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return attach.call(this, Object.assign({}, o, { mode: "open" })); };
  const store = {};
  window.__imports = []; window.__opened = []; window.__menu = [];
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_openInTab = (url) => { window.__opened.push(url); };
  window.GM_registerMenuCommand = (caption, fn) => { window.__menu.push({ caption, fn }); };
  window.GM_xmlhttpRequest = (d) => setTimeout(() => {
    if (d.method === "POST" && /\\/api\\/import$/.test(d.url)) {
      window.__imports.push(JSON.parse(d.data));
      d.onload({ status: 200, responseText: JSON.stringify({ items: [{ chapterId: "c" + window.__imports.length, created: true }] }), responseHeaders: "", finalUrl: d.url });
    } else d.onerror({});
  }, 0);
  const run = () => setTimeout(() => (0, eval)(${JSON.stringify(body)}), 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.addInitScript(INIT);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
  if (!ok) failed++;
};
const hasButton = () => page.evaluate(() => {
  const h = document.querySelector("tolmach-button");
  return Boolean(h && h.isConnected);
});
const waitButton = async (want, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await hasButton()) === want) return true;
    await page.waitForTimeout(200);
  }
  return (await hasButton()) === want;
};
const sameDoc = () => page.evaluate(() => window.__marker === 1);
const spaGo = async (href) => {
  await page.evaluate((h) => {
    history.pushState(null, "", h);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, href);
};

try {
  await page.goto(`${BASE}/book/ch-3`);
  check("прямое открытие главы — кнопка есть", await waitButton(true, 4000));

  await page.goto(`${BASE}/`);
  await page.evaluate(() => (window.__marker = 1));
  check("оглавление — кнопки нет", await waitButton(false, 3000));
  check("в меню дополнения есть «Показать кнопку»", await page.evaluate(() => window.__menu.some((m) => /Показать/.test(m.caption))));

  await page.click('a[href="/book/ch-1"]');
  check("переход в главу без перезагрузки — кнопка появилась", await waitButton(true, 4000));
  check("документ тот же (это был переход без перезагрузки)", await sameDoc());

  await page.click('a[href="/book/ch-2"]');
  await page.waitForTimeout(500);
  await page.locator("tolmach-button .btn").click();
  await page.getByText("Перевести эту главу").click();
  await page.waitForFunction(() => window.__imports.length === 1, null, { timeout: 5000 });
  const sent = await page.evaluate(() => window.__imports[0].chapters[0]);
  check(
    "«Перевести» после «Next» берёт новую главу",
    /ch-2$/.test(sent.url) && /Chapter 2\b/.test(sent.chapterTitle) && /ch-3$/.test(sent.nextUrl || ""),
    [sent.url, sent.chapterTitle, sent.nextUrl].join(" / "),
  );
  check("и открывает её в Толмаче", await page.evaluate(() => window.__opened.length === 1));

  await spaGo("/");
  check("вернулись в оглавление — кнопка пока остаётся", await hasButton());
  check("…и уходит через несколько секунд", await waitButton(false, 9000));

  await page.evaluate(() => (window.__lateMs = 7000));
  await page.click('a[href="/book/ch-5"]');
  check("глава дорисовалась через 7 с — кнопки сначала нет", await waitButton(false, 2000));
  check("…и она появляется, когда текст пришёл", await waitButton(true, 9000));
  await page.evaluate(() => (window.__lateMs = 0));

  await page.evaluate(() => document.body.removeChild(document.querySelector("tolmach-button")));
  check("сайт выкинул кнопку при перерисовке — она вернулась", await waitButton(true, 3000));

  await page.locator("tolmach-button .btn").click();
  await page.getByText("Закрыть").click();
  check("«Закрыть» убирает кнопку", await waitButton(false, 1000));
  await page.evaluate(() => document.getElementById("app").appendChild(document.createElement("div")));
  check("…и на этой главе она сама не возвращается", await waitButton(false, 3000));
  await page.click('a[href="/book/ch-6"]');
  check("следующая глава — кнопка снова есть", await waitButton(true, 4000));

  await page.click('a[href="/book/ch-7"]');
  await page.locator("tolmach-button .btn").click();
  await page.getByText("Закрыть").click();
  await page.evaluate(() => window.__menu.find((m) => /Показать/.test(m.caption)).fn());
  check("меню дополнения → «Показать кнопку» возвращает её", await waitButton(true, 1000));

  check("без ошибок на странице", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.log(`\nНе прошло проверок: ${failed}`);
  process.exit(1);
}
console.log("\nВсе проверки прошли.");
