"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, errorText, getSettingsCached, importOne } from "@/lib/client/api";
import { estimateRub, modelLabel, num, plural, truncate } from "@/lib/client/format";
import { describeJobProblem } from "@/lib/client/problems";
import type { BookListItem, ChapterSource, ExtractedChapter, ImportResponseItem, Settings } from "@/lib/types";
import { ErrorNote } from "./bits";

const AUTO = "__auto__";
const NEW = "__new__";

/**
 * Общий предпросмотр перед тратой денег — для «Добавить» и «Поделиться»:
 * название (можно поправить), сколько слов, начало и конец, примерная цена,
 * в какую книгу положить, предупреждения → «Перевести» или «Только сохранить».
 */
export default function ChapterPreview({
  chapter,
  source,
  onCancel,
}: {
  chapter: ExtractedChapter;
  source: ChapterSource;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [books, setBooks] = useState<BookListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState(chapter.chapterTitle || "");
  const [choice, setChoice] = useState<string>(chapter.url ? AUTO : "");
  const [newTitle, setNewTitle] = useState(chapter.bookTitle || "");
  const [busy, setBusy] = useState<null | "translate" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ImportResponseItem | null>(null);
  const [translateProblem, setTranslateProblem] = useState<{ item: ImportResponseItem; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getSettingsCached()
      .then((s) => alive && setSettings(s))
      .catch((e) => alive && setLoadError(errorText(e)));
    api
      .books()
      .then((list) => {
        if (!alive) return;
        setBooks(list);
        setChoice((cur) => {
          if (cur) return cur;
          // По умолчанию — книга, которую читали последней.
          const recent = list
            .filter((b) => b.lastRead)
            .sort((a, b) => (b.lastRead!.at > a.lastRead!.at ? 1 : -1))[0];
          if (recent) return recent.book.id;
          return list.length > 0 ? list[0].book.id : NEW;
        });
      })
      .catch((e) => {
        if (!alive) return;
        setBooks([]);
        setChoice((cur) => cur || NEW);
        setLoadError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const paragraphs = chapter.paragraphs.filter((p) => p.trim());
  const first = paragraphs[0] ?? "";
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : "";
  const words = chapter.words || 0;
  const price = useMemo(
    () => (settings ? estimateRub(settings.translateModel, words, settings.usdRub, settings.translateEffort, settings.extractModel) : null),
    [settings, words],
  );
  const empty = paragraphs.length === 0;

  async function doImport(): Promise<ImportResponseItem> {
    const ch: ExtractedChapter = {
      ...chapter,
      chapterTitle: title.trim() || chapter.chapterTitle,
      bookTitle: choice === NEW ? newTitle.trim() || chapter.bookTitle : chapter.bookTitle,
    };
    const bookId = choice && choice !== AUTO && choice !== NEW ? choice : undefined;
    return importOne(ch, source, bookId);
  }

  async function translate() {
    if (!settings?.translateModel) {
      router.push("/settings?first=1");
      return;
    }
    setBusy("translate");
    setError(null);
    try {
      const item = await doImport();
      if (item.hasTranslation) {
        router.push(`/read/${encodeURIComponent(item.chapterId)}`);
        return;
      }
      const r = await api.translate(item.chapterId, { model: settings.translateModel });
      if (r.ok) {
        router.push(`/read/${encodeURIComponent(item.chapterId)}`);
        return;
      }
      const p = describeJobProblem({ state: "failed", errorCode: r.code, errorMessage: r.message });
      setTranslateProblem({ item, text: r.message || `${p.title}. ${p.text}` });
      setBusy(null);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  }

  async function saveOnly() {
    setBusy("save");
    setError(null);
    try {
      setSaved(await doImport());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (saved) {
    return (
      <div className="card stack">
        <h2 className="display">{saved.created ? "Глава сохранена" : "Эта глава уже была в библиотеке"}</h2>
        <p className="p">
          «{saved.title}» — {num(saved.words)} {plural(saved.words, "слово", "слова", "слов")}.
          {saved.hasTranslation ? " Перевод уже есть." : " Перевести можно в любой момент, открыв её."}
        </p>
        <div className="row">
          <Link className="btn btn-primary" href={`/read/${encodeURIComponent(saved.chapterId)}`}>
            Открыть главу
          </Link>
          <Link className="btn" href={`/book/${encodeURIComponent(saved.bookId)}`}>
            К книге
          </Link>
          {onCancel && (
            <button type="button" className="btn btn-quiet" onClick={onCancel}>
              Добавить ещё
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="card stack" aria-label="Что нашлось">
      <div className="label">Что нашлось</div>

      <label className="field">
        <span>Название главы</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      </label>

      <div className="facts">
        <span>
          <strong className="nums">{num(words)}</strong> {plural(words, "слово", "слова", "слов")}
        </span>
        {price && settings?.translateModel && (
          <span>
            перевод <strong>{price}</strong> · {modelLabel(settings.translateModel)}
          </span>
        )}
        {chapter.url && <span className="nowrap">{hostOf(chapter.url)}</span>}
      </div>

      {chapter.looksLocked && (
        <div className="notice notice-warn">
          <p>Похоже, глава закрыта на сайте — переведётся только то, что видно.</p>
        </div>
      )}
      {chapter.looksLikeIndex && (
        <div className="notice notice-warn">
          <p>Похоже на оглавление, а не главу.</p>
        </div>
      )}
      {empty && (
        <div className="notice notice-error">
          <p>Текста главы не нашлось. Попробуйте другой способ: кнопку «Т» на сайте или вставку текста.</p>
        </div>
      )}

      {first && (
        <div className="stack-sm">
          <span className="field-label">Начало</span>
          <blockquote className="snippet">{truncate(first, 280)}</blockquote>
        </div>
      )}
      {last && (
        <div className="stack-sm">
          <span className="field-label">Конец</span>
          <blockquote className="snippet">{truncate(last, 280)}</blockquote>
        </div>
      )}

      <label className="field">
        <span>В какую книгу</span>
        <select
          className="select"
          value={choice}
          onChange={(e) => setChoice(e.currentTarget.value)}
          disabled={books === null}
        >
          {books === null && <option value="">Загружаю список книг…</option>}
          {chapter.url && <option value={AUTO}>Определить по адресу главы</option>}
          {(books ?? []).map((b) => (
            <option key={b.book.id} value={b.book.id}>
              {b.book.title}
            </option>
          ))}
          <option value={NEW}>Новая книга</option>
        </select>
      </label>
      {choice === NEW && (
        <label className="field">
          <span>Название новой книги — можно оставить пустым и задать потом</span>
          <input
            className="input"
            value={newTitle}
            placeholder="Например, «Путь Пепельного Клинка»"
            onChange={(e) => setNewTitle(e.currentTarget.value)}
          />
        </label>
      )}

      {loadError && <p className="hint">{loadError}</p>}
      {error && <ErrorNote text={error} />}
      {translateProblem && (
        <div className="notice notice-error" role="alert">
          <p>Глава сохранена, но перевод не начался: {translateProblem.text}</p>
          <p className="row" style={{ marginTop: 8 }}>
            <Link className="btn btn-small" href={`/read/${encodeURIComponent(translateProblem.item.chapterId)}`}>
              Открыть главу
            </Link>
            <Link className="btn btn-small" href="/settings">
              Настройки
            </Link>
          </p>
        </div>
      )}

      {settings && !settings.translateModel && (
        <div className="notice">
          <p>
            Сначала выберите модель для перевода — <Link href="/settings?first=1">в настройках</Link>.
          </p>
        </div>
      )}

      <div className="stack-sm">
        <button
          type="button"
          className="btn btn-primary btn-big btn-block"
          onClick={translate}
          disabled={!!busy || empty || books === null}
        >
          {busy === "translate" ? "Сохраняю и запускаю…" : price ? `Перевести · ${price}` : "Перевести"}
        </button>
        <div className="row">
          <button
            type="button"
            className="btn grow"
            onClick={saveOnly}
            disabled={!!busy || empty || books === null}
          >
            {busy === "save" ? "Сохраняю…" : "Только сохранить"}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={!!busy}>
              Назад
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
