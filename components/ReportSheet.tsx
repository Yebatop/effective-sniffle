"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client/api";
import type { ReportRequest } from "@/lib/types";
import Sheet from "./Sheet";
import { CopyField, ErrorNote } from "./bits";

type Kind = ReportRequest["kind"];

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: "wrong_text", label: "Текст снят неправильно" },
  { id: "bad_translation", label: "Плохой перевод" },
  { id: "error", label: "Ошибка" },
  { id: "other", label: "Другое" },
];

/**
 * «Что-то не так»: сохраняет отчёт со снимком состояния и даёт ссылку,
 * по которой сессия Claude Code прочитает его сама.
 */
export default function ReportSheet({
  open,
  onClose,
  chapterId,
  initialKind = "other",
  snapshot,
}: {
  open: boolean;
  onClose: () => void;
  chapterId?: string;
  initialKind?: Kind;
  snapshot: () => unknown;
}) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setError(null);
    } else {
      setUrl(null);
      setNote("");
    }
  }, [open, initialKind]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.report({ chapterId, kind, note: note.trim() || undefined, snapshot: snapshot() });
      setUrl(absolute(r.url));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} title="Что-то не так" onClose={onClose}>
      {url ? (
        <div className="stack" style={{ paddingBottom: 8 }}>
          <p className="p">Отчёт сохранён. Отправьте эту ссылку в чат Claude — он прочитает отчёт сам.</p>
          <CopyField value={url} />
        </div>
      ) : (
        <div className="stack" style={{ paddingBottom: 8 }}>
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label" style={{ marginBottom: 8 }}>
              Что случилось
            </legend>
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                className="choice"
                role="radio"
                aria-checked={kind === k.id}
                onClick={() => setKind(k.id)}
              >
                <span className="choice-title">{k.label}</span>
              </button>
            ))}
          </fieldset>
          <label className="field">
            <span>Пара слов — не обязательно</span>
            <textarea
              className="textarea"
              style={{ minHeight: 96 }}
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              placeholder="Например: «пропал кусок в середине», «имя героя каждый раз разное»"
            />
          </label>
          {error && <ErrorNote text={error} />}
          <button type="button" className="btn btn-primary btn-block" onClick={send} disabled={busy}>
            {busy ? "Сохраняю…" : "Сохранить отчёт"}
          </button>
        </div>
      )}
    </Sheet>
  );
}

function absolute(u: string): string {
  try {
    return new URL(u, window.location.origin).toString();
  } catch {
    return u;
  }
}
