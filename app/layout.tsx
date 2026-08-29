import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://field.tokendance.cool"),
  title: { default: "FIELD · Evidence OS", template: "%s · FIELD" },
  description: "把联网检索、来源原文、交叉验证与关系判断沉淀成可追溯的证据网络。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "FIELD · Evidence OS",
    description: "从一句线索，到可追溯的证据网络。",
    images: [{ url: "/og.png", width: 1730, height: 909, alt: "TokenDance Field 局部判断闭环" }],
  },
  twitter: { card: "summary_large_image", title: "FIELD · Evidence OS", description: "从一句线索，到可追溯的证据网络。", images: ["/og.png"] },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
