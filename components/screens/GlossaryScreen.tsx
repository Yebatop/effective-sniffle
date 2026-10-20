"use client";

import { useEffect, useMemo, useState } from "react";
import { api, errorText, type GlossaryView, type TermPatch } from "@/lib/client/api";
import { KIND_LABELS, KIND_ORDER, formatAliases, groupTerms, parseAliases } from "@/lib/client/glossary";
import type { Address, Gender, Term, TermKind } from "@/lib/types";
import { BackLink, ErrorNote, Loading } from "../bits";

const GENDERS: Array<{ id: Gender; label: string }> = [
  { id: "m", label: "мужской" },
  { id: "f", label: "женский" },
  { id: "n", label: "средний" },
  { id: "unknown", label: "не ясно" },
];

/** Глоссарий книги: как переводить имена и термины, кто к кому на «ты»/«вы». */
export default function GlossaryScreen({ bookId }: { bookId: string }) {
  const [data, setData] = useState<GlossaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .glossary(bookId)
      .then((d) => alive && setData({ terms: d.terms ?? [], addresses: d.addresses ?? [], refTerms: d.refTerms ?? [] }))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [bookId, reload]);

  // Пришли из карточки термина в читалке (#term-<id>) — показать его.
  useEffect(() => {
    if (!data) return;
    const h = typeof window !== "undefined" ? decodeURIComponent(window.location.hash.slice(1)) : "";
    if (!h.startsWith("term-")) return;
    setTarget(h.slice(5));
    const el = document.getElementById(h);
    if (el) el.scrollIntoView({ block: "center" });
  }, [data]);

  const groups = useMemo(() => (data ? groupTerms(data.terms) : []), [data]);
  const hints = useMemo(() => (data?.refTerms ?? []).filter((r) => r.termId === null), [data]);
  const termById = useMemo(() => {
    const m = new Map<string, Term>();
    for (const t of data?.terms ?? []) m.set(t.id, t);
    return m;
  }, [data]);

  function replaceTerm(t: Term) {
    setData((d) => (d ? { ...d, terms: d.terms.map((x) => (x.id === t.id ? t : x)) } : d));
  }
  function dropTerm(id: string) {
    setData((d) =>
      d
        ? {
            terms: d.terms.filter((x) => x.id !== id),
            addresses: d.addresses.filter((a) => a.fromTermId !== id && a.toTermId !== id),
          }
        : d,
    );
  }
  function replaceAddress(a: Address) {
    setData((d) => (d ? { ...d, addresses: d.addresses.map((x) => (x.id === a.id ? a : x)) } : d));
  }

  const back = `/book/${encodeURIComponent(bookId)}`;
  return (
    <main className="page">
      <BackLink href={back}>К книге</BackLink>
      <div className="page-head">
        <h1 className="display">Глоссарий</h1>
        <p className="p">
          Здесь записано, как переводить имена, титулы, приёмы и названия этой книги, — чтобы в каждой главе было
          одинаково. Толмач заполняет его сам, когда переводит; пометка «предложено» значит, что запись он добавил
          сам и её никто не проверял. Ничего не обязательно: поправьте только то, что выглядит неправильно, — новые
          главы переведутся уже по-вашему.
        </p>
      </div>

      {error && <ErrorNote text={error} onRetry={() => setReload((n) => n + 1)} />}
      {!data && !error && <Loading />}

      {data && data.terms.length === 0 && (data.refTerms ?? []).length === 0 && (
        <div className="notice">
          <p>Пока пусто. Глоссарий появится после перевода первой главы.</p>
        </div>
      )}

      {data && (
        <div className="stack-lg">
          {groups.map((g) => (
            <section key={g.kind} aria-labelledby={`kind-${g.kind}`}>
              <h2 id={`kind-${g.kind}`} className="label" style={{ marginBottom: 4 }}>
                {g.label} <span className="dim">· {g.terms.length}</span>
              </h2>
              <div>
                {g.terms.map((t) => (
                  <TermRow
                    key={t.id}
                    term={t}
                    highlighted={target === t.id}
                    onSaved={replaceTerm}
                    onDeleted={dropTerm}
                  />
                ))}
              </div>
            </section>
          ))}

          {hints.length > 0 && (
            <section aria-labelledby="hints-head" className="stack-sm">
              <h2 id="hints-head" className="label">
                Из готового перевода, ещё не встречались по-английски <span className="dim">· {hints.length}</span>
              </h2>
              <p className="hint">
                Когда такое имя появится в новой главе, Толмач возьмёт это написание и перенесёт его в глоссарий.
              </p>
              <details className="term-more">
                <summary>Показать</summary>
                <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                  {hints.map((h) => (
                    <li key={h.id} className="small">
                      <strong>{h.ru}</strong>
                      {h.note ? <span className="muted"> — {h.note}</span> : null}
                      {h.lastNumber !== null ? <span className="dim"> · до гл. {h.lastNumber}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {data.addresses.length > 0 && (
            <section aria-labelledby="addr-head" className="stack-sm">
              <h2 id="addr-head" className="label">
                Кто к кому как обращается
              </h2>
              <p className="hint">«Ты» или «вы» в репликах. Толмач угадывает по тексту; если ошибся — переключите.</p>
              <div>
                {data.addresses.map((a) => (
                  <AddressRow key={a.id} address={a} terms={termById} onSaved={replaceAddress} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function TermRow({
  term,
  highlighted,
  onSaved,
  onDeleted,
}: {
  term: Term;
  highlighted: boolean;
  onSaved: (t: Term) => void;
  onDeleted: (id: string) => void;
}) {
  const [ru, setRu] = useState(term.ru);
  const [aliases, setAliases] = useState(formatAliases(term.aliases));
  const [note, setNote] = useState(term.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setRu(term.ru);
    setAliases(formatAliases(term.aliases));
    setNote(term.note ?? "");
  }, [term]);

  async function save(patch: TermPatch) {
    setBusy(true);
    setError(null);
    try {
      const t = await api.patchTerm(term.id, patch);
      onSaved(t && typeof t === "object" && "id" in t ? t : { ...term, ...patch, status: "checked" });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function saveRu() {
    const v = ru.trim();
    if (!v) {
      setRu(term.ru);
      return;
    }
    if (v !== term.ru) void save({ ru: v });
  }
  function saveAliases() {
    const list = parseAliases(aliases);
    if (formatAliases(list) !== formatAliases(term.aliases)) void save({ aliases: list });
    else setAliases(formatAliases(term.aliases));
  }
  function saveNote() {
    const v = note.trim();
    if (v !== (term.note ?? "")) void save({ note: v ? v : null });
  }
  async function remove() {
    if (!window.confirm(`Удалить «${term.en} → ${term.ru}» из глоссария?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTerm(term.id);
      onDeleted(term.id);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const enter = (fn: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fn();
      e.currentTarget.blur();
    }
  };

  return (
    <div className={`term-row${highlighted ? " term-row-target" : ""}`} id={`term-${term.id}`}>
      <div className="term-main">
        <span className="term-en" lang="en">
          {term.en}
        </span>
        <div className="term-line">
          <span className="dim" aria-hidden="true">
            →
          </span>
          <input
            className="input-inline"
            value={ru}
            aria-label={`Перевод для «${term.en}»`}
            onChange={(e) => setRu(e.currentTarget.value)}
            onBlur={saveRu}
            onKeyDown={enter(saveRu)}
          />
          {term.status === "proposed" ? (
            <button
              type="button"
              className="chip chip-proposed"
              disabled={busy}
              onClick={() => void save({ status: "checked" })}
              title="Нажмите, если перевод верный"
            >
              предложено
            </button>
          ) : (
            <span className="chip chip-checked">проверено</span>
          )}
        </div>
        {term.source === "reference" && <span className="small muted">из готового перевода</span>}
      </div>

      {term.kind === "name" && (
        <label className="row" style={{ gap: 8 }}>
          <span className="small muted">Род</span>
          <select
            className="select"
            style={{ width: "auto", minHeight: 40, padding: "6px 10px" }}
            value={term.gender ?? "unknown"}
            disabled={busy}
            onChange={(e) => void save({ gender: e.currentTarget.value as Gender })}
          >
            {GENDERS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <details className="term-more" open={highlighted || undefined}>
        <summary>
          Ещё{term.aliases.length > 0 ? ` · другие имена: ${term.aliases.length}` : ""}
          {term.note ? " · есть заметка" : ""}
        </summary>
        <label className="field">
          <span>Другие имена (по-английски, через запятую)</span>
          <input
            className="input"
            value={aliases}
            placeholder="Например: Gu, Master Gu"
            onChange={(e) => setAliases(e.currentTarget.value)}
            onBlur={saveAliases}
            onKeyDown={enter(saveAliases)}
          />
        </label>
        <label className="field">
          <span>Заметка для перевода</span>
          <input
            className="input"
            value={note}
            placeholder="Например: говорит грубо, на «ты» со всеми"
            onChange={(e) => setNote(e.currentTarget.value)}
            onBlur={saveNote}
            onKeyDown={enter(saveNote)}
          />
        </label>
        <label className="field">
          <span>Раздел</span>
          <select
            className="select"
            value={term.kind}
            disabled={busy}
            onChange={(e) => {
              const kind = e.currentTarget.value as TermKind;
              void save(kind === "name" ? { kind } : { kind, gender: null });
            }}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="button" className="btn btn-danger btn-small" onClick={() => void remove()} disabled={busy}>
            Удалить из глоссария
          </button>
        </div>
      </details>

      {(error || savedFlash || busy) && (
        <p className="tiny" role="status" style={{ margin: 0, color: error ? "var(--danger-ink)" : "var(--ok)" }}>
          {error ? error : busy ? "Сохраняю…" : "Сохранено ✓"}
        </p>
      )}
    </div>
  );
}

function AddressRow({
  address,
  terms,
  onSaved,
}: {
  address: Address;
  terms: Map<string, Term>;
  onSaved: (a: Address) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = terms.get(address.fromTermId);
  const to = terms.get(address.toTermId);

  async function pick(form: "ty" | "vy") {
    if (form === address.form || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchAddress(address.id, form);
      onSaved({ ...address, form, status: "checked" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addr-row">
      <div className="grow stack-sm" style={{ gap: 2 }}>
        <span style={{ overflowWrap: "anywhere" }}>
          {from?.ru ?? "?"} <span className="dim">→</span> {to?.ru ?? "?"}
        </span>
        <span className="tiny dim">
          {address.fromChapter !== null ? `с главы ${address.fromChapter}` : "с начала"}
          {address.status === "proposed" ? " · предложено" : ""}
        </span>
        {error && (
          <span className="tiny" style={{ color: "var(--danger-ink)" }}>
            {error}
          </span>
        )}
      </div>
      <div
        className="segments"
        role="group"
        aria-label={`Как ${from?.ru ?? "?"} обращается к ${to?.ru ?? "?"}`}
      >
        <button type="button" aria-pressed={address.form === "ty"} disabled={busy} onClick={() => void pick("ty")}>
          ты
        </button>
        <button type="button" aria-pressed={address.form === "vy"} disabled={busy} onClick={() => void pick("vy")}>
          вы
        </button>
      </div>
    </div>
  );
}
