# price-gap-research

スニダン（SNKRDUNK）で仕入れて eBay で販売した場合の利益を計算する Web アプリです。

- スニダンの情報は、利用規約（クローリング・スクレイピングの禁止）に従い **自動取得しません**。スニダンで確認した価格を手入力します。
- eBay の価格は、公式の [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html) で「出品中（即決）の価格」の中央値・最安値・件数を取得して使えます（手入力も可）。API はサーバー側だけで呼び出し、キーはブラウザに送りません。

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

- `EBAY_ENVIRONMENT` は `sandbox`（テスト用）か `production`（本番）です。Sandbox のキー（Secret が `SBX-` で始まる）は `sandbox`、本番のキーは `production` と組み合わせてください。Sandbox で返ってくる商品・価格はテスト用のデータです。
- キーをコピー＆ペーストしたときに、目に見えない文字（ゼロ幅スペースなど）や前後の空白が紛れ込むことがあります。アプリ側で自動的に取り除きますが、認証に失敗する場合は貼り直してみてください。

### プロキシ環境で動かす場合

社内ネットワークなど HTTP プロキシ（`HTTPS_PROXY` 環境変数）経由でしか外に出られない環境では、Node.js の `fetch` がプロキシを使うように `NODE_USE_ENV_PROXY=1` を付けて起動します（Node.js 22.21 以上）。

```bash
NODE_USE_ENV_PROXY=1 npm run dev
```

## 合言葉（ログイン）

URL を知っている第三者に eBay API の利用枠を使われないよう、サイトを開くと合言葉を求めます。合言葉は環境変数 `APP_PASSWORD` で設定します。

- 合言葉が合うと、そのブラウザは 30 日間ログインしたままになります。右上の「ログアウト」で解除できます。
- `APP_PASSWORD` を変えると、それまでログインしていたブラウザはすべてログアウトされます。
- 同じ接続元から 5 回まちがえると、15 分間ログインできなくなります（簡易的な総当たり対策）。
- **本番で `APP_PASSWORD` が未設定だと、安全のためサイトも API も使えない状態になります**（エラー表示）。`npm run dev` では未設定ならログインなしで使えます。
- 4 桁の PIN のような短い合言葉は総当たりで破られやすいので、12 文字以上をおすすめします。

## Vercel で公開する（スマホで使う）

1. [Vercel](https://vercel.com) に GitHub アカウントでログインし、「Add New → Project」でこのリポジトリを Import します。
2. 「Environment Variables」に次の 4 つを登録します。

   | 名前 | 値 |
   |---|---|
   | `EBAY_CLIENT_ID` | 本番用の App ID |
   | `EBAY_CLIENT_SECRET` | 本番用の Cert ID（`PRD-` で始まる） |
   | `EBAY_ENVIRONMENT` | `production` |
   | `APP_PASSWORD` | 自分で決めた合言葉 |

3. 「Deploy」を押すと `https://〇〇.vercel.app` の URL ができます。スマホで開き、合言葉を入力します。

`NODE_USE_ENV_PROXY` は Vercel では不要です。環境変数を後から変えたときは、Deployments 画面から「Redeploy」すると反映されます。

## eBay の相場取得の使い方

1. 「仕入れ候補を追加」で型番（なければ商品名）とサイズを入力します。
2. 「eBay の出品中価格を取得」を押すと、米国 eBay（USD）の**新品**の即決出品を最大 100 件検索し、中央値・最安値・件数を表示します。
3. 「販売価格に使う」を押すと、その値が「eBay 販売価格 (USD)」に入ります。

オークション出品は「現在の入札額」が実際の売値とかけ離れやすいので除外しています。中古が混ざると中央値が大きく下がるため、既定では新品（コンディション ID `1000`）だけに絞っています。出品中の価格であり、実際に売れた価格ではない点に注意してください。

サーバーの API は `GET /api/ebay/search?q=キーワード` で、次のような JSON を返します。

```json
{ "query": "nike", "environment": "production", "conditionIds": ["1000"], "total": 302, "count": 100, "median": 24.99, "min": 9.99, "fetchedAt": "..." }
```

商品の状態は `condition` で変えられます（カンマ区切りで複数可）。使える ID と画面用の名前は `src/lib/ebayConditions.ts` にまとめてあり、将来ここから画面の選択肢を作れます。

| 指定 | 意味 |
|---|---|
| なし | 新品のみ（`1000`） |
| `&condition=1000,1500` | 新品＋新品（その他・箱なし等） |
| `&condition=3000` | 中古 |
| `&condition=2750,4000` | トレーディングカード（ポケモンカードなど）の鑑定済み＋未鑑定 |
| `&condition=all` | 状態で絞り込まない |

同じ ID でもカテゴリによって意味が変わるものがあります（例：トレーディングカードでは `2750` が鑑定済み、`4000` が未鑑定）。

`.env.local` は `.gitignore` で除外されているため GitHub にはアップロードされません。キーをチャットやコードに直接書かないでください。

## 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発用サーバーを起動（ファイルを保存すると自動で反映） |
| `npm test` | 利益計算・eBay 連携のテストを実行 |
| `npm run lint` | コードの書き方をチェック |
| `npm run typecheck` | 型のチェック |
| `npm run build` | 本番用にビルド |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/lib/profit.ts` | 利益計算のロジック |
| `src/lib/profit.test.ts` | 利益計算のテスト |
| `src/lib/ebay.ts` | eBay Browse API の呼び出しと価格の集計（サーバー専用） |
| `src/lib/ebay.test.ts` | eBay 連携のテスト（通信はダミー） |
| `src/lib/ebayConditions.ts` | eBay の商品状態（コンディション ID）の一覧と既定値（新品） |
| `src/lib/ebayConditions.test.ts` | コンディション指定のテスト |
| `src/app/api/ebay/search/route.ts` | 画面から呼ぶ API（`/api/ebay/search`） |
| `src/lib/auth.ts` | 合言葉のチェックとログイン用 Cookie（サーバー専用） |
| `src/lib/auth.test.ts` | 合言葉まわりのテスト |
| `src/proxy.ts` | 全ページ・API の前でログイン済みかを確認する |
| `src/app/login/page.tsx` | ログイン画面（`/login`） |
| `src/app/api/login/route.ts` / `src/app/api/logout/route.ts` | ログイン・ログアウトの処理 |
| `src/components/PriceGapApp.tsx` | 画面本体（入力フォーム・計算条件・結果一覧。スマホではカード表示） |
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
