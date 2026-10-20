"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, errorText, getSettingsCached, type BookDetail, type BookPatch } from "@/lib/client/api";
import { num, plural, rub } from "@/lib/client/format";
import type { Book, Gender, RefSummary, Register } from "@/lib/types";
import Cover from "../Cover";
import { BackLink, ErrorNote, Loading } from "../bits";

const REGISTERS: Array<{ id: Register; title: string; sub: string }> = [
  { id: "live", title: "Живой", sub: "Как говорят люди: разговорно, с огоньком. Подходит большинству новелл." },
  { id: "plain", title: "Ровный", sub: "Спокойно и нейтрально, без украшений и сленга." },
  { id: "elevated", title: "Возвышенный", sub: "Торжественно, чуть старинно — для эпоса и сянься." },
];

type Person = "1" | "3" | "";
type NarratorGender = "m" | "f" | "unknown";

/** Оглавление книги, её настройки перевода и расход. */
export default function BookScreen({ bookId }: { bookId: string }) {
  const [data, setData] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [usdRub, setUsdRub] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .book(bookId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorText(e)));
    getSettingsCached()
      .then((s) => alive && setUsdRub(s.usdRub))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bookId, reload]);

  const chapters = useMemo(() => {
    if (!data) return [];
    return data.chapters.slice().sort((a, b) => {
      if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
      if (a.number === null && b.number !== null) return 1;
      if (a.number !== null && b.number === null) return -1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
  }, [data]);

  if (error) {
    return (
      <main className="page">
        <BackLink href="/">Библиотека</BackLink>
        <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="page">
        <BackLink href="/">Библиотека</BackLink>
        <Loading />
      </main>
    );
  }

  const { book } = data;
  const translated = chapters.filter((c) => c.translated).length;

  return (
    <main className="page">
      <BackLink href="/">Библиотека</BackLink>
      <div className="row" style={{ gap: 16, alignItems: "flex-start", marginBottom: 24, flexWrap: "nowrap" }}>
        <Cover title={book.title} seed={book.id} src={book.coverUrl} width={72} height={102} />
        <div className="grow stack-sm">
          <h1 className="display" style={{ fontSize: 26, overflowWrap: "anywhere" }}>
            {book.title}
          </h1>
          <div className="facts">
            <span>
              переведено <strong className="nums">{num(translated)}</strong> из {num(chapters.length)}{" "}
              {plural(chapters.length, "главы", "глав", "глав")}
            </span>
            {book.site && <span>{book.site.replace(/^www\./, "")}</span>}
            {usdRub !== null && (
              <span>
                потрачено на книгу <strong>{rub(data.spentUsd || 0, usdRub)}</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="stack-lg">
        <section className="stack-sm" aria-label="Оглавление">
          <h2 className="label">Главы</h2>
          {chapters.length === 0 ? (
            <p className="p">
              В книге пока нет глав. <Link href="/add">Добавить главу</Link>
            </p>
          ) : (
            <ul className="chapter-list">
              {chapters.map((c) => (
                <li key={c.id}>
                  <Link href={`/read/${encodeURIComponent(c.id)}`}>
                    <span className="chapter-num">{c.number !== null ? c.number : "—"}</span>
                    <span className="grow" style={{ overflowWrap: "anywhere" }}>
                      {c.titleSrc || "Без названия"}
                    </span>
                    {c.translated ? (
                      <span className="chapter-mark done">переведена ✓</span>
                    ) : (
                      <span className="chapter-mark">нет перевода</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Link className="card" href={`/book/${encodeURIComponent(book.id)}/glossary`}>
          <div className="row-between">
            <div className="stack-sm" style={{ gap: 2 }}>
              <strong>Глоссарий: имена и термины</strong>
              <span className="small muted">Как переводить имена, титулы, техники; кто к кому на «ты» и на «вы».</span>
            </div>
            <span aria-hidden="true" style={{ fontSize: 20, color: "var(--accent-text)" }}>
              →
            </span>
          </div>
        </Link>

        <ReadyTranslation bookId={book.id} usdRub={usdRub} />

        <BookSettings book={book} onSaved={(b) => setData((d) => (d ? { ...d, book: { ...d.book, ...b } } : d))} />
      </div>
    </main>
  );
}

function BookSettings({ book, onSaved }: { book: Book; onSaved: (b: Book) => void }) {
  const [title, setTitle] = useState(book.title);
  const [register, setRegister] = useState<Register>(book.register);
  const [person, setPerson] = useState<Person>(book.narratorPerson ? (String(book.narratorPerson) as Person) : "");
  const [gender, setGender] = useState<NarratorGender>(toNarratorGender(book.narratorGender));
  const [honorifics, setHonorifics] = useState(book.honorifics ?? "");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<null | "saved" | string>(null);

  const patch: BookPatch = {
    title: title.trim() || book.title,
    register,
    narratorPerson: person === "1" ? 1 : person === "3" ? 3 : null,
    // «Не знаю» — это пусто, а не «unknown»: иначе Толмач перестанет сам определять род рассказчика.
    narratorGender: gender === "unknown" ? null : gender,
    honorifics: honorifics.trim() ? honorifics.trim() : null,
  };
  const dirty =
    patch.title !== book.title ||
    patch.register !== book.register ||
    patch.narratorPerson !== book.narratorPerson ||
    (patch.narratorGender ?? null) !== (book.narratorGender === "m" || book.narratorGender === "f" ? book.narratorGender : null) ||
    (patch.honorifics ?? null) !== (book.honorifics ?? null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setState(null);
    try {
      const b = await api.patchBook(book.id, patch);
      onSaved(b && typeof b === "object" && "id" in b ? b : { ...book, ...patch } as Book);
      setState("saved");
    } catch (err) {
      setState(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save} aria-label="Как переводить эту книгу">
      <div className="stack-sm">
        <h2 className="display">Как переводить эту книгу</h2>
        <p className="hint">Действует на главы, которые будут переведены после сохранения.</p>
      </div>

      <label className="field">
        <span>Название книги</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      </label>

      <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="field-label" style={{ marginBottom: 8 }}>
          Стиль
        </legend>
        {REGISTERS.map((r) => (
          <button
            key={r.id}
            type="button"
            className="choice"
            aria-pressed={register === r.id}
            onClick={() => setRegister(r.id)}
          >
            <span className="choice-title">{r.title}</span>
            <span className="choice-sub">{r.sub}</span>
          </button>
        ))}
      </fieldset>

      <div className="field">
        <span id="person-label">Рассказчик</span>
        <div className="segments" role="group" aria-labelledby="person-label">
          <button type="button" aria-pressed={person === "1"} onClick={() => setPerson("1")}>
            от первого лица
          </button>
          <button type="button" aria-pressed={person === "3"} onClick={() => setPerson("3")}>
            от третьего
          </button>
          <button type="button" aria-pressed={person === ""} onClick={() => setPerson("")}>
            не знаю
          </button>
        </div>
        <p className="hint">«Я пошёл» или «он пошёл». Если не знаете — Толмач решит сам по тексту.</p>
      </div>

      <div className="field">
        <span id="gender-label">Род рассказчика</span>
        <div className="segments" role="group" aria-labelledby="gender-label">
          <button type="button" aria-pressed={gender === "m"} onClick={() => setGender("m")}>
            мужской
          </button>
          <button type="button" aria-pressed={gender === "f"} onClick={() => setGender("f")}>
            женский
          </button>
          <button type="button" aria-pressed={gender === "unknown"} onClick={() => setGender("unknown")}>
            не знаю
          </button>
        </div>
        <p className="hint">Важно для рассказа от первого лица: «я пришёл» или «я пришла».</p>
      </div>

      <label className="field">
        <span>Обращения</span>
        <textarea
          className="textarea"
          style={{ minHeight: 96 }}
          value={honorifics}
          placeholder="Например: senior brother → «старший брат», senpai оставлять как «семпай»"
          onChange={(e) => setHonorifics(e.currentTarget.value)}
        />
        <span className="hint">Своими словами, как передавать особые обращения. Можно оставить пустым.</span>
      </label>

      {state && state !== "saved" && <ErrorNote text={state} />}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
        {state === "saved" && !dirty && <span className="small" style={{ color: "var(--ok)" }}>Сохранено ✓</span>}
      </div>
    </form>
  );
}

const LIVE = ["queued", "running"];

/**
 * Готовый перевод: главы чужого русского перевода, собранные кнопкой «Т»,
 * и сбор глоссария по ним (с ценой до запуска и ходом работы).
 */
function ReadyTranslation({ bookId, usdRub }: { bookId: string; usdRub: number | null }) {
  const [s, setS] = useState<RefSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .reference(bookId)
      .then((r) => alive && (setS(r), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [bookId, tick]);

  // Пока идёт сбор — обновляем ход каждые 4 секунды.
  const live = Boolean(s?.job && LIVE.includes(s.job.state));
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setTick((n) => n + 1), 4000);
    return () => clearTimeout(t);
  }, [live, tick]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setTick((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <ErrorNote text={error} onRetry={() => setTick((n) => n + 1)} /> : null;

  const price = usdRub !== null ? rub(s.estimateUsd, usdRub) : null;
  const job = s.job;

  if (s.count === 0) {
    return (
      <section className="card stack-sm" aria-label="Готовый перевод">
        <h2 className="display">Готовый перевод</h2>
        <p className="p">
          Если начало книги вы читали в чужом переводе, Толмач возьмёт оттуда имена и продолжит в том же духе — не
          переводя эти главы заново.
        </p>
        <p className="hint">
          На сайте с переводом откройте первую главу → «Т» → «Готовый перевод: эту и все следующие» → выберите эту
          книгу. Кнопка сама пролистает главы; на телефоне держите вкладку открытой.
        </p>
      </section>
    );
  }

  const blocked = job?.state === "blocked_budget" || job?.state === "blocked_credit";
  const canStart = !live && !blocked && (s.unscanned > 0 || s.pairs > 0);
  const doneBefore = job?.state === "done" && s.unscanned === 0;

  return (
    <section className="card stack" aria-label="Готовый перевод">
      <div className="stack-sm">
        <h2 className="display">Готовый перевод</h2>
        <p className="p">
          Глав: <strong className="nums">{num(s.count)}</strong>
          {s.minNumber !== null && s.maxNumber !== null && (
            <span className="muted">
              {" "}
              (главы {num(s.minNumber)}–{num(s.maxNumber)})
            </span>
          )}
          . Совпадают с английскими по номеру: <strong className="nums">{num(s.pairs)}</strong>.
        </p>
        {s.pairs === 0 && (
          <p className="hint">
            Для точной сверки добавьте несколько английских глав с теми же номерами — например, последние 5–10 —
            кнопкой «Т» на сайте с оригиналом. Без них Толмач возьмёт имена по-русски и сопоставит их при переводе.
          </p>
        )}
      </div>

      {job && <GlossaryJobLine job={job} hints={s.hints} matched={s.matched} />}

      {error && <ErrorNote text={error} />}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {canStart && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api.startGlossary(bookId))}>
            {doneBefore ? "Сверить с английским ещё раз" : "Собрать глоссарий"}
            {price ? ` — ${price}` : ""}
          </button>
        )}
        {blocked && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api.unblockBudget())}>
            Продолжить
          </button>
        )}
        {(live || blocked) && (
          <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.stopGlossary(bookId))}>
            Остановить
          </button>
        )}
        {(s.hints > 0 || s.matched > 0) && (
          <Link className="btn btn-quiet" href={`/book/${encodeURIComponent(bookId)}/glossary`}>
            Открыть глоссарий
          </Link>
        )}
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy || live}
          onClick={() => {
            if (window.confirm("Убрать главы готового перевода из Толмача? Глоссарий останется.")) void act(() => api.deleteReference(bookId));
          }}
        >
          Убрать готовый перевод
        </button>
      </div>
    </section>
  );
}

function GlossaryJobLine({ job, hints, matched }: { job: NonNullable<RefSummary["job"]>; hints: number; matched: number }) {
  if (job.state === "queued" || job.state === "running") {
    const text =
      job.stage === "scan"
        ? `Читаю готовый перевод: ${num(job.scanDone)} из ${num(job.scanTotal)} ${plural(job.scanTotal, "главы", "глав", "глав")}`
        : `Сверяю с английским: ${num(job.alignDone)} из ${num(job.alignTotal)}`;
    return (
      <p className="p" role="status">
        <span className="spinner" aria-hidden="true" /> {text}… Можно закрыть страницу — сбор идёт сам.
      </p>
    );
  }
  if (job.state === "blocked_budget")
    return <p className="p notice-warn">Не хватило месячного лимита. Поднимите его в Настройках и нажмите «Продолжить».</p>;
  if (job.state === "blocked_credit")
    return <p className="p notice-warn">На счёте Anthropic кончились деньги. Пополните его и нажмите «Продолжить».</p>;
  if (job.state === "failed")
    return <p className="p notice-warn">Сбор оборвался: {job.errorMessage || "неизвестная ошибка"}. Можно запустить ещё раз — прочитанные главы заново не читаются.</p>;
  if (job.state === "stopped") return <p className="p muted">Сбор остановлен. Можно продолжить — прочитанные главы заново не читаются.</p>;
  return (
    <p className="p" role="status">
      Готово ✓ Имён из готового перевода: <strong className="nums">{num(hints + matched)}</strong>, из них сопоставлено с
      английским: <strong className="nums">{num(matched)}</strong>. Остальные Толмач узнает, когда они встретятся в новых
      главах.
    </p>
  );
}

function toNarratorGender(g: Gender | null): NarratorGender {
  return g === "m" || g === "f" ? g : "unknown";
}
