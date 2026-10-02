"use client";

// ResearchDashboard はブラウザの localStorage を使うので、サーバーでは描画せずブラウザだけで表示する。
import dynamic from "next/dynamic";

const ResearchDashboard = dynamic(() => import("./ResearchDashboard"), {
  ssr: false,
  loading: () => <p className="p-8 text-sm opacity-70">読み込み中…</p>,
});

export default function ClientOnlyResearch() {
  return <ResearchDashboard />;
}
