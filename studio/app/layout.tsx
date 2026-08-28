import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  themeColor: "#0A1410",
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
  // Arabic is the default locale and RTL is the default chrome direction;
  // the boot script above re-applies a persisted choice before first paint.
  return (
    <html lang="ar" dir="rtl">
      <body>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
