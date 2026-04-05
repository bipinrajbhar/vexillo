import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { auth } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Vexillo",
  description: "Internal feature flag management",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-gray-900">
        <header className="border-b border-gray-200 px-6 py-3 flex items-center gap-8">
          <span className="font-bold text-gray-900 tracking-tight">vexillo</span>
          <nav className="flex gap-6 text-sm">
            <Link href="/" className="text-gray-600 hover:text-gray-900 transition-colors">
              Flags
            </Link>
            <Link href="/environments" className="text-gray-600 hover:text-gray-900 transition-colors">
              Environments
            </Link>
            {session?.user.role === 'admin' && (
              <Link href="/members" className="text-gray-600 hover:text-gray-900 transition-colors">
                Members
              </Link>
            )}
          </nav>
          {session && (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-sm text-gray-500">{session.user.email}</span>
              <SignOutButton />
            </div>
          )}
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
