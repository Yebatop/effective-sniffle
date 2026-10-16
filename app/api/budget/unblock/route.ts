import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { unblockJobs } from "@/lib/db/jobs";
import { relaySecret } from "@/lib/server/worker";
import { json, originOf, serverError } from "@/lib/server/http";

export async function POST(req: NextRequest) {
  try {
    const d = await db();
    const ids = await unblockJobs(d);
    const origin = originOf(req);
    const secret = await relaySecret(d);
    // Каждую задачу — отдельным вызовом через эстафету: две главы в одном
    // вызове не уложатся в 5 минут, и вторую оборвало бы посреди перевода.
    await Promise.all(
      ids.map((jobId) =>
        fetch(`${origin}/api/jobs/run`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-relay-secret": secret },
          body: JSON.stringify({ jobId }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined),
      ),
    );
    return json({ unblocked: ids.length });
  } catch (e) {
    return serverError(e);
  }
}
