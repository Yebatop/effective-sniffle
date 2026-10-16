import type { Metadata } from "next";
import Reader from "@/components/reader/Reader";

export const metadata: Metadata = { title: "Читалка" };

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // key: каждая глава — новый экземпляр читалки, без остатков прошлой.
  return <Reader key={id} chapterId={id} />;
}
