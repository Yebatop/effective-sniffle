import { json } from "@/lib/server/http";

export function GET() {
  return json({
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
    commit: process.env.NEXT_PUBLIC_COMMIT ?? null,
  });
}
