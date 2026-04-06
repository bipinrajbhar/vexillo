import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { getServerSession } from "@/lib/session";

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
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-dvh flex flex-col bg-background text-foreground">
        <ThemeProvider>
          <AppShell session={shellSession}>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
