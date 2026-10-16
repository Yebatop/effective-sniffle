// Сквозная проверка в браузере: вход → выбор модели → вставка главы → перевод → читалка.
// Запуск: приложение на :3000 с поддельным сервером модели; аргумент — папка для снимков.
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.argv[2] ?? ".";
const PASSWORD = process.env.APP_PASSWORD ?? "тест-пароль";
// Текст придуман для проверки.
const CHAPTER = `Chapter 7: The Lantern Ferry

Mara stood at the rail while the ferry pushed into the fog.

"You should sleep," Fen said, holding out a cup of tea.

"I will sleep when we reach the other shore," she answered.

The lantern at the bow flickered twice and went out.

Next Chapter`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
const step = (s) => console.log("•", s);

try {
  step("login");
  await page.goto(`${BASE}/`);
  await page.waitForURL(/\/login/);
  await shot("01-login");
  await page.fill('input[type="password"]', PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  step("after login: " + page.url());

  if (!/\/settings/.test(page.url())) await page.goto(`${BASE}/settings?first=1`);
  await page.waitForLoadState("networkidle");
  await shot("02-settings-first");
  await page.getByText("Sonnet 5.5", { exact: false }).first().click();
  await page.waitForTimeout(800);
  await shot("03-settings-chosen");

  step("add chapter");
  await page.goto(`${BASE}/add`);
  await page.waitForLoadState("networkidle");
  await page.locator("textarea").first().fill(CHAPTER);
  await page.waitForTimeout(500);
  await shot("04-add-pasted");
  // Предпросмотр может появиться сам или по кнопке.
  const previewBtn = page.getByRole("button", { name: /показать|дальше|проверить|предпросмотр/i });
  if (await previewBtn.count()) await previewBtn.first().click();
  await page.waitForTimeout(500);
  await shot("05-add-preview");
  await page.getByRole("button", { name: /^Перевести/ }).first().click();
  await page.waitForURL(/\/read\//, { timeout: 15000 });
  step("reader: " + page.url());

  step("wait for translation");
  const startBtn = page.getByRole("button", { name: /^Перевести/ });
  await page.waitForTimeout(1500);
  if (await startBtn.count()) await startBtn.first().click();
  await page.getByText(/RU: Mara stood at the rail/).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await shot("06-reader");
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(500);
  await shot("07-reader-end");

  step("library, status, spend");
  for (const [path, name] of [["/", "08-library"], ["/status", "09-status"], ["/spend", "10-spend"], ["/button", "11-button"]]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(700);
    await shot(name);
  }
  console.log("OK");
} catch (e) {
  console.log("FAILED:", e.message);
  await shot("99-failure").catch(() => {});
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("page errors:\n" + errors.slice(0, 10).join("\n"));
  await browser.close();
}
