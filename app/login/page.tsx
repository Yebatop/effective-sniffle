import type { Metadata } from "next";
import LoginScreen from "@/components/screens/LoginScreen";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const next = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  return <LoginScreen next={next ?? null} />;
}
