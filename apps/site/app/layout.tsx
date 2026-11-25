import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "./_components/Chrome";
import "./globals.css";

// DESIGN.md, Type. next/font serves both from this site, so a visit makes no request to Google.
const ui = Atkinson_Hyperlegible_Next({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "700"],
  variable: "--font-ui",
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://uplinkroom.com"),
  title: { default: "Uplink Room", template: "%s | Uplink Room" },
  description:
    "Uplink Room is a desktop app for teams that work with coding agents. It connects the agents you already use to channels, calls and projects, and gives each person one Inbox of what needs them.",
  applicationName: "Uplink Room",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#121315" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to the content
        </a>
        <div className="page">
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
