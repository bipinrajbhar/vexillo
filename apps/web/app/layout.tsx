import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { getServerSession } from "@/lib/session";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata: Metadata = {
  title: "Vexillo",
  description: "Internal feature flag management",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  const shellSession = session
    ? {
      user: {
        email: session.user.email,
        role: session.user.role ?? null,
      },
    }
    : null;

  return (
    <html
      lang="en"
      className={`h-full antialiased ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh flex flex-col bg-background font-sans text-foreground">
        <ThemeProvider>
          <AppShell session={shellSession}>{children}</AppShell>
        </ThemeProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
