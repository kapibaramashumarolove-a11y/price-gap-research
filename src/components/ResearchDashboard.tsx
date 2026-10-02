"use client";

// 自動リサーチの画面。保存した検索条件（プリセット）で楽天・Yahoo! と eBay を調べ、
// 利益の条件を満たす「お宝商品」を一覧にする。
// 検索条件・お宝の条件・最後の結果はブラウザの localStorage に保存する。

import { useEffect, useMemo, useState } from "react";
import { loadJson, saveJson, SETTINGS_KEY } from "@/lib/browserStorage";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/profit";
import {
  DEFAULT_CRITERIA,
  evaluateCandidate,
  PRICE_BASES,
  type Evaluation,
  type PriceBasis,
  type TreasureCriteria,
} from "@/lib/researchProfit";
import {
  DEFAULT_MAX_LOOKUPS,
  DEFAULT_PRESETS,
  MAX_LOOKUPS_LIMIT,
  RESEARCH_KINDS,
  type Candidate,
  type DomesticOffer,
  type ResearchKind,
  type ResearchPreset,
  type ResearchResponse,
} from "@/lib/researchTypes";
import AppNav from "./AppNav";
import { INPUT_CLASS, NumberField, TextField } from "./Fields";

const PRESETS_KEY = "price-gap:research-presets";
const CRITERIA_KEY = "price-gap:research-criteria";
const RESULTS_KEY = "price-gap:research-results";
const ONLY_TREASURES_KEY = "price-gap:research-only-treasures";

type PresetResult = { presetName: string; response: ResearchResponse };

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateTime = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const BASIS_SHORT: Record<PriceBasis, string> = { p25: "安い方25%", median: "中央値", min: "最安値" };
const SOURCE_LABEL: Record<DomesticOffer["source"], string> = { rakuten: "楽天", yahoo: "Yahoo!" };

