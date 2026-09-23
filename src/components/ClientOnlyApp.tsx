"use client";

// PriceGapApp はブラウザの localStorage を使うので、サーバーでは描画せずブラウザだけで表示する。
import dynamic from "next/dynamic";

const PriceGapApp = dynamic(() => import("./PriceGapApp"), {
  ssr: false,
  loading: () => <p className="p-8 text-sm opacity-70">読み込み中…</p>,
});

export default function ClientOnlyApp() {
  return <PriceGapApp />;
}
