// Объявления API менеджеров юзерскриптов (Violentmonkey, Tampermonkey) —
// только то, чем пользуется кнопка. В рантайме каждое проверяется через typeof:
// менеджер выдаёт лишь то, что перечислено в @grant.

interface GmXhrResponse {
  status: number;
  statusText: string;
  responseText: string;
  /** Сырые заголовки строкой «name: value\r\n…». */
  responseHeaders: string;
  finalUrl: string;
  readyState: number;
}

interface GmXhrDetails {
  method?: "GET" | "POST" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  data?: string;
  /** false — с куками пользователя для этого сайта. */
  anonymous?: boolean;
  timeout?: number;
  overrideMimeType?: string;
  onload?: (response: GmXhrResponse) => void;
  onerror?: (response: GmXhrResponse) => void;
  ontimeout?: (response: GmXhrResponse) => void;
  onabort?: (response: GmXhrResponse) => void;
}

declare function GM_xmlhttpRequest(details: GmXhrDetails): unknown;
declare function GM_setValue(key: string, value: string | number | boolean): void;
declare function GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
declare function GM_openInTab(url: string, options?: { active?: boolean; insert?: boolean; setParent?: boolean } | boolean): unknown;
/** Пункт в меню дополнения (у Violentmonkey и Tampermonkey — значок дополнения). */
declare function GM_registerMenuCommand(caption: string, onClick: () => void): unknown;
/** Окно страницы, когда скрипт работает в песочнице менеджера. */
declare const unsafeWindow: Window | undefined;
