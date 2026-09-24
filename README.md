# price-gap-research

スニダン（SNKRDUNK）で仕入れて eBay で販売した場合の利益を計算する Web アプリです。

- スニダンの情報は、利用規約（クローリング・スクレイピングの禁止）に従い **自動取得しません**。スニダンで確認した価格を手入力します。
- eBay の価格は現在は手入力です。今後、公式の Browse API で取得できるようにする予定です。

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
3. `npm run dev` を起動し直します（起動中に書き換えた場合は `Ctrl + C` で止めてから再起動）。

`.env.local` は `.gitignore` で除外されているため GitHub にはアップロードされません。キーをチャットやコードに直接書かないでください。

## 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発用サーバーを起動（ファイルを保存すると自動で反映） |
| `npm test` | 利益計算のテストを実行 |
| `npm run lint` | コードの書き方をチェック |
| `npm run typecheck` | 型のチェック |
| `npm run build` | 本番用にビルド |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/lib/profit.ts` | 利益計算のロジック |
| `src/lib/profit.test.ts` | 利益計算のテスト |
| `src/components/PriceGapApp.tsx` | 画面本体（入力フォーム・計算条件・結果一覧） |
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
