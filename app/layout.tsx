import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
import "./game-theme.css";
import "./warstate-redesign.css";

export const metadata: Metadata = {
  title: "WARSTATE",
  description: "WARSTATE — Telegram strategy game where chats become states on a shared continent.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#1d1c17",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        {children}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
