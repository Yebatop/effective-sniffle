"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorText, getSettingsCached } from "@/lib/client/api";
import { chapterLabel, num, plural } from "@/lib/client/format";
import { latestRead, sortBooks } from "@/lib/client/library";
import type { BookListItem } from "@/lib/types";
import Cover from "../Cover";
import { ErrorNote, Loading } from "../bits";
import { Icon } from "../Icon";

/**
 * Библиотека: «Продолжить», книги, «Добавить главу».
 * Первый запуск без выбранной модели — сразу в настройки.
 */
export default function LibraryScreen() {
  const router = useRouter();
  const [books, setBooks] = useState<BookListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    getSettingsCached()
      .then((s) => {
        if (alive && !s.translateModel) router.replace("/settings?first=1");
      })
      .catch(() => undefined);
    api
      .books()
      .then((list) => alive && setBooks(sortBooks(Array.isArray(list) ? list : [])))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [router, reload]);

  const last = books ? latestRead(books) : null;

  return (
    <main className="page">
      <div className="page-head">
        <div className="label">Библиотека</div>
        <h1 className="display">Что читаем</h1>
      </div>

      {error && <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />}
      {!books && !error && <Loading />}

      {books && (
        <div className="stack-lg">
          {last && (
            <Link className="continue" href={`/read/${encodeURIComponent(last.chapterId)}`}>
              <div className="grow stack-sm" style={{ gap: 4 }}>
                <span className="label" style={{ color: "var(--accent-text)" }}>
                  Продолжить
                </span>
                <span className="book-title">{last.bookTitle}</span>
                <span className="small muted">{chapterLabel(last.number, last.chapterTitle)}</span>
              </div>
              <span aria-hidden="true" style={{ fontSize: 22, color: "var(--accent-text)" }}>
                →
              </span>
            </Link>
          )}

          <Link className="btn btn-primary btn-big btn-block add-big" href="/add">
            <Icon name="plus" size={20} />
            Добавить главу
          </Link>

          {books.length === 0 ? <EmptyLibrary /> : <BookList books={books} />}
        </div>
      )}
    </main>
  );
}

function BookList({ books }: { books: BookListItem[] }) {
  return (
    <section className="stack" aria-label="Книги">
      <h2 className="label">Книги</h2>
      <ul className="book-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {books.map((it) => (
          <li key={it.book.id} className="book-card">
            <Link className="book-card-main" href={`/book/${encodeURIComponent(it.book.id)}`}>
              <Cover title={it.book.title} seed={it.book.id} src={it.book.coverUrl} width={52} height={74} />
              <span className="grow stack-sm" style={{ gap: 4 }}>
                <span className="book-title">{it.book.title}</span>
                <span className="book-meta">
                  <span className="nums">
                    переведено {num(it.translated)} из {num(it.chapters)}{" "}
                    {plural(it.chapters, "главы", "глав", "глав")}
                  </span>
                  {it.nextReady && (
                    <span className="row" style={{ gap: 6 }}>
                      <span className="dot" aria-hidden="true" />
                      следующая готова
                    </span>
                  )}
                </span>
                {it.lastRead && (
                  <span className="tiny dim">
                    остановились: {chapterLabel(it.lastRead.number, it.lastRead.chapterTitle)}
                  </span>
                )}
              </span>
            </Link>
            {it.lastRead && (
              <Link
                className="icon-btn"
                style={{ alignSelf: "center" }}
                href={`/read/${encodeURIComponent(it.lastRead.chapterId)}`}
                aria-label={`Читать «${it.book.title}» с места, где остановились`}
              >
                <span aria-hidden="true" style={{ fontSize: 20 }}>
                  →
                </span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyLibrary() {
  return (
    <section className="card stack" aria-label="Как добавить первую главу">
      <h2 className="display">Пока пусто</h2>
      <p className="p">Главы попадают сюда тремя способами — выберите удобный:</p>
      <div className="ways">
        <div className="way">
          <span className="way-mark" aria-hidden="true">
            Т
          </span>
          <div className="stack-sm" style={{ gap: 2 }}>
            <strong>Кнопка «Т» на сайте с главой</strong>
            <span className="small muted">
              Самый удобный способ: открываете главу на сайте, нажимаете кнопку в углу — глава здесь.{" "}
              <Link href="/button">Как поставить кнопку</Link>
            </span>
          </div>
        </div>
        <div className="way">
          <span className="way-mark" aria-hidden="true">
            <Icon name="share" size={18} />
          </span>
          <div className="stack-sm" style={{ gap: 2 }}>
            <strong>«Поделиться» → «Толмач»</strong>
            <span className="small muted">
              На телефоне: в меню браузера на странице главы нажмите «Поделиться» и выберите Толмач. Для этого
              Толмач нужно один раз добавить на главный экран.
            </span>
          </div>
        </div>
        <div className="way">
          <span className="way-mark" aria-hidden="true">
            <Icon name="text" size={18} />
          </span>
          <div className="stack-sm" style={{ gap: 2 }}>
            <strong>Вставить текст</strong>
            <span className="small muted">
              Выделите текст главы на сайте, скопируйте и вставьте на странице{" "}
              <Link href="/add">«Добавить главу»</Link>. Там же можно открыть сохранённую страницу или ссылку.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
