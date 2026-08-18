// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

// Fonts are vendored locally (app/fonts, latin subset matching the prior
// next/font/google output) so the production build has ZERO build-time
// dependency on fonts.googleapis.com / fonts.gstatic.com. NAS → Google was
// flaky and intermittently failed `pnpm build` with connect ETIMEDOUT. Geist
// and JetBrains Mono are variable woff2 (weight range); IBM Plex Sans ships the
// four static weights it actually uses.

const geist = localFont({
  variable: "--font-heading",
  display: "swap",
  src: [{ path: "./fonts/Geist-latin.woff2", weight: "100 900", style: "normal" }],
});

const ibmPlexSans = localFont({
  variable: "--font-body",
  display: "swap",
  src: [
    { path: "./fonts/IBMPlexSans-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexSans-500-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexSans-600-latin.woff2", weight: "600", style: "normal" },
    { path: "./fonts/IBMPlexSans-700-latin.woff2", weight: "700", style: "normal" },
  ],
});

const jetbrainsMono = localFont({
  variable: "--font-mono",
  display: "swap",
  src: [{ path: "./fonts/JetBrainsMono-latin.woff2", weight: "100 800", style: "normal" }],
});

const themeScript = `
try {
  var t = localStorage.getItem('fonto-theme');
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch(e) {}
`.trim();

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2AB0A5",
};

export const metadata: Metadata = {
  title: "Fonto",
  description: "Everything flows here. Photos and documents, unified.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Fonto",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${ibmPlexSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
