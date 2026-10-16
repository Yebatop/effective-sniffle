import type { Metadata } from "next";
import ShareScreen from "@/components/screens/ShareScreen";

export const metadata: Metadata = { title: "Поделиться" };

function one(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  return (
    <ShareScreen
      pending={one(sp.pending) === "1"}
      failed={one(sp.failed) === "1"}
      text={one(sp.text)}
      url={one(sp.url)}
      title={one(sp.title)}
    />
  );
}
