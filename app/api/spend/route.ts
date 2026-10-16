import { db } from "@/lib/db/client";
import { getSettings } from "@/lib/db/misc";
import { budgetState, recentCalls, spendByBook } from "@/lib/db/money";
import { json, serverError } from "@/lib/server/http";

export async function GET() {
  try {
    const d = await db();
    const settings = await getSettings(d);
    const [budget, byBook, recent] = await Promise.all([
      budgetState(d, settings.monthlyLimitRub / settings.usdRub),
      spendByBook(d),
      recentCalls(d, 30),
    ]);
    return json({
      budget,
      byBook,
      recent: recent.map((c) => ({
        createdAt: c.createdAt,
        chapterId: c.chapterId,
        chapterTitle: c.chapterTitle,
        bookId: c.bookId,
        model: c.model,
        usd: c.usd,
        purpose: c.purpose,
        batch: c.batch,
      })),
    });
  } catch (e) {
    return serverError(e);
  }
}
