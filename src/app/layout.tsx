import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "The Frame — Wholesale CRM",
  description: "AI-powered wholesale CRM for Jaxy Eyewear",
  // Without this, mobile Safari auto-detects postal addresses and phone
  // numbers in plain text and renders them as underlined links we did not
  // author and cannot style — sitting next to real links, so nothing on the
  // page reads as trustworthy. Where a number should be tappable we author an
  // explicit <a href="tel:">.
  formatDetection: { telephone: false, address: false, email: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
