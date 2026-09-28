"use client";

// 画面本体。入力・ボタン操作があるので Client Component にしている。
// データはブラウザの localStorage に保存する（このブラウザだけで使える簡易保存）。

import { useEffect, useMemo, useState } from "react";
import {
  calculateProfit,
  DEFAULT_SETTINGS,
  type Item,
  type Settings,
} from "@/lib/profit";
import type { ActiveListingPrices } from "@/lib/ebay";
import { conditionLabel } from "@/lib/ebayConditions";

const ITEMS_KEY = "price-gap:items";
const SETTINGS_KEY = "price-gap:settings";

type ItemForm = Record<Exclude<keyof Item, "id">, string>;

const EMPTY_FORM: ItemForm = {
  name: "",
  sku: "",
  size: "",
  snkrdunkPriceJpy: "",
  snkrdunkExtraJpy: "0",
  ebayPriceUsd: "",
  ebayShippingChargedUsd: "0",
};

const SETTING_FIELDS: { key: keyof Settings; label: string; unit: string }[] = [
  { key: "usdJpy", label: "為替レート", unit: "円 / USD" },
  { key: "ebayFeeRate", label: "eBay 落札手数料", unit: "%" },
  { key: "internationalFeeRate", label: "海外取引手数料", unit: "%" },
  { key: "perOrderFeeUsd", label: "1注文あたり固定手数料", unit: "USD" },
  { key: "internationalShippingJpy", label: "国際送料", unit: "円" },
];

type MarketState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; data: ActiveListingPrices };

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境（プライベートモード等）でも画面は動かす
  }
}

