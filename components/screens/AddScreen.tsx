"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/client/api";
import { FILE_ACCEPT, chapterFromFile } from "@/lib/client/extract";
import { SITE_BLOCKED_HELP } from "@/lib/client/problems";
import { chapterFromPastedText } from "@/lib/extract/text";
import type { ChapterSource, ExtractedChapter } from "@/lib/types";
import ChapterPreview from "../ChapterPreview";
import { ErrorNote } from "../bits";
import { Icon } from "../Icon";

type Tab = "text" | "file" | "link";

/**
 * «Добавить главу»: три способа, один предпросмотр.
 * Текст и файл разбираются прямо в браузере; ссылку пробует открыть сервер.
 */
export default function AddScreen() {
  const [tab, setTab] = useState<Tab>("text");
  const [found, setFound] = useState<{ chapter: ExtractedChapter; source: ChapterSource } | null>(null);

  if (found) {
    return (
      <main className="page">
        <div className="page-head">
          <h1 className="display">Проверьте главу</h1>
          <p className="p">Так она уйдёт в перевод. Если что-то не то — вернитесь и попробуйте другой способ.</p>
        </div>
        <ChapterPreview chapter={found.chapter} source={found.source} onCancel={() => setFound(null)} />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="display">Добавить главу</h1>
        <p className="p">
          Удобнее всего — кнопкой «Т» прямо на сайте с главой (<Link href="/button">как поставить</Link>). Здесь —
          запасные способы.
        </p>
      </div>

      <div className="segments" role="tablist" aria-label="Способ добавить" style={{ marginBottom: 20 }}>
        <TabButton id="text" tab={tab} onPick={setTab} label="Текст" />
        <TabButton id="file" tab={tab} onPick={setTab} label="Файл" />
        <TabButton id="link" tab={tab} onPick={setTab} label="Ссылка" />
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "text" && <PasteTab onFound={(chapter) => setFound({ chapter, source: "paste" })} />}
        {tab === "file" && <FileTab onFound={(chapter) => setFound({ chapter, source: "file" })} />}
        {tab === "link" && <LinkTab onFound={(chapter) => setFound({ chapter, source: "server" })} />}
      </div>
    </main>
  );
}

function TabButton({ id, tab, onPick, label }: { id: Tab; tab: Tab; onPick: (t: Tab) => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`panel-${id}`}
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  );
}

function PasteTab({ onFound }: { onFound: (c: ExtractedChapter) => void }) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function go() {
    setError(null);
    try {
      const ch = chapterFromPastedText(text, { url: url.trim() || null });
      if (!ch.paragraphs.length) {
        setError("Текста не нашлось — вставьте главу целиком.");
        return;
      }
      onFound(ch);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="stack">
      <label className="field">
        <span>Текст главы</span>
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder="На сайте: выделить всё → скопировать → вставить сюда. Меню и комментарии Толмач срежет сам."
          rows={10}
        />
      </label>
      <label className="field">
        <span>Адрес главы — не обязательно</span>
        <input
          className="input"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          placeholder="https://…"
          autoComplete="off"
        />
        <span className="hint">По адресу Толмач поймёт, из какой книги глава, и найдёт следующую.</span>
      </label>
      {error && <ErrorNote text={error} />}
      <button type="button" className="btn btn-primary btn-big btn-block" onClick={go} disabled={!text.trim()}>
        Дальше
      </button>
    </div>
  );
}

function FileTab({ onFound }: { onFound: (c: ExtractedChapter) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await chapterFromFile(file);
      if (!ch.paragraphs.length) setError("В файле не нашлось текста главы.");
      else onFound(ch);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="stack">
      <p className="p">
        Сохранённая страница с главой: на телефоне — меню браузера → «Скачать страницу» (файл .mht), на компьютере —
        «Сохранить как» (.html). Файл разбирается здесь, на сервер уходит только текст.
      </p>
      <label className="btn btn-primary btn-big btn-block" style={{ position: "relative" }}>
        <Icon name="file" />
        {busy ? "Разбираю файл…" : "Выбрать файл"}
        <input
          ref={input}
          type="file"
          accept={FILE_ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => onFile(e.currentTarget.files && e.currentTarget.files[0])}
        />
      </label>
      <p className="hint">Подходят .mht, .mhtml, .html и .htm.</p>
      {error && <ErrorNote text={error} />}
    </div>
  );
}

function LinkTab({ onFound }: { onFound: (c: ExtractedChapter) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; blocked: boolean; url: string } | null>(null);

  async function go() {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.fetchUrl(u);
      if (r.ok) onFound(r.chapter);
      else setProblem({ text: r.message, blocked: r.code === "site_blocked", url: u });
    } catch (e) {
      setProblem({ text: errorText(e), blocked: false, url: u });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <label className="field">
        <span>Ссылка на главу</span>
        <input
          className="input"
          type="url"
          inputMode="url"
          required
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          placeholder="https://…"
          autoComplete="off"
        />
        <span className="hint">
          Сервер попробует открыть страницу сам. Многие сайты его не пускают — тогда поможет кнопка «Т».
        </span>
      </label>
      {problem && (
        <div className="notice notice-error" role="alert">
          <p>{problem.text}</p>
          {problem.blocked && (
            <>
              <p>{SITE_BLOCKED_HELP}</p>
              <p>
                <a href={problem.url} target="_blank" rel="noopener noreferrer">
                  Открыть главу на сайте
                </a>{" "}
                · <Link href="/button">как поставить кнопку «Т»</Link>
              </p>
            </>
          )}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-big btn-block" disabled={busy || !url.trim()}>
        {busy ? "Открываю страницу…" : "Открыть"}
      </button>
    </form>
  );
}
