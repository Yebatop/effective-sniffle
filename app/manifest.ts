import type { MetadataRoute } from "next";

/**
 * Описание приложения для «Установить на главный экран» и для меню
 * «Поделиться»: share_target шлёт POST /share, его принимает public/sw.js.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Толмач",
    short_name: "Толмач",
    description: "Личный переводчик веб-новелл с английского на русский.",
    lang: "ru",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#14120f",
    theme_color: "#14120f",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [
          {
            name: "file",
            accept: ["text/html", ".html", ".htm", ".mht", ".mhtml", "multipart/related", "message/rfc822"],
          },
        ],
      },
    },
  };
}
