import type { Metadata } from "next";
import SpendScreen from "@/components/screens/SpendScreen";

export const metadata: Metadata = { title: "Расходы" };

export default function SpendPage() {
  return <SpendScreen />;
}
