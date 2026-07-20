import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "ConvertRail — Settlement Console",
  description: "A neutral settlement rail for performance marketing on Arc.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
