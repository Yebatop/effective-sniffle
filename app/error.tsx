"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Экран на случай, если страница сломалась целиком. Пишем по-человечески. */
export default function ErrorScreen({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest =
    error && typeof error === "object" && typeof (error as { digest?: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : null;
  return (
    <main className="page page-narrow">
      <div className="stack">
        <h1 className="display">Страница не открылась</h1>
        <p className="p">
          Что-то сломалось при показе этой страницы. Попробуйте ещё раз; если повторяется — обновите страницу
          или загляните в «Проверку» в настройках.
        </p>
        {digest && <p className="hint">Код для разбора: {digest}</p>}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => retry()}>
            Попробовать ещё раз
          </button>
          <Link className="btn" href="/">
            В библиотеку
          </Link>
          <Link className="btn btn-quiet" href="/status">
            Проверка
          </Link>
        </div>
      </div>
    </main>
  );
}
