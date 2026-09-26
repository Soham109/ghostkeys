import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/** Display: Zodiak (Fontshare, ITF Free Font License). Light weight for large type, italic for one accent word. */
const display = localFont({
  src: [
    { path: "./fonts/Zodiak-300.woff2", weight: "300", style: "normal" },
    { path: "./fonts/Zodiak-300i.woff2", weight: "300", style: "italic" },
    { path: "./fonts/Zodiak-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Zodiak-400i.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
  preload: true,
});

/** Text: Switzer (Fontshare, ITF Free Font License). */
const text = localFont({
  src: [
    { path: "./fonts/Switzer-300.woff2", weight: "300", style: "normal" },
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
  title: "Ghostkeys: your laptop has more buttons",
  description:
    "Ghostkeys turns the palm rests, speaker grilles, edges and lid of your MacBook into buttons you program, using the motion sensor already inside. On-device, no extra hardware.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Ghostkeys",
    description: "The blank space is the interface. Tap your MacBook's palm rests, grilles, edges and lid to run anything.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#f4f4f1" },
  ],
};

/** Runs before paint so the stored or system theme applies without a flash. */
const themeScript = `(function(){try{var p=localStorage.getItem('gk-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=(p==='light'||p==='dark')?p:(d?'dark':'light');document.documentElement.dataset.theme=t;document.documentElement.dataset.themePref=p||'system';}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${display.variable} ${text.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div id="gk-root">{children}</div>
      </body>
    </html>
  );
}
