import type { Metadata } from "next";
import GlossaryScreen from "@/components/screens/GlossaryScreen";

export const metadata: Metadata = { title: "Глоссарий" };

export default async function GlossaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GlossaryScreen key={id} bookId={id} />;
}
