import type { Metadata, Viewport } from "next";
import { preload } from "react-dom";
import "./globals.css";
import { THEME_BOOT_SCRIPT, THEME_CHROME_COLORS } from "./theme";

export const metadata: Metadata = {
  title: "LEVO Studio — تجهيز ملفات الطباعة",
  description:
    "محرر ثلاثي الأبعاد وسلايسر محلي في المتصفح من LEVONIS: استيراد المجسمات، الترتيب على عدة ألواح، التقطيع محليًا عبر WebAssembly، وتجهيز مشروع 3MF لرفعه يدويًا إلى MakerWorld.",
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
    description:
      "LEVONIS in-browser plate editor and local slicer: import models, arrange plates, slice locally with WebAssembly, and prepare a 3MF project for manual MakerWorld upload.",
    type: "website",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "LEVO Studio",
    description:
      "LEVONIS in-browser plate editor and local slicer with Arabic-first ar/en/ckb UI.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  /**
   * The colour the BROWSER paints its own chrome — the Android address bar,
   * the iOS status area, the task switcher.
   *
   * It was #0A1410 long after the app became black: the old olive, sitting in
   * a strip directly above a pure-black application, which is the one place a
   * tint is impossible to miss. The surfaces moved and the frame around them
   * did not.
   *
   * There are two themes now (app/theme.ts), so there are two colours, each
   * the page ground of its theme. The media pair covers the `system` choice
   * before any script runs; THEME_BOOT_SCRIPT rewrites both when the person
   * pinned light or dark on this device.
   */
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: THEME_CHROME_COLORS.dark },
    { media: "(prefers-color-scheme: light)", color: THEME_CHROME_COLORS.light },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Applies the persisted locale before hydration so en (LTR) or ckb users do
 * not see an ar/rtl flash. Mirrors i18n/index.ts: key `levo-studio-locale`,
 * valid values ar|en|ckb, en is the only LTR chrome. Kept dependency-free and
 * inline (same-origin; the worker CSP currently allows inline scripts).
 */
const LOCALE_BOOT_SCRIPT = `try{var l=localStorage.getItem("levo-studio-locale");if(l==="en"||l==="ckb"||l==="ar"){var d=document.documentElement;d.lang=l;d.dir=l==="en"?"ltr":"rtl";}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The Arabic subset of the self-hosted Cairo is wanted by the first frame
  // (the boot screen is Arabic), so it is fetched with the document rather
  // than after the stylesheet is parsed.
  preload("/fonts/cairo/cairo-v31-arabic.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  // Arabic is the default locale and RTL is the default chrome direction;
  // the boot script above re-applies a persisted choice before first paint.
  //
  // `data-theme="dark"` is the server's guess; the theme boot script replaces
  // it with the stored choice (or the system one) before first paint, and
  // suppressHydrationWarning tells React that difference is intended.
  return (
    <html lang="ar" dir="rtl" data-theme="dark" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