/** 0 以上の数値として読めれば数値、読めなければ null */
function toNonNegativeNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function kindLabel(kind: ResearchKind): string {
  return RESEARCH_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

// ---- 検索条件の編集フォーム（入力中は文字列で持つ） ----

type PresetForm = {
  name: string;
  kind: ResearchKind;
  keyword: string;
  ngWords: string;
  minPriceJpy: string;
  maxPriceJpy: string;
  ebayKeyword: string;
  internationalShippingJpy: string;
  maxLookups: string;
};

function toForm(p: ResearchPreset): PresetForm {
  const str = (n: number | undefined) => (n === undefined ? "" : String(n));
  return {
    name: p.name,
    kind: p.kind,
    keyword: p.keyword,
    ngWords: p.ngWords.join(" "),
    minPriceJpy: str(p.minPriceJpy),
    maxPriceJpy: str(p.maxPriceJpy),
    ebayKeyword: p.ebayKeyword ?? "",
    internationalShippingJpy: str(p.internationalShippingJpy),
    maxLookups: str(p.maxLookups),
  };
}

/** フォームの内容を検索条件にする。おかしければエラーメッセージ */
function fromForm(id: string, f: PresetForm): ResearchPreset | string {
  if (f.name.trim() === "") return "名前を入力してください。";
  if (f.keyword.trim().length < 2) return "検索キーワードを 2 文字以上で入力してください。";
  const optional = (value: string, label: string): number | undefined | string => {
    if (value.trim() === "") return undefined;
    const n = toNonNegativeNumber(value);
    return n === null ? `${label}には 0 以上の数値を入力してください。` : n;
  };
  const minPriceJpy = optional(f.minPriceJpy, "最低価格");
  const maxPriceJpy = optional(f.maxPriceJpy, "最高価格");
  const intl = optional(f.internationalShippingJpy, "国際送料");
  const maxLookups = optional(f.maxLookups, "eBay で調べる件数");
  for (const v of [minPriceJpy, maxPriceJpy, intl, maxLookups]) if (typeof v === "string") return v;
  if (typeof maxLookups === "number" && (maxLookups < 1 || maxLookups > MAX_LOOKUPS_LIMIT)) {
    return `eBay で調べる件数は 1〜${MAX_LOOKUPS_LIMIT} にしてください。`;
  }
  return {
    id,
    name: f.name.trim(),
    kind: f.kind,
    keyword: f.keyword.trim(),
    ngWords: f.ngWords.split(/[\s,、]+/).filter(Boolean),
    minPriceJpy: minPriceJpy as number | undefined,
    maxPriceJpy: maxPriceJpy as number | undefined,
    ebayKeyword: f.ebayKeyword.trim() || undefined,
    internationalShippingJpy: intl as number | undefined,
    maxLookups: maxLookups as number | undefined,
  };
}

type Row = { candidate: Candidate; presetName: string; evaluation: Evaluation };

export default function ResearchDashboard() {
  const [settings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...loadJson<Partial<Settings>>(SETTINGS_KEY) }));
  const [presets, setPresets] = useState<ResearchPreset[]>(() => loadJson<ResearchPreset[]>(PRESETS_KEY) ?? DEFAULT_PRESETS);
  const [criteria, setCriteria] = useState<TreasureCriteria>(() => ({
    ...DEFAULT_CRITERIA,
    ...loadJson<Partial<TreasureCriteria>>(CRITERIA_KEY),
  }));
  const [criteriaInputs, setCriteriaInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, String(v)])),
  );
  const [results, setResults] = useState<Record<string, PresetResult>>(() => loadJson(RESULTS_KEY) ?? {});
  const [onlyTreasures, setOnlyTreasures] = useState<boolean>(() => loadJson<boolean>(ONLY_TREASURES_KEY) ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ name: string; index: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; form: PresetForm; error?: string } | null>(null);

  useEffect(() => saveJson(PRESETS_KEY, presets), [presets]);
  useEffect(() => saveJson(CRITERIA_KEY, criteria), [criteria]);
  useEffect(() => saveJson(RESULTS_KEY, results), [results]);
  useEffect(() => saveJson(ONLY_TREASURES_KEY, onlyTreasures), [onlyTreasures]);

  // 全プリセットの結果を評価し、利益の大きい順に並べる（同じ商品は利益の大きい方だけ残す）
  const { rows, noMarket, total } = useMemo(() => {
    const byKey = new Map<string, Row>();
    let noMarket = 0;
    for (const [presetId, result] of Object.entries(results)) {
      const preset = presets.find((p) => p.id === presetId);
      for (const candidate of result.response.candidates) {
        const evaluation = evaluateCandidate(candidate, settings, criteria, preset?.internationalShippingJpy);
        if (!evaluation) {
          noMarket++;
          continue;
        }
        const prev = byKey.get(candidate.key);
        if (!prev || evaluation.profit.profitJpy > prev.evaluation.profit.profitJpy) {
          byKey.set(candidate.key, { candidate, presetName: result.presetName, evaluation });
        }
      }
    }
    const all = [...byKey.values()].sort((a, b) => b.evaluation.profit.profitJpy - a.evaluation.profit.profitJpy);
    return { rows: all, noMarket, total: all.length };
  }, [results, presets, settings, criteria]);

  const treasures = rows.filter((r) => r.evaluation.isTreasure);
  const visibleRows = onlyTreasures ? treasures : rows;

  async function runPreset(preset: ResearchPreset): Promise<void> {
    setErrors((prev) => ({ ...prev, [preset.id]: "" }));
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset),
      });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [preset.id]: body.error ?? `取得に失敗しました（HTTP ${res.status}）。` }));
        return;
      }
      setResults((prev) => ({ ...prev, [preset.id]: { presetName: preset.name, response: body as ResearchResponse } }));
    } catch {
      setErrors((prev) => ({ ...prev, [preset.id]: "サーバーに接続できませんでした。" }));
    }
  }

  async function runPresets(targets: ResearchPreset[]) {
    for (const [index, preset] of targets.entries()) {
      setRunning({ name: preset.name, index: index + 1, total: targets.length });
      await runPreset(preset);
    }
    setRunning(null);
  }

  function handleCriteriaChange(key: keyof TreasureCriteria, value: string) {
    setCriteriaInputs((prev) => ({ ...prev, [key]: value }));
    if (key === "basis") {
      setCriteria((prev) => ({ ...prev, basis: value as PriceBasis }));
      return;
    }
    const n = toNonNegativeNumber(value);
    if (n !== null) setCriteria((prev) => ({ ...prev, [key]: n }));
  }

  function handleSavePreset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const preset = fromForm(editing.id, editing.form);
    if (typeof preset === "string") {
      setEditing({ ...editing, error: preset });
      return;
    }
    setPresets((prev) =>
      prev.some((p) => p.id === preset.id) ? prev.map((p) => (p.id === preset.id ? preset : p)) : [...prev, preset],
    );
    setEditing(null);
  }

  function handleDeletePreset(preset: ResearchPreset) {
    if (!window.confirm(`検索条件「${preset.name}」を削除しますか？`)) return;
    setPresets((prev) => prev.filter((p) => p.id !== preset.id));
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== preset.id)));
  }

  const busy = running !== null;
  const allWarnings = [...new Set(Object.values(results).flatMap((r) => r.response.warnings))];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 pt-2 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:pt-4">
      <AppNav current="/research" />
      <header className="space-y-1">
        <h1 className="text-xl font-bold sm:text-2xl">国内仕入れ × eBay 自動リサーチ</h1>
        <p className="text-sm opacity-80">
          楽天・Yahoo!ショッピングの商品を JAN コードやカード番号で識別し、eBay の出品中価格と比べて利益を計算します。
        </p>
      </header>

      {/* お宝の条件 */}
      <details className="group rounded-lg border border-black/10 dark:border-white/15">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">お宝の条件</span>
          <span className="flex items-center gap-2 text-sm opacity-70">
            {yen.format(criteria.minProfitJpy)}以上・{criteria.minMarginPercent}%以上
            <span aria-hidden className="transition-transform group-open:rotate-180">
              ▼
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-black/10 p-4 dark:border-white/15">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <NumberField label="利益（円以上）" value={criteriaInputs.minProfitJpy} onChange={(v) => handleCriteriaChange("minProfitJpy", v)} />
            <NumberField label="利益率（%以上）" value={criteriaInputs.minMarginPercent} onChange={(v) => handleCriteriaChange("minMarginPercent", v)} />
            <NumberField
              label="eBay の比較件数（件以上）"
              value={criteriaInputs.minEbayListings}
              onChange={(v) => handleCriteriaChange("minEbayListings", v)}
            />
            <NumberField
              label="送料別のときの国内送料（円）"
              value={criteriaInputs.domesticShippingJpy}
              onChange={(v) => handleCriteriaChange("domesticShippingJpy", v)}
            />
            <label className="col-span-2 flex min-w-0 flex-col gap-1 text-sm lg:col-span-1">
              <span>eBay 売価として使う値</span>
              <select value={criteria.basis} onChange={(e) => handleCriteriaChange("basis", e.target.value)} className={INPUT_CLASS}>
                {PRICE_BASES.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs opacity-60">
            為替 {settings.usdJpy} 円/USD・eBay 手数料 {settings.ebayFeeRate + settings.internationalFeeRate}% ＋ ${settings.perOrderFeeUsd}
            ・国際送料は検索条件ごとの値（未設定なら {yen.format(settings.internationalShippingJpy)}）で計算します。
            為替・手数料は「手入力で計算」の計算条件で変更できます。
          </p>
        </div>
      </details>

      {/* 検索条件（プリセット） */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">検索条件</h2>
          <button
            type="button"
            onClick={() => setEditing({ id: crypto.randomUUID(), form: toForm({ ...DEFAULT_PRESETS[0], name: "", keyword: "" }) })}
            disabled={busy}
            className="min-h-11 px-2 text-sm underline active:opacity-70 disabled:opacity-40"
          >
            ＋ 追加
          </button>
        </div>
        <ul className="space-y-2">
          {presets.map((preset) => {
            const result = results[preset.id];
            return (
              <li key={preset.id} className="rounded-lg border border-black/10 p-3 dark:border-white/15">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{preset.name}</div>
                    <div className="truncate text-xs opacity-60">
                      {kindLabel(preset.kind)} ・「{preset.keyword}」
                      {result && ` ・ ${dateTime.format(new Date(result.response.fetchedAt))} 取得`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => runPresets([preset])}
                    disabled={busy}
                    className="min-h-11 shrink-0 rounded-lg border border-black/30 px-4 text-sm active:bg-black/5 disabled:opacity-40 dark:border-white/30"
                  >
                    実行
                  </button>
                </div>
                <div className="mt-1 flex gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: preset.id, form: toForm(preset) })}
                    disabled={busy}
                    className="min-h-11 px-2 underline opacity-70 disabled:opacity-40"
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(preset)}
                    disabled={busy}
                    className="min-h-11 px-2 text-red-600 underline opacity-80 disabled:opacity-40"
                  >
                    削除
                  </button>
                </div>
                {errors[preset.id] && <p className="text-sm text-red-600">{errors[preset.id]}</p>}
                {result && <ResultStats response={result.response} />}
              </li>
            );
          })}
        </ul>

        {editing && (
          <PresetEditor
            form={editing.form}
            error={editing.error}
            onChange={(form) => setEditing({ ...editing, form, error: undefined })}
            onSubmit={handleSavePreset}
            onCancel={() => setEditing(null)}
          />
        )}

        <button
          type="button"
          onClick={() => runPresets(presets)}
          disabled={busy || presets.length === 0}
          className="min-h-12 w-full rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 disabled:opacity-50 sm:w-auto"
        >
          {running ? `「${running.name}」を検索中…（${running.index}/${running.total}）` : "すべての条件でリサーチ"}
        </button>
        <p className="text-xs opacity-60">
          1 つの条件につき 10〜30 秒ほどかかります。eBay の相場は出品中（即決）の価格です（落札履歴は eBay の API の制限で取得できないため、各商品の「eBay 落札済み」から確認できます）。
        </p>
      </section>

      {allWarnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          {allWarnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {/* 結果 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            お宝 {treasures.length} 件 <span className="text-sm font-normal opacity-60">/ 相場の取れた商品 {total} 件</span>
          </h2>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyTreasures} onChange={(e) => setOnlyTreasures(e.target.checked)} className="h-5 w-5" />
            お宝だけ表示
          </label>
        </div>

        {Object.keys(results).length === 0 ? (
          <p className="text-sm opacity-70">まだ結果がありません。「すべての条件でリサーチ」を押してください。</p>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm opacity-70">
            条件を満たす商品はありませんでした。「お宝だけ表示」を外すと、調べたすべての商品を利益の大きい順に見られます。
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {visibleRows.map((row) => (
              <CandidateCard key={row.candidate.key} row={row} criteria={criteria} />
            ))}
          </ul>
        )}
        {noMarket > 0 && <p className="text-xs opacity-60">eBay の相場が取れなかった商品が {noMarket} 件あります（一覧には出していません）。</p>}
      </section>

      <footer className="space-y-1 border-t border-black/10 pt-4 text-xs opacity-70 dark:border-white/15">
        <p>※ 利益は出品中価格にもとづく目安です。関税・消費税還付・返品リスク・価格の変動は含みません。仕入れ前に各サイトで確認してください。</p>
        <p className="flex flex-wrap gap-x-4">
          {/* 各 API の利用規約で求められているクレジット表記 */}
          <a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener noreferrer" className="underline">
            Supported by Rakuten Developers
          </a>
          <a href="https://developer.yahoo.co.jp/sitemap/" target="_blank" rel="noopener noreferrer" className="underline">
            Webサービス by Yahoo! JAPAN
          </a>
        </p>
      </footer>
    </main>
  );
}

function ResultStats({ response }: { response: ResearchResponse }) {
  const { stats } = response;
  const count = (n: number | null) => (n === null ? "—" : `${n}件`);
  return (
    <p className="mt-1 text-xs opacity-60">
      楽天 {count(stats.rakuten)}・Yahoo! {count(stats.yahoo)} → 除外 {stats.excluded}件・識別できず {stats.unidentified}件 → 商品{" "}
      {response.candidates.length}件を eBay で調査
      {response.skippedLookups > 0 && `（上限のため ${response.skippedLookups}件は未調査）`}
    </p>
  );
}

function PresetEditor({
  form,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: PresetForm;
  error?: string;
  onChange: (form: PresetForm) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const set = (key: keyof PresetForm) => (value: string) => onChange({ ...form, [key]: value });
  const kindHint = RESEARCH_KINDS.find((k) => k.id === form.kind)?.hint;
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-black/20 p-4 dark:border-white/25">
      <h3 className="font-semibold">検索条件の編集</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="名前 *" value={form.name} onChange={set("name")} />
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span>種類</span>
          <select value={form.kind} onChange={(e) => set("kind")(e.target.value)} className={INPUT_CLASS}>
            {RESEARCH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {kindHint && <span className="text-xs opacity-60">{kindHint}</span>}
        </label>
        <div className="sm:col-span-2">
          <TextField label="楽天・Yahoo! の検索キーワード *" value={form.keyword} onChange={set("keyword")} />
        </div>
        <div className="sm:col-span-2">
          <TextField label="除外ワード（スペース区切り）" value={form.ngWords} onChange={set("ngWords")} />
          <p className="mt-1 text-xs opacity-60">オリパ・くじ・スリーブなどの周辺グッズ・予約品は最初から除外しています。</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <NumberField label="最低価格（円）" value={form.minPriceJpy} onChange={set("minPriceJpy")} />
          <NumberField label="最高価格（円）" value={form.maxPriceJpy} onChange={set("maxPriceJpy")} />
          <NumberField label="国際送料（円）" value={form.internationalShippingJpy} onChange={set("internationalShippingJpy")} />
          <NumberField label={`eBay で調べる件数（最大 ${MAX_LOOKUPS_LIMIT}）`} value={form.maxLookups} onChange={set("maxLookups")} />
        </div>
        {(form.kind === "sealed" || form.kind === "other") && (
          <div className="sm:col-span-2">
            <TextField label="eBay 用の英語キーワード（任意）" value={form.ebayKeyword} onChange={set("ebayKeyword")} />
            <p className="mt-1 text-xs opacity-60">
              JAN で eBay に見つからないときに使います。1 つの商品に絞った検索条件のときだけ入れてください（例: Terastal Festival booster box japanese）。
            </p>
          </div>
        )}
      </div>
      <p className="text-xs opacity-60">未入力の eBay 調査件数は {DEFAULT_MAX_LOOKUPS} 件です。</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="min-h-12 flex-1 rounded-lg bg-foreground px-6 text-base font-medium text-background active:opacity-80 sm:flex-none">
          保存
        </button>
        <button type="button" onClick={onCancel} className="min-h-12 rounded-lg border border-black/30 px-6 text-base dark:border-white/30">
          やめる
        </button>
      </div>
    </form>
  );
}

function shippingNote(offer: DomesticOffer, criteria: TreasureCriteria): string {
  if (offer.shipping === "free") return "送料無料";
  const label = offer.shipping === "extra" ? "送料別" : "送料条件あり";
  return `${label}（+${yen.format(criteria.domesticShippingJpy)}で計算）`;
}

function LinkButton({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex min-h-12 items-center justify-center rounded-lg px-2 text-center text-sm font-medium active:opacity-70 ${
        primary ? "bg-foreground text-background" : "border border-black/25 dark:border-white/30"
      }`}
    >
      {children}
    </a>
  );
}

function CandidateCard({ row, criteria }: { row: Row; criteria: TreasureCriteria }) {
  const { candidate, presetName, evaluation } = row;
  const { offer, profit } = evaluation;
  const ebay = candidate.ebay!;
  const cheapestBy = (source: DomesticOffer["source"]) => candidate.offers.find((o) => o.source === source);
  const rakuten = cheapestBy("rakuten");
  const yahoo = cheapestBy("yahoo");

  return (
    <li className={`rounded-lg border p-4 ${evaluation.isTreasure ? "border-green-600/60" : "border-black/10 dark:border-white/15"}`}>
      <div className="flex gap-3">
        {offer.imageUrl && (
          // 楽天・Yahoo! の画像サーバーの画像をそのまま表示する
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={offer.imageUrl}
            alt=""
            loading="lazy"
            onError={(e) => (e.currentTarget.style.display = "none")}
            className="h-16 w-16 shrink-0 rounded object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs opacity-60">
            {evaluation.isTreasure && <span className="mr-1 rounded bg-green-600 px-1 font-semibold text-white">お宝</span>}
            {candidate.label} ・ {presetName}
          </div>
          <div className="line-clamp-2 text-sm font-medium break-words">{offer.title}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-lg font-bold ${profit.profitJpy >= 0 ? "text-green-600" : "text-red-600"}`}>{yen.format(profit.profitJpy)}</div>
          <div className="text-xs opacity-70">利益率 {profit.marginPercent.toFixed(1)}%</div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="opacity-70">仕入れ</dt>
        <dd className="text-right">
          {yen.format(evaluation.purchaseJpy)}
          <span className="block text-xs opacity-60">
            {SOURCE_LABEL[offer.source]} {offer.shopName} ・ {shippingNote(offer, criteria)}
          </span>
        </dd>
        <dt className="opacity-70">eBay 売価</dt>
        <dd className="text-right">
          {usd.format(evaluation.ebayPriceUsd)}
          <span className="block text-xs opacity-60">
            {BASIS_SHORT[criteria.basis]}・比較 {ebay.count}件（ヒット {ebay.total}件）
          </span>
        </dd>
        <dt className="opacity-70">手数料・送料</dt>
        <dd className="text-right">
          {usd.format(profit.ebayFeesUsd)} ＋ 国際送料 {yen.format(profit.totalCostJpy - evaluation.purchaseJpy)}
        </dd>
      </dl>

      {evaluation.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
          {evaluation.notes.map((n) => (
            <li key={n}>⚠ {n}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {rakuten && (
          <LinkButton href={rakuten.url} primary={offer === rakuten}>
            楽天 {yen.format(rakuten.priceJpy)}
          </LinkButton>
        )}
        {yahoo && (
          <LinkButton href={yahoo.url} primary={offer === yahoo}>
            Yahoo! {yen.format(yahoo.priceJpy)}
          </LinkButton>
        )}
        <LinkButton href={ebay.activeUrl}>eBay 出品中</LinkButton>
        <LinkButton href={ebay.soldUrl}>eBay 落札済み</LinkButton>
      </div>

      {ebay.samples.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="flex min-h-11 cursor-pointer items-center opacity-70">比較した eBay の出品（安い順）</summary>
          <ul>
            {ebay.samples.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="block min-h-11 py-2 underline">
                  {usd.format(s.priceUsd)} {s.title}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
