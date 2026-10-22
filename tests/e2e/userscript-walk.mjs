// Кнопка «Т» на сайте готового перевода: «Готовый перевод: эту и все следующие»
// обходит главы в этой же вкладке и шлёт их в Толмач (POST /api/reference/import).
// Два сайта: с обычными ссылками «Следующая глава» (переход с перезагрузкой)
// и сайт-приложение с кнопкой «Далее» без адреса. Текст глав рисуется скриптом
// с задержкой — как у сайтов-приложений.
// Запуск: node tests/e2e/userscript-walk.mjs (после npm run build или npm test).
// Идёт около минуты: между главами кнопка ждёт 3–5 с.
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
  "Караван пересёк солончак ещё до рассвета, и каждое колесо оставляло бледный след, который ветер стирал за час.",
  "Одран трижды пересчитал бочки с водой, потому что цифры упрямо не сходились с обещаниями гильдии торговцев.",
  "Никто не говорил о пропавшем разведчике, хотя все украдкой поглядывали на пустое седло, когда колонна замедлялась.",
  "К полудню жара превратила горизонт в дрожащее стекло, и старый картограф начал бормотать названия колодцев.",
  "Когда башня наконец поднялась из марева, она оказалась меньше, чем в рассказах, и куда более усталой.",
  "Лиса прижала ладонь к тёплому камню и почувствовала медленное сердцебиение машины, спавшей глубоко внизу.",
];
const LAST = 3;

function chapterBody(n, nav) {
  const paras = [];
  for (let i = 0; i < 9; i++) paras.push(`<p>${SENTENCES[(i + n) % SENTENCES.length]} ${SENTENCES[(i + n + 3) % SENTENCES.length]}</p>`);
  return `<article><h1>Глава ${n}. Соляной путь</h1>${paras.join("")}</article>${nav}`;
}

