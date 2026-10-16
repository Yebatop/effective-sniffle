import type { Metadata } from "next";
import AddScreen from "@/components/screens/AddScreen";

export const metadata: Metadata = { title: "Добавить главу" };

export default function AddPage() {
  return <AddScreen />;
}
