import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // linkedom и pg — серверные пакеты, их не нужно собирать в бандл.
  serverExternalPackages: ["pg", "linkedom"],
  poweredByHeader: false,
};

export default nextConfig;
