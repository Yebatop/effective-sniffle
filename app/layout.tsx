import type { Metadata, Viewport } from "next";
import { Golos_Text, Literata, Prata } from "next/font/google";
import "./globals.css";
import AppNav from "@/components/AppNav";
import UpdateBanner from "@/components/UpdateBanner";
import SwRegister from "@/components/SwRegister";
import { BOOT_SCRIPT } from "@/lib/client/prefs";

const ui = Golos_Text({
  subsets: ["cyrillic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

const read = Literata({
  subsets: ["cyrillic", "latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-read",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

const display = Prata({
  subsets: ["cyrillic", "latin"],
  weight: ["400"],
  variable: "--font-display",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

export const metadata: Metadata = {
  title: { default: "Толмач", template: "%s · Толмач" },
  description: "Личный переводчик веб-новелл с английского на русский.",
  applicationName: "Толмач",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Толмач", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#14120f",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ru"
      data-theme="night"
      suppressHydrationWarning
      className={`${ui.variable} ${read.variable} ${display.variable}`}
    >
      <head>
        {/* Тема до первой отрисовки + ранний приём сигнала кнопки «Т». */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        <div className="app-main">{children}</div>
        <AppNav />
        <UpdateBanner />
        <SwRegister />
      </body>
    </html>
  );
}