// /ru/ch-N — ссылки; /spa/ch-N — кнопка «Далее» без адреса, переход без перезагрузки.
function page(path) {
  const spa = path.startsWith("/spa/");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Соляной путь</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header>Читалка ранобэ</header><main id="app"><p>Загрузка…</p></main><script>
const SENTENCES = ${JSON.stringify(SENTENCES)};
const BODY = ${chapterBody.toString()};
const SPA = ${spa};
function render() {
  const n = Number((location.pathname.match(/ch-(\\d+)/) || [])[1] || 1);
  const nav = n >= ${LAST} ? "" : SPA
    ? '<nav><button type="button" id="next">Далее</button></nav>'
    : '<nav><a href="/ru/ch-' + (n + 1) + '">Следующая глава</a></nav>';
  document.getElementById("app").innerHTML = BODY(n, nav);
  const btn = document.getElementById("next");
  if (btn) btn.addEventListener("click", () => {
    history.pushState(null, "", "/spa/ch-" + (n + 1));
    document.getElementById("app").innerHTML = "<p>Загрузка…</p>";
    setTimeout(render, 800);
  });
}
setTimeout(render, 1500);
</script></body></html>`;
}

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(req.url || "/"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Менеджер понарошку: хранилище — localStorage сайта (переживает переходы),
// запуск — один раз на документ. Отправленные главы уходят в тест.
const INIT = `(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return attach.call(this, Object.assign({}, o, { mode: "open" })); };
  window.__marker = window.__marker || 0;
  window.GM_setValue = (k, v) => localStorage.setItem("gm:" + k, JSON.stringify(v));
  window.GM_getValue = (k, d) => { const v = localStorage.getItem("gm:" + k); return v === null ? d : JSON.parse(v); };
  window.GM_openInTab = () => {};
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (d) => setTimeout(() => {
    if (d.method === "GET" && /\\/api\\/reference\\/books$/.test(d.url)) {
      d.onload({ status: 200, responseText: JSON.stringify({ books: [{ id: "book-1", title: "Salt Road", chapters: 3, refChapters: 0 }] }), responseHeaders: "", finalUrl: d.url });
      return;
    }
    if (d.method === "POST" && /\\/api\\/reference\\/import$/.test(d.url)) {
      const req = JSON.parse(d.data);
      const ch = req.chapters[0];
      const m = /Глава (\\d+)/.exec(ch.chapterTitle || "");
      const number = m ? Number(m[1]) : ch.expectedNumber;
      window.__recordImport({ bookId: req.bookId, number, url: ch.url, paragraphs: ch.paragraphs.length });
      d.onload({ status: 200, responseText: JSON.stringify({ items: [{ number, created: true, updated: false }] }), responseHeaders: "", finalUrl: d.url });
      return;
    }
    d.onerror({});
  }, 0);
  const run = () => setTimeout(() => (0, eval)(${JSON.stringify(body)}), 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const imports = [];
await ctx.exposeFunction("__recordImport", (x) => imports.push(x));
await ctx.addInitScript(INIT);
const page1 = await ctx.newPage();
const errors = [];
page1.on("pageerror", (e) => errors.push(String(e)));

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
  if (!ok) failed++;
};
const waitFor = async (fn, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
};
const hasButton = () => page1.evaluate(() => Boolean(document.querySelector("tolmach-button")));
const tap = () => page1.locator("tolmach-button .btn").click();
const walkState = () => page1.evaluate(() => localStorage.getItem("gm:tolmach:walk:" + location.host));

try {
  await page1.goto(`${BASE}/ru/ch-1`);
  check("русская глава дорисовалась — кнопка есть", await waitFor(hasButton, 8000));
  await tap();
  const menu = await page1.locator("tolmach-button .menu").innerText();
  check("в меню — готовый перевод, а не «Перевести»", /Готовый перевод: эту и все следующие/.test(menu) && !/Перевести эту главу/.test(menu), menu.replace(/\s+/g, " "));
  await page1.getByText("Готовый перевод: эту и все следующие").click();
  await page1.getByText("Salt Road").click();
  check(
    "обходит главы по ссылкам и отправляет каждую",
    await waitFor(() => imports.length >= LAST, 45000),
    JSON.stringify(imports.map((i) => i.number)),
  );
  check("номера 1, 2, 3 в выбранную книгу", JSON.stringify(imports.map((i) => [i.bookId, i.number])) === JSON.stringify([["book-1", 1], ["book-1", 2], ["book-1", 3]]));
  check("в конце обход закончен", await waitFor(async () => !(await walkState()) || (await walkState()) === '""', 5000));
  check(
    "книга для этой книги сайта запомнена",
    await page1.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("gm:tolmach:refbook:") && localStorage.getItem(k) !== '""')),
  );

  imports.length = 0;
  await page1.goto(`${BASE}/spa/ch-1`);
  await page1.evaluate(() => (window.__marker = 1));
  check("сайт-приложение: кнопка есть", await waitFor(hasButton, 8000));
  await tap();
  await page1.getByText("Готовый перевод: эту и следующие 10").click();
  // Другая книга сайта (другой путь) — книгу Толмача спрашивают заново.
  await page1.getByText("Salt Road").click();
  check(
    "«Далее» без адреса — обход идёт без перезагрузки",
    await waitFor(() => imports.length >= LAST, 45000),
    JSON.stringify(imports.map((i) => i.number)),
  );
  check("та же вкладка, тот же документ", await page1.evaluate(() => window.__marker === 1));
  check("номера 1, 2, 3", JSON.stringify(imports.map((i) => i.number)) === "[1,2,3]");

  imports.length = 0;
  await page1.goto(`${BASE}/ru/ch-1`);
  await waitFor(hasButton, 8000);
  await tap();
  await page1.getByText("Готовый перевод: эту и все следующие").click();
  await page1.getByText("Salt Road").click();
  await waitFor(() => imports.length >= 1, 8000);
  // Вторая вкладка того же сайта посреди обхода: сама ничего не берёт и никуда не уходит.
  const page2 = await ctx.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  await page2.goto(`${BASE}/ru/ch-2`);
  await page2.waitForTimeout(6000);
  const fromTab2 = imports.filter((i) => /ch-2$/.test(i.url)).length;
  check("вторая вкладка обход не перехватывает", /\/ru\/ch-2$/.test(page2.url()) && fromTab2 <= 1, page2.url() + " / " + fromTab2);
  await page2.locator("tolmach-button .btn").click();
  const menu2 = await page2.locator("tolmach-button .menu").innerText();
  check("…а её меню знает про идущий обход", /Обход «Salt Road» идёт в другой вкладке/.test(menu2) && !/Продолжить обход|Забыть/.test(menu2), menu2.replace(/\s+/g, " "));
  await page2.getByText(/идёт в другой вкладке/).click();
  await page2.waitForTimeout(500);
  const toast2 = await page2.locator("tolmach-button .toast").innerText();
  check("…и не даёт вести его в двух вкладках сразу", /Остановите его там/.test(toast2), toast2);
  await page2.close();
  await tap();
  await page1.getByText("Остановить").click();
  await page1.waitForTimeout(6000);
  const stoppedAt = page1.url();
  const count = imports.length;
  await page1.waitForTimeout(6000);
  check("«Остановить» — дальше не идёт", imports.length === count && page1.url() === stoppedAt, stoppedAt + " / " + count);

  // Обход оборвался (вкладку закрыли): открытая потом глава сама не продолжает его, а меню предлагает.
  imports.length = 0;
  await page1.evaluate(() => {
    const raw = JSON.stringify({
      v: 2, walkId: "other-tab", host: location.host, bookId: "book-1", bookTitle: "Salt Road", total: -1, done: 2, lastNumber: 2,
      lastSig: null, skipped: 0, seen: [], navigatedAt: Date.now(), navToken: "stale", startedAt: Date.now(), updatedAt: Date.now(), beat: Date.now() - 60000,
    });
    localStorage.setItem("gm:tolmach:walk:" + location.host, JSON.stringify(raw));
  });
  await page1.goto(`${BASE}/ru/ch-3`);
  await page1.waitForTimeout(7000);
  check("брошенный обход сам не продолжается в новой вкладке", imports.length === 0 && /\/ru\/ch-3$/.test(page1.url()), String(imports.length));
  await tap();
  await page1.getByText(/Продолжить обход «Salt Road»/).click();
  check("«Продолжить обход» из меню берёт эту главу", await waitFor(() => imports.length >= 1, 10000), JSON.stringify(imports.map((i) => i.number)));

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
