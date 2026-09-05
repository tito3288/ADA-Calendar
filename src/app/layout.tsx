import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ADA Calendar · Room for the work",
  description: "A clear view of Bryan's work, time, and commitments.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
