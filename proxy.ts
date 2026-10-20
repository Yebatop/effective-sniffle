/**
 * Вход в приложение: всё, кроме открытых адресов, — только с cookie входа.
 * Страницы без входа уводят на /login, API отвечает 401.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, appPassword, verifySession } from "./lib/server/auth";

// Открыты без пароля: вход, манифест и служебный файл (иначе телефон не
// установит приложение), кнопка для сайтов (у неё свой ключ), эстафета
// исполнителя (свой секрет), крон, отчёт по секретной ссылке, версия.
// Приём готового перевода от кнопки — тоже по ключу кнопки.
const PUBLIC: RegExp[] = [
  /^\/login\/?$/,
  /^\/api\/login$/,
  /^\/api\/version$/,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/icons\//,
  /^\/(favicon\.ico|icon[^/]*|apple-icon[^/]*)$/,
  /^\/u\/[^/]+\/tolmach\.user\.js$/,
  /^\/api\/import$/,
  /^\/api\/reference\/(import|books)$/,
  /^\/api\/jobs\/run$/,
  /^\/api\/glossary\/run$/,
  /^\/api\/cron$/,
];
const PUBLIC_GET: RegExp[] = [/^\/api\/report\/[^/]+$/];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  if (req.method === "GET" && PUBLIC_GET.some((re) => re.test(pathname))) return NextResponse.next();

  const password = appPassword();
  const ok = password ? await verifySession(password, req.cookies.get(SESSION_COOKIE)?.value) : false;
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "Нужно войти." }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
