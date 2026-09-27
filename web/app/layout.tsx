import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { GetSheet } from "@/components/site/GetSheet";
import { SITE_ORIGIN } from "@/lib/site";

/** Switzer (Fontshare, ITF Free Font License): 200 for display, 300 italic for the one accent word, 300 to 500 for text. */
const text = localFont({
  src: [
    { path: "./fonts/Switzer-200.woff2", weight: "200", style: "normal" },
    { path: "./fonts/Switzer-300.woff2", weight: "300", style: "normal" },
    { path: "./fonts/Switzer-300i.woff2", weight: "300", style: "italic" },
    { path: "./fonts/Switzer-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Switzer-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-text",
  display: "swap",
  preload: true,
});

/** Captions: Fragment Mono (SIL Open Font License, via Fontsource). */
const mono = localFont({
  src: [{ path: "./fonts/FragmentMono-400.woff2", weight: "400", style: "normal" }],
  variable: "--font-mono-face",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: "Ghostkeys: your MacBook has more buttons",
  description:
    "Ghostkeys turns the palm rests, speaker grilles, edges and lid of your MacBook into buttons you program, using the motion sensor already inside. On-device, no extra hardware.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Ghostkeys",
    description: "The blank space is the interface. Tap your MacBook's palm rests, grilles, edges and lid to run anything.",
    type: "website",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "Ghostkeys: a MacBook whose palm rests, grilles, edges and lid are buttons." }],
  },
  twitter: { card: "summary_large_image", images: ["/og.jpg"] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#f4f4f1" },
  ],
};

/** Runs before paint so the stored or system theme applies without a flash. */
const themeScript = `(function(){document.documentElement.classList.add('js');if(/[?&]reduced/.test(location.search))document.documentElement.classList.add('reduced');try{var p=localStorage.getItem('gk-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=(p==='light'||p==='dark')?p:(d?'dark':'light');document.documentElement.dataset.theme=t;document.documentElement.dataset.themePref=p||'system';}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${text.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div id="gk-root">{children}</div>
        <GetSheet />
      </body>
    </html>
  );
}
