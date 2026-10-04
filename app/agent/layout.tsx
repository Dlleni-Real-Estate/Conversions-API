import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Dlleni · Agent",
  description: "Leads routed to you, the moment they arrive.",
};

// No pinch-zoom: this is an app screen inside the Android shell, and a
// double-tap zoom on a call button is a missed call.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#ffffff",
};

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
