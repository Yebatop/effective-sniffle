import type { Metadata } from "next";
import ReadyReader from "@/components/reader/ReadyReader";

export const metadata: Metadata = { title: "Готовый перевод" };

export default async function ReadyPage({ params }: { params: Promise<{ id: string; number: string }> }) {
  const { id, number } = await params;
  // key: каждая глава — новый экземпляр, без остатков прошлой.
  return <ReadyReader key={`${id}:${number}`} bookId={id} number={Number(number)} />;
}
