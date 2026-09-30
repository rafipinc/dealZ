// Placeholder until phase 3 delivers the public pages (ARCHITECTURE.md section 10).
import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">DealZ</h1>
      <p className="text-zinc-600">
        Price history and curated deals for consumer tech in Australia.
      </p>
      {process.env.NODE_ENV !== "production" && (
        <Link href="/lab" className="text-sm text-zinc-700 underline dark:text-zinc-300">
          Lab: live price fetch
        </Link>
      )}
    </main>
  );
}
