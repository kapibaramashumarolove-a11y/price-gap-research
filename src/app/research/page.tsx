import type { Metadata } from "next";
import ClientOnlyResearch from "@/components/ClientOnlyResearch";

export const metadata: Metadata = { title: "自動リサーチ | 価格差リサーチ" };

export default function ResearchPage() {
  return <ClientOnlyResearch />;
}
