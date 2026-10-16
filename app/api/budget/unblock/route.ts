import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { unblockJobs } from "@/lib/db/jobs";
import { runJob } from "@/lib/server/worker";
import { json, originOf, serverError } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const ids = await unblockJobs(await db());
    const origin = originOf(req);
    // Каждую задачу — своим вызовом через эстафету: несколько глав подряд не уложатся в один заход.
    after(async () => {
      for (const id of ids) await runJob(id, { origin }).catch((e) => console.error("runJob", e));
    });
    return json({ unblocked: ids.length });
  } catch (e) {
    return serverError(e);
  }
}
