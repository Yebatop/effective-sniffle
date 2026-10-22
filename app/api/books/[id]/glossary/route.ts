import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook } from "@/lib/db/books";
import { listAddresses, listTerms } from "@/lib/db/terms";
import { listRefTerms } from "@/lib/db/reference";
import { fail, json, serverError } from "@/lib/server/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await db();
    if (!(await getBook(d, id))) return fail(404, "not_found", "Книга не найдена.");
    const [terms, addresses, refTerms] = await Promise.all([listTerms(d, id), listAddresses(d, id), listRefTerms(d, id)]);
    return json({ terms, addresses, refTerms });
  } catch (e) {
    return serverError(e);
  }
}
