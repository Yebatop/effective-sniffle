// Собирает кнопку для сайтов (userscript/main.ts) в строку lib/generated/userscript.ts.
// Маршрут /u/<ключ>/tolmach.user.js подставляет в неё адрес приложения и ключ.
// Заготовка: полноценную сборку пишет этап 1 (часть «снятие текста и кнопка»).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

mkdirSync("lib/generated", { recursive: true });
if (!existsSync("userscript/main.ts")) {
  writeFileSync("lib/generated/userscript.ts", 'export const USERSCRIPT_BODY = "";\nexport const USERSCRIPT_BUILT_AT = 0;\n');
  process.exit(0);
}
const esbuild = await import("esbuild");
const out = await esbuild.build({
  entryPoints: ["userscript/main.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2019",
  platform: "browser",
  minify: false,
  legalComments: "none",
});
const body = out.outputFiles[0].text;
// Время сборки — для версии скрипта: она должна только расти (см. lib/server/userscript-version.ts).
writeFileSync(
  "lib/generated/userscript.ts",
  "export const USERSCRIPT_BODY = " + JSON.stringify(body) + ";\nexport const USERSCRIPT_BUILT_AT = " + Date.now() + ";\n",
);
