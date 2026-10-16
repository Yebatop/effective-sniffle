"use client";

import { useState } from "react";
import { api, errorText, safeNext } from "@/lib/client/api";
import { loginProblemText } from "@/lib/client/login";
import { Icon } from "../Icon";

export default function LoginScreen({ next }: { next: string | null }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.login(password);
      if (r.ok) {
        // Полная загрузка: новая cookie и свежие настройки на всех экранах.
        window.location.replace(safeNext(next));
        return;
      }
      setProblem(loginProblemText(r.code, r.message));
    } catch (err) {
      setProblem(errorText(err));
    }
    setBusy(false);
  }

  return (
    <main className="page page-narrow" style={{ paddingTop: 56 }}>
      <form className="stack-lg" onSubmit={submit}>
        <div className="stack-sm center" style={{ alignItems: "center" }}>
          <span style={{ color: "var(--ink)" }}>
            <Icon name="logo" size={44} />
          </span>
          <h1 className="display">Толмач</h1>
          <p className="p">Личный переводчик веб-новелл. Введите пароль, который вы задали в Vercel.</p>
        </div>

        <label className="field">
          <span>Пароль</span>
          <input
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </label>

        {problem && (
          <div className="notice notice-error" role="alert">
            <p>{problem}</p>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-big btn-block" disabled={busy || !password}>
          {busy ? "Проверяю…" : "Войти"}
        </button>
        <p className="hint center">На этом устройстве пароль запомнится — вводить его каждый раз не нужно.</p>
      </form>
    </main>
  );
}
