/**
 * Штриховые иконки на сетке 20 px (как в макетах «Толмача»). Эмодзи не используем.
 */

export type IconName =
  | "logo"
  | "books"
  | "plus"
  | "gear"
  | "back"
  | "more"
  | "close"
  | "check"
  | "link"
  | "file"
  | "text"
  | "copy"
  | "share";

export function Icon({ name, size = 20, title }: { name: IconName; size?: number; title?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
  };
  const t = title ? <title>{title}</title> : null;
  switch (name) {
    case "logo":
      return (
        <svg {...common} viewBox="0 0 26 26">
          {t}
          <path d="M4 3.5h11.5L22 10v12.5H4z" />
          <path d="M15.5 3.5V10H22" />
          <path d="M8 14.5h9M8 18h6" stroke="var(--accent)" strokeWidth={1.9} />
        </svg>
      );
    case "books":
      return (
        <svg {...common}>
          {t}
          <path d="M3.5 4h4v12h-4zM8.5 4h4v12h-4z" />
          <path d="m13.5 5 3.4-.9 2.6 11.6-3.4.8z" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          {t}
          <path d="M10 4v12M4 10h12" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          {t}
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" />
        </svg>
      );
    case "back":
      return (
        <svg {...common}>
          {t}
          <path d="M12.5 4 6.5 10l6 6" />
        </svg>
      );
    case "more":
      return (
        <svg {...common} stroke="none" fill="currentColor">
          {t}
          <circle cx="10" cy="4.5" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="10" cy="15.5" r="1.6" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          {t}
          <path d="m5 5 10 10M15 5 5 15" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          {t}
          <path d="m4.5 10.5 3.5 3.5 7.5-8" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          {t}
          <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1" />
          <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          {t}
          <path d="M5 2.8h6.5L15 6.3v10.9H5z" />
          <path d="M11.5 2.8v3.5H15" />
        </svg>
      );
    case "text":
      return (
        <svg {...common}>
          {t}
          <path d="M4 5h12M4 8.5h12M4 12h12M4 15.5h7" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          {t}
          <rect x="6.5" y="6.5" width="10" height="10" rx="2" />
          <path d="M13.5 6.5V4.5a1.5 1.5 0 0 0-1.5-1.5H5a1.5 1.5 0 0 0-1.5 1.5V12A1.5 1.5 0 0 0 5 13.5h1.5" />
        </svg>
      );
    case "share":
      return (
        <svg {...common}>
          {t}
          <path d="M10 3v9M6.5 6.5 10 3l3.5 3.5" />
          <path d="M4.5 10.5v5.5h11v-5.5" />
        </svg>
      );
  }
}
