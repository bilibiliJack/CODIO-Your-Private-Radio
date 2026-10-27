import type { Metadata } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const previewImage = `${protocol}://${host}/og.png`;

  return {
    title: "CODIO - Private Radio",
    description: "A private radio that slowly learns the way you listen.",
    icons: {
      icon: [{ url: "/codio-icon.png", type: "image/png", sizes: "512x512" }],
      shortcut: "/codio-icon.png",
      apple: [{ url: "/codio-icon.png", type: "image/png", sizes: "512x512" }],
    },
    openGraph: {
      title: "CODIO - Private Radio",
      description: "Familiar enough to stay. New enough to feel alive.",
      images: [{ url: previewImage, width: 1672, height: 941, alt: "CODIO cloud cover" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "CODIO - Private Radio",
      description: "Familiar enough to stay. New enough to feel alive.",
      images: [previewImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={GeistSans.variable}>
      <body className={GeistSans.className}>{children}</body>
    </html>
  );
}
