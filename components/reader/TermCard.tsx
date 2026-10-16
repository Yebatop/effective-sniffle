"use client";

import Link from "next/link";
import type { Gender, Term } from "@/lib/types";
import Sheet from "../Sheet";

export const GENDER_LABELS: Record<Gender, string> = {
  m: "мужской",
  f: "женский",
  n: "средний",
  unknown: "не ясно",
};

/** Карточка термина по нажатию в тексте. */
export default function TermCard({ term, onClose }: { term: Term | null; onClose: () => void }) {
  return (
    <Sheet open={!!term} title="Из глоссария книги" onClose={onClose}>
      {term && (
        <div className="stack" style={{ paddingBottom: 6 }}>
          <div className="stack-sm">
            <div className="row">
              <span className="term-card-ru">{term.ru}</span>
              {term.status === "proposed" ? (
                <span className="chip chip-proposed" title="Толмач добавил сам — проверьте">
                  предложено
                </span>
              ) : (
                <span className="chip chip-checked">проверено</span>
              )}
            </div>
            <span className="term-card-en" lang="en">
              {term.en}
              {term.aliases && term.aliases.length > 0 ? ` · ${term.aliases.join(", ")}` : ""}
            </span>
          </div>
          {term.kind === "name" && term.gender && (
            <p className="p">
              Род: <strong>{GENDER_LABELS[term.gender]}</strong>
            </p>
          )}
          {term.note && <p className="p">{term.note}</p>}
          <Link
            className="btn"
            href={`/book/${encodeURIComponent(term.bookId)}/glossary#term-${encodeURIComponent(term.id)}`}
          >
            Изменить в глоссарии
          </Link>
        </div>
      )}
    </Sheet>
  );
}
