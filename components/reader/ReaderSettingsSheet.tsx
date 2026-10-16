"use client";

import {
  FONT_MAX,
  FONT_MIN,
  LINE_HEIGHT_LABELS,
  THEMES,
  THEME_BG,
  THEME_LABELS,
  type LineHeightStep,
  type ReaderPrefs,
  type ThemeName,
} from "@/lib/client/prefs";
import Sheet from "../Sheet";
import { Switch } from "../bits";

/** «Aa»: тема, кегль, интервал, шрифт, «не гасить экран». */
export default function ReaderSettingsSheet({
  open,
  onClose,
  prefs,
  onPrefs,
  theme,
  onTheme,
  wakeLockSupported,
}: {
  open: boolean;
  onClose: () => void;
  prefs: ReaderPrefs;
  onPrefs: (p: ReaderPrefs) => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  wakeLockSupported: boolean;
}) {
  return (
    <Sheet open={open} title="Вид текста" onClose={onClose}>
      <div className="sheet-section">
        <span className="field-label" id="theme-label">
          Тема
        </span>
        <div className="swatches" role="group" aria-labelledby="theme-label">
          {THEMES.map((t) => (
            <button key={t} type="button" className="swatch" aria-pressed={theme === t} onClick={() => onTheme(t)}>
              <i style={{ background: THEME_BG[t] }} />
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="sheet-section">
        <span className="field-label" id="size-label">
          Размер букв
        </span>
        <div className="stepper" role="group" aria-labelledby="size-label">
          <button
            type="button"
            className="btn"
            aria-label="Мельче"
            disabled={prefs.fontSize <= FONT_MIN}
            onClick={() => onPrefs({ ...prefs, fontSize: Math.max(FONT_MIN, prefs.fontSize - 1) })}
          >
            A−
          </button>
          <output aria-live="polite">{prefs.fontSize} px</output>
          <button
            type="button"
            className="btn"
            aria-label="Крупнее"
            disabled={prefs.fontSize >= FONT_MAX}
            onClick={() => onPrefs({ ...prefs, fontSize: Math.min(FONT_MAX, prefs.fontSize + 1) })}
          >
            A+
          </button>
        </div>
      </div>

      <div className="sheet-section">
        <span className="field-label" id="lh-label">
          Между строками
        </span>
        <div className="segments" role="group" aria-labelledby="lh-label">
          {LINE_HEIGHT_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-pressed={prefs.lineHeight === i}
              onClick={() => onPrefs({ ...prefs, lineHeight: i as LineHeightStep })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="sheet-section">
        <span className="field-label" id="font-label">
          Шрифт
        </span>
        <div className="segments" role="group" aria-labelledby="font-label">
          <button
            type="button"
            aria-pressed={prefs.font === "serif"}
            onClick={() => onPrefs({ ...prefs, font: "serif" })}
            style={{ fontFamily: "var(--font-read), Georgia, serif" }}
          >
            С засечками
          </button>
          <button
            type="button"
            aria-pressed={prefs.font === "sans"}
            onClick={() => onPrefs({ ...prefs, font: "sans" })}
          >
            Без засечек
          </button>
        </div>
      </div>

      {wakeLockSupported && (
        <div className="sheet-section">
          <Switch
            label="Не гасить экран"
            hint="Пока открыта глава, экран не потухнет сам."
            checked={prefs.keepAwake}
            onChange={(v) => onPrefs({ ...prefs, keepAwake: v })}
          />
        </div>
      )}
    </Sheet>
  );
}
