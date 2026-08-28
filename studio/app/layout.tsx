import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LEVO Studio — Browser Plate Editor & Slicer",
  description: "A shared web and mobile plate editor, local slicer, and verified Bambu print handoff for X2D and H2D profiles.",
  applicationName: "LEVO Studio",
  authors: [{ name: "LEVONIS" }],
  creator: "LEVONIS",
  publisher: "LEVONIS",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "LEVO Studio",
    description: "One LEVO workspace for web, iOS and Android with local slicing and capability-gated Bambu connections.",
    type: "website",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "LEVO Studio",
    description: "One LEVO workspace for web, iOS and Android with local slicing and capability-gated Bambu connections.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
