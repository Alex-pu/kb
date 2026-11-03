import type { Metadata } from "next";
import "./globals.css";
import { OfflineSyncBootstrap } from "@/components/layout/OfflineSyncBootstrap";
import { AuthGate } from "@/components/layout/AuthGate";

export const metadata: Metadata = {
  title: "Kore Bench | Hospitality, Retail & Property Operations",
  description: "A web-based operations platform for hospitality and retail businesses in Kenya.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-neutral-100 dark:bg-neutral-950 font-sans antialiased text-neutral-900 dark:text-neutral-100">
        <OfflineSyncBootstrap />
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
