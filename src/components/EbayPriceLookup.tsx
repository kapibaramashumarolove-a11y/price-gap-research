"use client";

// 型番やキーワードで eBay の出品中の価格を調べ、結果を「eBay 販売価格」欄に反映する部品。
// eBay への問い合わせはサーバー側（/api/ebay/search）が行う。

import { useState } from "react";
import type { EbayPriceSummary } from "@/lib/ebayStats";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export default function EbayPriceLookup({
  defaultKeyword,
  onApplyPrice,
}: {
  /** キーワード欄が空のときに使う値（型番 → 商品名の順） */
  defaultKeyword: string;
  /** 「〜を入れる」を押したときに呼ばれる */
  onApplyPrice: (priceUsd: number) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EbayPriceSummary | null>(null);

  const query = keyword.trim() || defaultKeyword.trim();

  async function handleSearch() {
    if (query === "") {
      setError("型番・商品名、または検索キーワードを入力してください。");
      return;
    }
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/ebay/search?${new URLSearchParams({ q: query })}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "eBay の価格を取得できませんでした。");
        return;
      }
      setSummary(json as EbayPriceSummary);
    } catch {
      setError("サーバーに接続できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-dashed border-black/20 p-3 text-sm sm:col-span-2 lg:col-span-4 dark:border-white/25">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-60 flex-1 flex-col gap-1">
          <span>eBay 検索キーワード（空欄なら型番 → 商品名で検索）</span>
          <input
            type="text"
            value={keyword}
            placeholder={defaultKeyword || "例: DD1391-100"}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              // Enter でフォーム全体が送信（追加）されないようにし、検索を実行する
              if (e.key === "Enter") {
                e.preventDefault();
                handleSearch();
              }
            }}
            className="rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/25"
          />
        </label>
        <button
          type="button"
          onClick={handleSearch}
          disabled={loading}
          className="rounded border border-black/30 px-3 py-1.5 font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/30 dark:hover:bg-white/10"
        >
          {loading ? "検索中…" : "eBay の出品価格を調べる"}
        </button>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {summary && (
        <div className="space-y-2">
          {summary.environment === "sandbox" && (
            <p className="text-xs text-amber-600">
              ※ Sandbox（テスト用）環境の結果です。実際の相場ではありません。
            </p>
          )}
          {summary.count === 0 || summary.medianUsd === null || summary.minUsd === null ? (
            <p className="opacity-70">「{summary.query}」の出品（新品・即決・USD）は見つかりませんでした。</p>
          ) : (
            <>
              <p>
                「{summary.query}」の出品中 {summary.count} 件
                {summary.totalFound > summary.count && `（全 ${summary.totalFound} 件中）`}：
                中央値 <strong>{usd.format(summary.medianUsd)}</strong> / 最安値{" "}
                <strong>{usd.format(summary.minUsd)}</strong>
                {summary.maxUsd !== null && <> / 最高値 {usd.format(summary.maxUsd)}</>}
              </p>
              <div className="flex flex-wrap gap-2">
                <ApplyButton label="中央値を入れる" onClick={() => onApplyPrice(roundCents(summary.medianUsd!))} />
                <ApplyButton label="最安値を入れる" onClick={() => onApplyPrice(roundCents(summary.minUsd!))} />
              </div>
              <details>
                <summary className="cursor-pointer opacity-70">安い順の出品を確認する</summary>
                <ul className="mt-1 space-y-1">
                  {summary.samples.map((l) => (
                    <li key={l.url || l.title}>
                      {usd.format(l.priceUsd)}
                      {l.shippingUsd !== null && (
                        <span className="opacity-60">
                          {" "}
                          (送料 {l.shippingUsd === 0 ? "無料" : usd.format(l.shippingUsd)})
                        </span>
                      )}{" "}
                      —{" "}
                      {l.url ? (
                        <a href={l.url} target="_blank" rel="noopener noreferrer" className="underline">
                          {l.title}
                        </a>
                      ) : (
                        l.title
                      )}
                    </li>
                  ))}
                </ul>
              </details>
              <p className="text-xs opacity-60">
                ※ 出品中の価格（売れた価格ではありません）です。型番違い・偽物・箱のみ等の出品が混ざることがあるので、上の一覧で確認してください。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ApplyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-90"
    >
      {label}
    </button>
  );
}

/** セント（小数第 2 位）までに丸める */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
