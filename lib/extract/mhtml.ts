/**
 * Сохранённая страница Chrome (.mht/.mhtml): разрезать MIME-части, найти
 * первую text/html-часть с содержимым (не преамбулу!), декодировать
 * quoted-printable или base64 как UTF-8 (через TextDecoder, не побайтно),
 * учесть charset части. Возвращает HTML и адрес страницы (Content-Location).
 * Работает и в браузере, и в Node.
 *
 * Ошибка exttran (src/extract.ts:96-123): у Chrome в заголовке всего файла
 * стоит `type="text/html"`, и первый кусок после разреза по границе —
 * заголовки файла с пустой преамбулой — принимался за страницу. Здесь
 * заголовки файла разбираются отдельно, а части берутся только между
 * границами. Второй грех — `String.fromCharCode` по байтам quoted-printable:
 * UTF-8 рассыпался в «â€œ» вместо кавычек.
 */
export function decodeMhtml(raw: string | Uint8Array): { html: string; url: string | null } {
  // Байты держим «двоичной строкой» (символ = байт): заголовки и
  // quoted-printable — ASCII, а сырые 8bit-части потом декодируются по charset.
  const binary = typeof raw !== "string";
  const text = binary ? bytesToBinary(raw as Uint8Array) : (raw as string);

  const top = splitHead(text);
  const headers = parseHeaders(top.head);
  const contentType = headers["content-type"] || "";
  const snapshotUrl = headers["snapshot-content-location"] || headers["content-location"] || null;

  if (/^multipart\//i.test(contentType)) {
    const boundary = param(contentType, "boundary");
    if (!boundary) throw new Error(BROKEN);
    for (const part of splitParts(top.body, boundary)) {
      const ph = splitHead(part);
      const h = parseHeaders(ph.head);
      const type = h["content-type"] || "text/plain";
      if (!/^text\/html\b/i.test(type)) continue;
      const html = decodeBody(ph.body, h["content-transfer-encoding"] || "", param(type, "charset"), binary);
      if (html.trim() === "") continue;
      return { html, url: h["content-location"] || snapshotUrl };
    }
    throw new Error(BROKEN);
  }

  // Одночастное письмо с HTML внутри (так сохраняют некоторые браузеры).
  if (/^text\/html\b/i.test(contentType)) {
    const html = decodeBody(top.body, headers["content-transfer-encoding"] || "", param(contentType, "charset"), binary);
    return { html, url: snapshotUrl };
  }

  // Не MIME вовсе: обычный HTML с расширением .mht.
  if (/<(?:html|body|p|div)\b/i.test(text)) {
    return { html: binary ? decodeBytes(binaryToBytes(text), null) : text, url: null };
  }
  throw new Error(BROKEN);
}

const BROKEN =
  "Файл похож на сохранённую страницу (.mht), но страницу в нём найти не удалось. Пересохраните главу или вставьте текст.";

function bytesToBinary(bytes: Uint8Array): string {
  // Кусками: String.fromCharCode с миллионом аргументов переполняет стек.
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + step)) as number[]);
  }
  return out;
}

function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Заголовки до первой пустой строки и тело после неё. */
function splitHead(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: "" };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

/** Заголовки MIME с продолжениями строк (folding) → объект с ключами в нижнем регистре. */
function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    if (!(key in out)) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** Параметр заголовка: boundary="----X", charset=utf-8. */
function param(header: string, name: string): string | null {
  const re = new RegExp(";\\s*" + name + '\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))', "i");
  const m = re.exec(header);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2]) || null;
}

/** Части между строками «--boundary»; преамбула и эпилог отбрасываются. */
function splitParts(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const parts: string[] = [];
  let pos = indexOfLine(body, delim, 0);
  while (pos >= 0) {
    const after = pos + delim.length;
    if (body.slice(after, after + 2) === "--") break; // закрывающая граница
    const lineEnd = body.indexOf("\n", after);
    if (lineEnd < 0) break;
    const next = indexOfLine(body, delim, lineEnd + 1);
    const end = next >= 0 ? next : body.length;
    // Перевод строки перед границей принадлежит границе, а не части.
    parts.push(body.slice(lineEnd + 1, end).replace(/\r?\n$/, ""));
    pos = next;
  }
  return parts;
}

/** Граница считается только в начале строки. */
function indexOfLine(s: string, needle: string, from: number): number {
  let at = s.indexOf(needle, from);
  while (at >= 0) {
    if (at === 0 || s.charAt(at - 1) === "\n") return at;
    at = s.indexOf(needle, at + 1);
  }
  return -1;
}

function decodeBody(body: string, encoding: string, charset: string | null, binary: boolean): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === "quoted-printable") return decodeBytes(qpToBytes(body, binary), charset);
  if (enc === "base64") return decodeBytes(base64ToBytes(body), charset);
  // 7bit/8bit/binary: из байтов — по charset; из строки — она уже текст.
  return binary ? decodeBytes(binaryToBytes(body), charset) : body;
}

/** quoted-printable → байты: «=E2=80=9C» — три байта одного символа, а не три символа. */
function qpToBytes(s: string, binary: boolean): Uint8Array {
  const src = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  const encoder = binary ? null : new TextEncoder();
  for (let i = 0; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 61 /* = */ && i + 2 < src.length && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch < 128 || binary) {
      out.push(ch & 0xff);
    } else {
      // Строку уже декодировали до нас (FileReader.readAsText): символ вне
      // ASCII — настоящий символ, его байты в UTF-8.
      const code = src.codePointAt(i) as number;
      const bytes = (encoder as TextEncoder).encode(String.fromCodePoint(code));
      for (let k = 0; k < bytes.length; k++) out.push(bytes[k]);
      if (code > 0xffff) i++;
    }
  }
  return new Uint8Array(out);
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  return binaryToBytes(bin);
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
