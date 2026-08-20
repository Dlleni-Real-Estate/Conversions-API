import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dlleni — لوحة الليدز و Conversions API",
  description: "تتبّع جودة الليدز وإرجاع الإشارة لميتا",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
