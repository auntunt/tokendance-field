import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://field.tokendance.cool"),
  title: "TokenDance Field · 局部判断系统",
  description: "把情报转化为有边界、可证伪、能行动、会校准的专家判断。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "TokenDance Field",
    description: "情报进入具体世界，才成为判断。",
    images: [{ url: "/og.png", width: 1730, height: 909, alt: "TokenDance Field 局部判断闭环" }],
  },
  twitter: { card: "summary_large_image", title: "TokenDance Field", description: "情报进入具体世界，才成为判断。", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
