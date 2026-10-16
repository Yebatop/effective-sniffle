import type { NextConfig } from "next";
import pkg from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  // linkedom и pg — серверные пакеты, их не нужно собирать в бандл.
  serverExternalPackages: ["pg", "linkedom"],
  poweredByHeader: false,
  // Версия сборки вшивается в страницу: плашка «Есть новая версия»
  // сравнивает её с ответом /api/version.
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  },
};

export default nextConfig;
