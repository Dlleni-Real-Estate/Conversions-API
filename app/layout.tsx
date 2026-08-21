import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dlleni · Lead Pipeline",
  description: "Lead quality tracking with Meta Conversions API feedback",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
