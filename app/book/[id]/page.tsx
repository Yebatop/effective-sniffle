import type { Metadata } from "next";
import BookScreen from "@/components/screens/BookScreen";

export const metadata: Metadata = { title: "Книга" };

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookScreen key={id} bookId={id} />;
}
