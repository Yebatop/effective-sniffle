import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { unblockJobs } from "@/lib/db/jobs";
import { unblockGlossaryJobs } from "@/lib/db/glossary-jobs";
import { relaySecret } from "@/lib/server/worker";
import { json, originOf, serverError } from "@/lib/server/http";

export async function POST(req: NextRequest) {
  try {
    const d = await db();
    const ids = await unblockJobs(d);
    const glossaryIds = await unblockGlossaryJobs(d);
    const origin = originOf(req);
    const secret = await relaySecret(d);
    const kick = (path: string, jobId: string) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-secret": secret },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    // Каждую задачу — отдельным вызовом через эстафету: две главы в одном
    // вызове не уложатся в 5 минут, и вторую оборвало бы посреди перевода.
    await Promise.all([...ids.map((id) => kick("/api/jobs/run", id)), ...glossaryIds.map((id) => kick("/api/glossary/run", id))]);
    return json({ unblocked: ids.length + glossaryIds.length });
  } catch (e) {
    return serverError(e);
  }
}
