"use client";

import Link from "next/link";
import { useState } from "react";
import { copyText } from "@/lib/client/clipboard";
import { Icon } from "./Icon";

export function Loading({ text = "Загружаю…" }: { text?: string }) {
  return (
    <div className="loading-line" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function ErrorNote({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <p>{text}</p>
      {onRetry && (
        <p>
          <button type="button" className="btn btn-small" onClick={onRetry} style={{ marginTop: 6 }}>
            Попробовать ещё раз
          </button>
        </p>
      )}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="back-link">
      ← {children}
    </Link>
  );
}

/** Поле со ссылкой и кнопкой «Скопировать». */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <div className="stack-sm">
      {label && <span className="field-label">{label}</span>}
      <input
        className="input"
        readOnly
        value={value}
        aria-label={label ?? "Ссылка"}
        onFocus={(e) => e.currentTarget.select()}
        style={{ fontSize: 14 }}
      />
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={async () => setState((await copyText(value)) ? "ok" : "fail")}
        >
          <Icon name="copy" size={18} />
          {state === "ok" ? "Скопировано ✓" : "Скопировать"}
        </button>
        {state === "fail" && <span className="small dim">Не вышло — выделите ссылку и скопируйте вручную.</span>}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <span className="grow">
        <span style={{ display: "block" }}>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  );
}
