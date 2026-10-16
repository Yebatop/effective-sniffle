// Поддельный сервер Anthropic отдельным процессом — для сквозной проверки в браузере.
import { startMockAnthropic } from "../server/mock-anthropic.ts";

const mock = await startMockAnthropic();
console.log(mock.url);
process.on("SIGTERM", () => mock.close().then(() => process.exit(0)));
