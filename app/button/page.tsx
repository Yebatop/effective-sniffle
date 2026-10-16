import type { Metadata } from "next";
import ButtonScreen from "@/components/screens/ButtonScreen";

export const metadata: Metadata = { title: "Кнопка для сайтов" };

export default function ButtonPage() {
  return <ButtonScreen />;
}