/** 0 以上の数値として読めれば数値、読めなければ null */
function toNonNegativeNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function PriceGapApp() {
  // ブラウザ専用で表示しているので、最初から保存済みデータを読み込める
  const [items, setItems] = useState<Item[]>(() => loadJson<Item[]>(ITEMS_KEY) ?? []);
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadJson<Partial<Settings>>(SETTINGS_KEY),
  }));
  // 設定欄の入力中の文字列（入力途中の空欄なども表示できるように文字列で持つ）
  const [settingInputs, setSettingInputs] = useState<Record<keyof Settings, string>>(() =>
    Object.fromEntries(
      Object.entries(settings).map(([k, v]) => [k, String(v)]),
    ) as Record<keyof Settings, string>,
  );
  const [form, setForm] = useState<ItemForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketState>({ status: "idle" });

  // 変更があるたびに保存する
  useEffect(() => saveJson(ITEMS_KEY, items), [items]);
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings]);

  // 利益の大きい順に並べる
  const rows = useMemo(
    () =>
      items
        .map((item) => ({ item, result: calculateProfit(item, settings) }))
        .sort((a, b) => b.result.profitJpy - a.result.profitJpy),
    [items, settings],
  );

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (form.name.trim() === "") {
      setError("商品名を入力してください。");
      return;
    }
    const numbers = {
      snkrdunkPriceJpy: toNonNegativeNumber(form.snkrdunkPriceJpy),
      snkrdunkExtraJpy: toNonNegativeNumber(form.snkrdunkExtraJpy),
      ebayPriceUsd: toNonNegativeNumber(form.ebayPriceUsd),
      ebayShippingChargedUsd: toNonNegativeNumber(form.ebayShippingChargedUsd),
    };
    if (Object.values(numbers).some((n) => n === null)) {
      setError("価格・送料には 0 以上の数値を入力してください。");
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: form.name.trim(),
        sku: form.sku.trim(),
        size: form.size.trim(),
        ...(numbers as Record<keyof typeof numbers, number>),
      },
    ]);
    setForm(EMPTY_FORM);
    setError(null);
    setMarket({ status: "idle" });
  }

  /** eBay の出品中価格をサーバー経由（/api/ebay/search）で取得する。キーワードは型番優先、なければ商品名 */
  async function handleFetchMarket() {
    const q = [form.sku.trim() || form.name.trim(), form.size.trim() && `size ${form.size.trim()}`]
      .filter(Boolean)
      .join(" ");
    if (!form.sku.trim() && !form.name.trim()) {
      setMarket({ status: "error", message: "型番か商品名を入力してから取得してください。" });
      return;
    }
    setMarket({ status: "loading" });
    try {
      const res = await fetch(`/api/ebay/search?q=${encodeURIComponent(q)}`);
      if (res.status === 401) {
        // ログインの期限切れなど。ページを開き直すとログイン画面に移る
        window.location.reload();
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setMarket({ status: "error", message: body.error ?? `取得に失敗しました（HTTP ${res.status}）。` });
        return;
      }
      setMarket({ status: "done", data: body as ActiveListingPrices });
    } catch {
      setMarket({ status: "error", message: "サーバーに接続できませんでした。" });
    }
  }

  function handleSettingChange(key: keyof Settings, value: string) {
    setSettingInputs((prev) => ({ ...prev, [key]: value }));
    const n = toNonNegativeNumber(value);
    if (n !== null) setSettings((prev) => ({ ...prev, [key]: n }));
  }


  function handleDelete(item: Item) {
    if (!window.confirm(`「${item.name}」を削除しますか？`)) return;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:space-y-8 sm:py-8">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">スニダン → eBay 価格差リサーチ</h1>
          <form method="post" action="/api/logout" className="shrink-0">
            <button type="submit" className="min-h-11 px-2 text-sm underline opacity-70 active:opacity-100">
              ログアウト
            </button>
          </form>
        </div>
        <p className="text-sm opacity-80">
          スニダンで確認した仕入れ価格と、eBay での想定販売価格から利益を計算します。
          <span className="hidden sm:inline">
            eBay の価格は公式 Browse API で出品中の相場を取得するか、手入力できます。
          </span>
          スニダンの情報は規約に従い、自動取得せずご自身で確認した値を入力してください。
        </p>
      </header>

      <details className="group rounded-lg border border-black/10 dark:border-white/15">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">計算条件</span>
          <span className="flex items-center gap-2 text-sm opacity-70">
            為替 {settings.usdJpy} 円/USD
            <span aria-hidden className="transition-transform group-open:rotate-180">
              ▼
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {SETTING_FIELDS.map(({ key, label, unit }) => (
              <NumberField
                key={key}
                label={
                  <>
                    {label} <span className="opacity-60">({unit})</span>
                  </>
                }
                value={settingInputs[key]}
                onChange={(v) => handleSettingChange(key, v)}
              />
            ))}
          </div>
          <p className="text-xs opacity-60">
            手数料率・送料は目安の初期値です。最新の eBay 手数料や実際の送料に合わせて変更してください。
          </p>
        </div>
      </details>

      <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="font-semibold">仕入れ候補を追加</h2>
        <form onSubmit={handleAdd} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="商品名 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <div className="grid grid-cols-[3fr_2fr] gap-3 sm:contents">
            <TextField label="型番 (SKU)" value={form.sku} onChange={(v) => setForm({ ...form, sku: v })} />
            <TextField label="サイズ" value={form.size} onChange={(v) => setForm({ ...form, size: v })} />
          </div>
          <div className="hidden lg:block" />
          <NumberField
            label="スニダン価格 (円) *"
            value={form.snkrdunkPriceJpy}
            onChange={(v) => setForm({ ...form, snkrdunkPriceJpy: v })}
          />
          <NumberField
            label="スニダン手数料・国内送料 (円)"
            value={form.snkrdunkExtraJpy}
            onChange={(v) => setForm({ ...form, snkrdunkExtraJpy: v })}
          />
          <div className="space-y-3 rounded-lg border border-dashed border-black/20 p-3 text-sm sm:col-span-2 lg:col-span-4 dark:border-white/25">
            <button
              type="button"
              onClick={handleFetchMarket}
              disabled={market.status === "loading"}
              className="min-h-12 w-full rounded-lg border border-black/30 px-4 text-base active:bg-black/5 disabled:opacity-50 sm:w-auto dark:border-white/30 dark:active:bg-white/10"
            >
              {market.status === "loading" ? "取得中…" : "eBay の出品中価格を取得"}
            </button>
            <p className="text-xs opacity-60">
              型番（なければ商品名）とサイズで eBay 公式 Browse API を検索します（即決のみ・新品のみ・USD）。
            </p>
            {market.status === "error" && <p className="text-red-600">{market.message}</p>}
            {market.status === "done" && (
              <MarketResult
                data={market.data}
                onUse={(price) => setForm({ ...form, ebayPriceUsd: String(price) })}
              />
            )}
          </div>
          <NumberField
            label="eBay 販売価格 (USD) *"
            value={form.ebayPriceUsd}
            onChange={(v) => setForm({ ...form, ebayPriceUsd: v })}
          />
          <NumberField
            label="購入者負担の送料 (USD)"
            value={form.ebayShippingChargedUsd}
            onChange={(v) => setForm({ ...form, ebayShippingChargedUsd: v })}
          />
          <div className="space-y-2 sm:col-span-2 lg:col-span-4">
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              className="min-h-12 w-full rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 sm:w-auto"
            >
              追加する
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">計算結果（利益の大きい順）</h2>
        {rows.length === 0 ? (
          <p className="text-sm opacity-70">まだ候補がありません。上のフォームから追加してください。</p>
        ) : (
          <>
            {/* スマホ：1 件ずつカードで表示 */}
            <ul className="space-y-3 md:hidden">
              {rows.map(({ item, result }) => (
                <li key={item.id} className="rounded-lg border border-black/10 p-4 dark:border-white/15">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium break-words">{item.name}</div>
                      <div className="text-xs opacity-60">
                        {[item.sku, item.size].filter(Boolean).join(" / ")}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-lg font-bold ${profitColor(result.profitJpy)}`}>
                        {yen.format(result.profitJpy)}
                      </div>
                      <div className="text-xs opacity-70">利益率 {result.marginPercent.toFixed(1)}%</div>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="opacity-70">仕入れ合計</dt>
                    <dd className="text-right">{yen.format(result.totalCostJpy)}</dd>
                    <dt className="opacity-70">eBay 売上</dt>
                    <dd className="text-right">{usd.format(result.revenueUsd)}</dd>
                    <dt className="opacity-70">eBay 手数料</dt>
                    <dd className="text-right">{usd.format(result.ebayFeesUsd)}</dd>
                    <dt className="opacity-70">入金額</dt>
                    <dd className="text-right">{yen.format(result.payoutJpy)}</dd>
                  </dl>
                  <div className="mt-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      className="min-h-11 px-2 text-sm text-red-600 underline active:opacity-70"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {/* タブレット・パソコン：表で一覧表示 */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-black/20 text-left dark:border-white/25">
                  <tr>
                    <th className="py-2 pr-2">商品</th>
                    <th className="py-2 pr-2 text-right">仕入れ合計</th>
                    <th className="py-2 pr-2 text-right">eBay 売上</th>
                    <th className="py-2 pr-2 text-right">eBay 手数料</th>
                    <th className="py-2 pr-2 text-right">入金額</th>
                    <th className="py-2 pr-2 text-right">利益</th>
                    <th className="py-2 pr-2 text-right">利益率</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ item, result }) => (
                    <tr key={item.id} className="border-b border-black/10 dark:border-white/10">
                      <td className="py-2 pr-2">
                        <div className="font-medium">{item.name}</div>
                        <div className="text-xs opacity-60">
                          {[item.sku, item.size].filter(Boolean).join(" / ")}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-right">{yen.format(result.totalCostJpy)}</td>
                      <td className="py-2 pr-2 text-right">{usd.format(result.revenueUsd)}</td>
                      <td className="py-2 pr-2 text-right">{usd.format(result.ebayFeesUsd)}</td>
                      <td className="py-2 pr-2 text-right">{yen.format(result.payoutJpy)}</td>
                      <td className={`py-2 pr-2 text-right font-semibold ${profitColor(result.profitJpy)}`}>
                        {yen.format(result.profitJpy)}
                      </td>
                      <td className="py-2 pr-2 text-right">{result.marginPercent.toFixed(1)}%</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleDelete(item)}
                          className="text-xs underline opacity-70 hover:opacity-100"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-xs opacity-60">
          ※ 計算結果は入力値と計算条件にもとづく目安です。関税・消費税還付・返品リスクなどは含みません。
        </p>
      </section>
    </main>
  );
}

function profitColor(profitJpy: number): string {
  return profitJpy >= 0 ? "text-green-600" : "text-red-600";
}

/** 入力欄の共通の見た目。16px 以上の文字にして、iPhone で入力時に画面が拡大されないようにする */
const INPUT_CLASS =
  "h-12 w-full rounded-lg border border-black/20 bg-transparent px-3 text-base dark:border-white/25";

function TextField({
  label,
  value,
  onChange,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
    </label>
  );
}

/** 数値の入力欄。スマホでは小数点つきの数字キーボードを出す（値のチェックは保存時に行う） */
function NumberField({
  label,
  value,
  onChange,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function MarketResult({
  data,
  onUse,
}: {
  data: ActiveListingPrices;
  onUse: (priceUsd: number) => void;
}) {
  return (
    <div className="space-y-2">
      <p>
        「{data.query}」の出品中価格：
        {data.environment === "sandbox" && (
          <span className="ml-2 rounded bg-yellow-200 px-1 text-xs text-black">
            Sandbox（テスト用データ）
          </span>
        )}
      </p>
      {data.count === 0 ? (
        <p className="opacity-70">該当する出品が見つかりませんでした。キーワードを変えてみてください。</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <PriceChoice label="中央値" price={data.median!} onUse={onUse} />
            <PriceChoice label="最安値" price={data.min!} onUse={onUse} />
          </div>
          <p className="text-xs opacity-60">
            {conditionLabel(data.conditionIds)} / 集計 {data.count} 件 / ヒット {data.total} 件
          </p>
        </>
      )}
    </div>
  );
}

/** 相場の値を表示し、タップすると販売価格に入れるボタン */
function PriceChoice({
  label,
  price,
  onUse,
}: {
  label: string;
  price: number;
  onUse: (priceUsd: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onUse(price)}
      className="flex min-h-14 flex-col items-center justify-center rounded-lg border border-black/20 px-4 py-1 active:bg-black/5 sm:min-w-40 dark:border-white/25 dark:active:bg-white/10"
    >
      <span className="text-xs opacity-70">{label}</span>
      <strong className="text-lg">{usd.format(price)}</strong>
      <span className="text-xs underline opacity-70">販売価格に使う</span>
    </button>
  );
}
