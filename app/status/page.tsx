import type { Metadata } from "next";
import StatusScreen from "@/components/screens/StatusScreen";

export const metadata: Metadata = { title: "Проверка" };

export default function StatusPage() {
  return <StatusScreen />;
}
