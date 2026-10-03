import type { Metadata } from "next";
import ClientOnlyResearch from "@/components/ClientOnlyResearch";

export const metadata: Metadata = { title: "価格差リサーチ" };

export default function Home() {
  return <ClientOnlyResearch />;
}
