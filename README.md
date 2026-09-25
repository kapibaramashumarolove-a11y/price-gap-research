# price-gap-research

スニダン（SNKRDUNK）で仕入れて eBay で販売した場合の利益を計算する Web アプリです。

- スニダンの情報は、利用規約（クローリング・スクレイピングの禁止）に従い **自動取得しません**。スニダンで確認した価格を手入力します。
- eBay の価格は手入力のほか、公式の **Browse API** で「出品中の価格」（中央値・最安値・件数）を調べて入力できます。
  - 売れた価格（落札相場）を返す Marketplace Insights API は利用できないため、出品中の価格を目安にしています。

## 必要なもの

- [Node.js](https://nodejs.org/) 22 以上（`node -v` でバージョンを確認できます）

## 使い方（ローカルで動かす）

```bash
npm install      # 初回のみ：必要なライブラリをインストール
npm run dev      # 開発用サーバーを起動
```

ブラウザで http://localhost:3000 を開きます。止めるときはターミナルで `Ctrl + C` を押します。

入力したデータは、そのブラウザの中（localStorage）だけに保存されます。

## eBay API キーの設定

1. `.env.example` をコピーして `.env.local` を作ります（Windows: `copy .env.example .env.local` / Mac: `cp .env.example .env.local`）。
2. `.env.local` をエディタで開き、`EBAY_CLIENT_ID=` と `EBAY_CLIENT_SECRET=` の右側に eBay で発行したキーを書いて保存します。
   `EBAY_ENVIRONMENT` は、Sandbox 用のキーなら `sandbox`、Production 用のキーなら `production` にします（未設定なら `sandbox`）。
   Sandbox はテスト用のダミーデータなので、実際の相場を調べるには Production のキーが必要です。
3. `npm run dev` を起動し直します（起動中に書き換えた場合は `Ctrl + C` で止めてから再起動）。

`.env.local` は `.gitignore` で除外されているため GitHub にはアップロードされません。キーをチャットやコードに直接書かないでください。

## eBay の出品価格を調べる

1. 「仕入れ候補を追加」で型番（または商品名）を入力します。
2. 「eBay の出品価格を調べる」を押すと、アメリカの eBay（ebay.com）で **新品・即決・米ドル建て** の出品を最大 100 件取得し、中央値・最安値・最高値・件数を表示します。
   別のキーワードで調べたいときは「eBay 検索キーワード」欄に入力します。
3. 「中央値を入れる」「最安値を入れる」を押すと「eBay 販売価格」欄に反映され、そのまま利益計算に使えます。

注意点：

- 出品中の価格なので、実際に売れる価格とは異なることがあります。
- 型番違い・偽物・箱のみなどの出品が混ざることがあります。「安い順の出品を確認する」で中身を確認してください。
- サイズ別の価格は取得していません（キーワードにサイズを含めると絞り込める場合があります）。
- 同じキーワードの結果は 10 分間サーバーに保存し、eBay API の呼び出し回数を節約しています。

### しくみ

```
ブラウザ（画面）
  └─ GET /api/ebay/search?q=型番     … src/app/api/ebay/search/route.ts
       └─ サーバー側で eBay にアクセス  … src/lib/ebay.ts
            1. EBAY_CLIENT_ID / SECRET でアクセストークンを取得（約 2 時間使い回す）
            2. Browse API の item_summary/search で出品を検索
            3. 中央値・最安値などを集計  … src/lib/ebayStats.ts
```

eBay のキーはサーバーの中だけで使われ、ブラウザには送られません。

## 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発用サーバーを起動（ファイルを保存すると自動で反映） |
| `npm test` | 利益計算・eBay 価格集計のテストを実行 |
| `npm run lint` | コードの書き方をチェック |
| `npm run typecheck` | 型のチェック |
| `npm run build` | 本番用にビルド |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/lib/profit.ts` | 利益計算のロジック |
| `src/lib/profit.test.ts` | 利益計算のテスト |
| `src/lib/ebay.ts` | eBay Browse API の呼び出し（サーバー専用） |
| `src/lib/ebayStats.ts` | eBay の検索結果から中央値・最安値などを集計 |
| `src/lib/ebayStats.test.ts` | 集計のテスト |
| `src/app/api/ebay/search/route.ts` | 画面から呼ぶ API（`/api/ebay/search?q=...`） |
| `src/components/PriceGapApp.tsx` | 画面本体（入力フォーム・計算条件・結果一覧） |
| `src/components/EbayPriceLookup.tsx` | 「eBay の出品価格を調べる」部分 |
| `src/components/ClientOnlyApp.tsx` | 画面をブラウザだけで表示するための入れ物 |
| `src/app/page.tsx` | トップページ（`/`） |
| `src/app/layout.tsx` | 全ページ共通の枠（タイトルなど） |

## 利益の計算式

```
eBay 売上   = 販売価格 + 購入者負担の送料                     [USD]
eBay 手数料 = eBay 売上 × (落札手数料率 + 海外取引手数料率) + 1注文あたり固定手数料  [USD]
入金額      = (eBay 売上 − eBay 手数料) × 為替レート           [円]
仕入れ合計  = スニダン価格 + スニダン手数料・国内送料 + 国際送料  [円]
利益        = 入金額 − 仕入れ合計                               [円]
利益率      = 利益 ÷ (eBay 売上 × 為替レート)
```

手数料率・送料の初期値は目安です。最新の eBay 手数料や実際の送料に合わせて画面上で変更してください。
