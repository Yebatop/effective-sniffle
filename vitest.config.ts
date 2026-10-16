import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Тесты базы ходят в одну БД — запускаем файлы последовательно.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
