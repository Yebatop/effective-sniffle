/**
 * Поддельный сервер Anthropic для тестов: ничего не тратит и ведёт себя
 * предсказуемо по меткам в тексте главы.
 *
 * - Перевод (поток): на каждый абзац ⟦n⟧ отвечает «⟦n⟧ RU: <текст>».
 *   REFUSE_ME в части — отказ (stop_reason refusal), если модель не Opus.
 *   TRUNCATE_ME — обрыв после первого абзаца (stop_reason max_tokens).
 *   SKIP_ME — абзац пропущен, если в части больше одного абзаца.
 * - Разбор терминов (без потока, structured outputs): имена с заглавной
 *   буквы из списка KNOWN_NAMES.
 * - /v1/models/:id — для проверки ключа.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockCall {
  path: string;
  model: string;
  stream: boolean;
  body: Record<string, unknown>;
}

const KNOWN_NAMES: Record<string, { ru: string; gender: "m" | "f" }> = {
  Mara: { ru: "Мара", gender: "f" },
  Fen: { ru: "Фен", gender: "m" },
  Oskar: { ru: "Оскар", gender: "m" },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

function userText(body: Record<string, unknown>): string {
  const messages = (body.messages as Array<{ content: unknown }>) ?? [];
  const c = messages[messages.length - 1]?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join("\n");
  return "";
}

function labelled(text: string): Array<{ idx: number; text: string }> {
  // Абзацы с метками — после последнего раздела «ПЕРЕВЕДИ».
  const at = text.lastIndexOf("ПЕРЕВЕДИ");
  const part = at >= 0 ? text.slice(at) : text;
  const out: Array<{ idx: number; text: string }> = [];
  const re = /⟦(\d+)⟧\s*([\s\S]*?)(?=⟦\d+⟧|$)/g;
  for (const m of part.matchAll(re)) out.push({ idx: Number(m[1]), text: m[2].trim() });
  return out;
}

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startMockAnthropic(): Promise<{ url: string; calls: MockCall[]; close(): Promise<void> }> {
  const calls: MockCall[] = [];
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: path.split("/").pop(), type: "model", display_name: "mock", created_at: "2026-01-01T00:00:00Z" }));
      return;
    }
    if (req.method !== "POST" || !path.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "nope" } }));
      return;
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const model = String(body.model);
    const stream = Boolean(body.stream);
    calls.push({ path, model, stream, body });
    const text = userText(body);

    if (!stream) {
      // Разбор терминов: structured outputs, ответ — JSON в текстовом блоке.
      const terms = Object.entries(KNOWN_NAMES)
        .filter(([en]) => new RegExp(`\\b${en}\\b`).test(text))
        .map(([en, v]) => ({ en, ru: v.ru, kind: "name", gender: v.gender, aliases: [], note: null }));
      const addresses = terms.length >= 2 ? [{ from: terms[0].en, to: terms[1].en, form: "ty" }] : [];
      const json = { terms, addresses, narrator: { person: "third", gender: null }, register: "live" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_extract",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: JSON.stringify(json) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 150 },
        }),
      );
      return;
    }

    const paras = labelled(text);
    const refuse = paras.some((p) => p.text.includes("REFUSE_ME")) && !model.includes("opus");
    const truncate = paras.some((p) => p.text.includes("TRUNCATE_ME")) && paras.length > 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, "message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1 } },
    });
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    let stopReason = "end_turn";
    let emitted = 0;
    for (const p of paras) {
      if (refuse) {
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `⟦${p.idx}⟧ Нача` } });
        stopReason = "refusal";
        break;
      }
      if (p.text.includes("SKIP_ME") && paras.length > 1) continue;
      const out = `⟦${p.idx}⟧ RU: ${p.text}\n\n`;
      // Метка нарочно режется между кусками потока.
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.slice(0, 2) } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.slice(2) } });
      emitted += 1;
      if (truncate && emitted === 1) {
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "⟦999⟧ оборв" } });
        stopReason = "max_tokens";
        break;
      }
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 * Math.max(1, emitted) } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
