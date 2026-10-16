import { db } from "@/lib/db/client";
import { listBooks } from "@/lib/db/books";
import { json, serverError } from "@/lib/server/http";

export async function GET() {
  try {
    return json(await listBooks(await db()));
  } catch (e) {
    return serverError(e);
  }
}
