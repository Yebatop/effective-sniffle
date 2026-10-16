"use client";

import { memo } from "react";
import { highlightWith, type CompiledTerms } from "@/lib/client/highlight";
import type { Paragraph, Term, TranslatedParagraph } from "@/lib/types";

export const REFUSED_TEXT = "[Модель отказалась переводить этот абзац]";

/**
 * Текст главы. Отдельный memo-компонент: читалка часто перерисовывается
 * (панель, место чтения), а подсветка терминов по всем абзацам — нет.
 */
function ChapterTextImpl({
  originals,
  translated,
  showMissing,
  compiled,
  open,
  onToggle,
  onTerm,
}: {
  /** Абзацы оригинала с idx ≥ 1. */
  originals: Paragraph[];
  translated: ReadonlyMap<number, TranslatedParagraph>;
  /** Перевод закончен: непереведённые абзацы показать оригиналом. */
  showMissing: boolean;
  compiled: CompiledTerms<Term> | null;
  open: ReadonlySet<number>;
  onToggle: (idx: number) => void;
  onTerm: (t: Term) => void;
}) {
  let dropcapDone = false;
  const out: React.ReactNode[] = [];

  for (const p of originals) {
    const tr = translated.get(p.idx);
    if (!tr && !showMissing) continue;
    const isOpen = open.has(p.idx);
    const refused = !!tr?.refused;
    let cls = "para";
    let body: React.ReactNode;
    if (tr && !refused) {
      if (!dropcapDone) {
        dropcapDone = true;
        if (/^[\p{L}\p{N}]/u.test(tr.text.trim())) cls += " dropcap";
      }
      body = renderText(tr.text, compiled, onTerm);
    } else if (refused) {
      dropcapDone = true;
      body = <span className="refused-note">{REFUSED_TEXT}</span>;
    } else {
      dropcapDone = true;
      cls += " para-missing";
      body = <span lang="en">{p.text}</span>;
    }
    out.push(
      <div key={p.idx} className="para-wrap" data-idx={p.idx} data-open={isOpen || refused ? "true" : "false"}>
        <p
          className={cls}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".term")) return;
            const sel = typeof window !== "undefined" ? window.getSelection() : null;
            if (sel && sel.toString().length > 0) return;
            if (tr && !refused) onToggle(p.idx);
          }}
        >
          {body}
        </p>
        {tr && (isOpen || refused) && (
          <p className="para-orig" lang="en">
            {p.text}
          </p>
        )}
      </div>,
    );
  }

  return <>{out}</>;
}

function renderText(text: string, compiled: CompiledTerms<Term> | null, onTerm: (t: Term) => void): React.ReactNode {
  // Реплики с новой строки внутри одного абзаца.
  const lines = text.split("\n");
  return lines.map((line, li) => (
    <span key={li}>
      {li > 0 && <br />}
      {highlightWith(line, compiled).map((seg, i) =>
        seg.term ? (
          <span
            key={i}
            className="term"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onTerm(seg.term as Term);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onTerm(seg.term as Term);
              }
            }}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  ));
}

const ChapterText = memo(ChapterTextImpl);
export default ChapterText;
