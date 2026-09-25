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
import EbayPriceLookup from "./EbayPriceLookup";

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
  // 追加するたびに増やし、eBay 検索欄（前の商品の検索結果）をリセットするために使う
  const [formVersion, setFormVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
    setFormVersion((v) => v + 1);
    setError(null);
  }

  function handleSettingChange(key: keyof Settings, value: string) {
    setSettingInputs((prev) => ({ ...prev, [key]: value }));
    const n = toNonNegativeNumber(value);
    if (n !== null) setSettings((prev) => ({ ...prev, [key]: n }));
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">スニダン → eBay 価格差リサーチ</h1>
        <p className="text-sm opacity-80">
          スニダンで確認した仕入れ価格と、eBay での想定販売価格から利益を計算します。
          スニダンの情報は規約に従い、自動取得せずご自身で確認した値を入力してください。
          eBay の価格は公式 API で出品中の価格を調べて入力することもできます。
        </p>
      </header>

      <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="font-semibold">計算条件</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SETTING_FIELDS.map(({ key, label, unit }) => (
            <label key={key} className="flex flex-col gap-1 text-sm">
              <span>
                {label} <span className="opacity-60">({unit})</span>
              </span>
              <input
                type="number"
                min={0}
                step="any"
                value={settingInputs[key]}
                onChange={(e) => handleSettingChange(key, e.target.value)}
                className="rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/25"
              />
            </label>
          ))}
        </div>
        <p className="text-xs opacity-60">
          手数料率・送料は目安の初期値です。最新の eBay 手数料や実際の送料に合わせて変更してください。
        </p>
      </section>

      <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="font-semibold">仕入れ候補を追加</h2>
        <form onSubmit={handleAdd} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="商品名 *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <TextField label="型番 (SKU)" value={form.sku} onChange={(v) => setForm({ ...form, sku: v })} />
          <TextField label="サイズ" value={form.size} onChange={(v) => setForm({ ...form, size: v })} />
          <div className="hidden lg:block" />
          <TextField
            label="スニダン価格 (円) *"
            type="number"
            value={form.snkrdunkPriceJpy}
            onChange={(v) => setForm({ ...form, snkrdunkPriceJpy: v })}
          />
          <TextField
            label="スニダン手数料・国内送料 (円)"
            type="number"
            value={form.snkrdunkExtraJpy}
            onChange={(v) => setForm({ ...form, snkrdunkExtraJpy: v })}
          />
          <TextField
            label="eBay 販売価格 (USD) *"
            type="number"
            value={form.ebayPriceUsd}
            onChange={(v) => setForm({ ...form, ebayPriceUsd: v })}
          />
          <TextField
            label="購入者負担の送料 (USD)"
            type="number"
            value={form.ebayShippingChargedUsd}
            onChange={(v) => setForm({ ...form, ebayShippingChargedUsd: v })}
          />
          <EbayPriceLookup
            key={formVersion}
            defaultKeyword={form.sku.trim() || form.name.trim()}
            onApplyPrice={(price) => setForm((prev) => ({ ...prev, ebayPriceUsd: String(price) }))}
          />
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button
              type="submit"
              className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
            >
              追加する
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">計算結果（利益の大きい順）</h2>
        {rows.length === 0 ? (
          <p className="text-sm opacity-70">まだ候補がありません。上のフォームから追加してください。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
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
                    <td
                      className={`py-2 pr-2 text-right font-semibold ${
                        result.profitJpy >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {yen.format(result.profitJpy)}
                    </td>
                    <td className="py-2 pr-2 text-right">{result.marginPercent.toFixed(1)}%</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
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
        )}
        <p className="text-xs opacity-60">
          ※ 計算結果は入力値と計算条件にもとづく目安です。関税・消費税還付・返品リスクなどは含みません。
        </p>
      </section>
    </main>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <input
        type={type}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? "any" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-black/20 bg-transparent px-2 py-1 dark:border-white/25"
      />
    </label>
  );
}
