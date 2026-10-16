"use client";

import { useState } from "react";

/**
 * Обложка книги: настоящая, если есть адрес, поверх нарисованной (первая
 * буква названия на тёплом фоне). Не загрузилась — остаётся нарисованная.
 * Оттенок считается из id книги: одна и та же книга всегда одного цвета.
 */
export default function Cover({
  title,
  seed,
  src,
  width,
  height,
}: {
  title: string;
  seed: string;
  src?: string | null;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState(false);
  const tone = hue(seed || title);
  const letter = initial(title);
  return (
    <div
      className="cover"
      aria-hidden="true"
      style={{
        width,
        height,
        background: `linear-gradient(150deg, hsl(${tone}, 22%, 24%), hsl(${tone}, 18%, 13%))`,
      }}
    >
      <span className="cover-letter" style={{ fontSize: Math.round(height * 0.38), color: `hsl(${tone}, 32%, 66%)` }}>
        {letter}
      </span>
      {src && !failed && (
        // Простая картинка, а не next/image: обложки лежат на любых сайтах.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function initial(title: string): string {
  const m = (title || "").trim().match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "?";
}

function hue(seed: string): number {
  let n = 0;
  for (let i = 0; i < seed.length; i += 1) n = (n * 31 + seed.charCodeAt(i)) | 0;
  return 12 + (Math.abs(n) % 32);
}
