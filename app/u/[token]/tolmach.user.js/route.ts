/**
 * Кнопка для сайтов: скрипт с вшитыми адресом приложения и ключом.
 * Менеджер скриптов (Violentmonkey, Tampermonkey) сам предложит установку,
 * увидев .user.js, и будет обновлять скрипт по этому же адресу.
 */

import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import { USERSCRIPT_BODY } from "@/lib/generated/userscript";
import { importTokenValid } from "@/lib/server/access";
import { originOf } from "@/lib/server/http";

// Версия меняется вместе с содержимым — менеджер скриптов увидит обновление.
const VERSION = `1.0.${parseInt(createHash("sha256").update(USERSCRIPT_BODY).digest("hex").slice(0, 7), 16)}`;

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await importTokenValid(token).catch(() => false))) {
    return new Response("// Ключ кнопки устарел. Откройте Толмач → «Кнопка для сайтов» и установите кнопку заново.\n", {
      status: 404,
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const origin = originOf(req);
  const host = new URL(origin).host;
  const self = `${origin}/u/${token}/tolmach.user.js`;
  const header = [
    "// ==UserScript==",
    "// @name         Толмач — кнопка перевода",
    "// @namespace    tolmach",
    `// @version      ${VERSION}`,
    "// @description  Кнопка «Т» на страницах глав: отправить главу в Толмач и читать перевод",
    "// @match        *://*/*",
    "// @noframes",
    "// @run-at       document-idle",
    "// @grant        GM_xmlhttpRequest",
    "// @grant        GM_setValue",
    "// @grant        GM_getValue",
    "// @grant        GM_openInTab",
    `// @connect      ${host}`,
    "// @connect      *",
    `// @updateURL    ${self}`,
    `// @downloadURL  ${self}`,
    "// ==/UserScript==",
    "",
  ].join("\n");
  const body = USERSCRIPT_BODY.split("__TOLMACH_APP_ORIGIN__").join(origin).split("__TOLMACH_IMPORT_TOKEN__").join(token);
  return new Response(header + body, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}
