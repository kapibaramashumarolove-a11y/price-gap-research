# price-gap-research

スニダン（SNKRDUNK）や楽天・Yahoo!ショッピングで仕入れて eBay で販売した場合の利益を計算する Web アプリです。

- **自動リサーチ**（`/research`）: 楽天・Yahoo! の商品を公式 API で一括取得し、JAN コードやカード番号で同じ商品を見分けて eBay の相場と照合し、利益の条件を満たす「お宝商品」を一覧にします。
- **手入力で計算**（`/`）: スニダンで確認した価格などを手入力して利益を計算します。

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
2. 「Environment Variables」に次の値を登録します。

   | 名前 | 値 |
   |---|---|
   | `EBAY_CLIENT_ID` | 本番用の App ID |
   | `EBAY_CLIENT_SECRET` | 本番用の Cert ID（`PRD-` で始まる） |
   | `EBAY_ENVIRONMENT` | `production` |
   | `APP_PASSWORD` | 自分で決めた合言葉 |
   | `RAKUTEN_APP_ID` | 楽天のアプリケーション ID（自動リサーチ用） |
   | `RAKUTEN_ACCESS_KEY` | 楽天のアクセスキー（自動リサーチ用） |
   | `YAHOO_CLIENT_ID` | Yahoo! の Client ID（自動リサーチ用） |

3. 「Deploy」を押すと `https://〇〇.vercel.app` の URL ができます。スマホで開き、合言葉を入力します。

`NODE_USE_ENV_PROXY` は Vercel では不要です。環境変数を後から変えたときは、Deployments 画面から「Redeploy」すると反映されます。

## 自動リサーチ（楽天・Yahoo! × eBay）

画面上部の「自動リサーチ」タブで使います。

### 流れ

1. **国内の商品を取得**: 検索条件（プリセット）ごとに、楽天市場（最大 30 件）と Yahoo!ショッピング（最大 50 件・在庫ありのみ）を公式 API で検索します。
2. **除外**: オリパ・くじ・ローダーなどの周辺グッズ・予約品は最初から除外します。未開封BOX ではさらに、開封済み・シュリンクなし・訳あり・2BOX などの複数箱・1 パックだけの出品も除外します。検索条件ごとに除外ワードを追加できます。
3. **同じ商品を見分ける**（種類ごとに方法が違います）

   | 種類 | 識別のしかた | eBay の検索 |
   |---|---|---|
   | 未開封BOX | JAN コード（Yahoo! は API の JAN、楽天は商品名・説明文から抽出。チェックデジットも確認） | JAN（GTIN）で検索、新品のみ |
   | PSA10 | カード番号（例: `205/172`、プロモ `001/SV-P`）＋ PSA10 の表記 | 「`205/172 PSA 10 japanese`」、鑑定済み（`2750`） |
   | シングル（未鑑定） | カード番号（鑑定品は除外） | 「`205/172 japanese`」、未鑑定（`4000`） |
   | その他 | JAN コード、なければ型番（例: `DD1391-100`） | JAN または型番、新品のみ |

   カード番号はタイトルからだけ取り出します（説明文には関連する別カードの番号が書かれていることがあるため）。識別できなかった商品は eBay と照合しません。
4. **eBay の相場**: まとめた商品ごとに eBay を検索し、タイトルを確認して別の商品（カード番号違い・PSA9・カスタム品・1 パックだけ・複数箱・他の言語版など）を除いてから、最安値・安い方から 25%・中央値を出します。同じ検索は 30 分間使い回し、1 回のリサーチで調べる商品数にも上限（初期値 15、最大 30）をかけて API の利用回数を抑えます。
5. **利益の計算**（画面側で計算するので、条件を変えてもすぐに再計算されます）

   ```
   利益 = (eBay 売価 − eBay 手数料) × 為替 − (国内最安値 + 国内送料) − 国際送料
   ```

   - eBay 売価: 「お宝の条件」で選んだ値（初期値は安い方から 25%。出品中価格の中央値は実際に売れる価格より高めに出やすいため）
   - 国内最安値: 楽天・Yahoo! のうち送料込みで一番安いもの。送料別・条件付きの場合は「送料別のときの国内送料」（初期値 800 円）を足します
   - 為替・eBay 手数料: 「手入力で計算」の計算条件と共通
   - 国際送料: 検索条件ごとに設定（初期値: BOX 3,000 円・PSA10 2,000 円・シングル 1,500 円）
6. **お宝の判定**: 利益（初期値 3,000 円以上）・利益率（15% 以上）・eBay の比較件数（3 件以上。少ないと相場が当てにならないため）をすべて満たすもの。各商品には楽天・Yahoo! の購入リンク、eBay の出品中・落札済みの検索リンクを付けています。

### 注意

- **eBay の落札履歴（Sold）は API では取得できません。** 落札データの API（Marketplace Insights API）は eBay の審査が必要で、このアプリのキーでは使えません（`invalid_scope`）。相場は出品中（即決）の価格で、各商品の「eBay 落札済み」ボタンから eBay のサイトで落札価格を確認できます。
- 国内の価格は API で取得した範囲（楽天 30 件・Yahoo! 50 件）での最安値です。
- 「未開封BOX」は JAN コードがない出品（オリパ・くじなど）を自然に除けますが、JAN が書かれていない正規品も対象外になります。
- 楽天・Yahoo! の API の利用規約に従い、画面の下にクレジット（Supported by Rakuten Developers / Webサービス by Yahoo! JAPAN）を表示しています。
- 検索条件・お宝の条件・最後の結果は、そのブラウザ（localStorage）に保存されます。

### 必要な環境変数

| 名前 | 内容 |
|---|---|
| `RAKUTEN_APP_ID` | 楽天ウェブサービスのアプリケーション ID |
| `RAKUTEN_ACCESS_KEY` | 楽天ウェブサービスのアクセスキー（`RAKUTEN_APP_ID` と同じアプリのもの） |
| `RAKUTEN_SITE_URL` | （任意）楽天の「許可されたWebサイト」に登録した URL。未設定なら Vercel の本番 URL を使います |
| `RAKUTEN_AFFILIATE_ID` | （任意）楽天アフィリエイト ID |
| `YAHOO_CLIENT_ID` | Yahoo!デベロッパーネットワークの Client ID |

どちらかが未設定でも、設定されている方だけで動きます（画面に注意が出ます）。

### 楽天 API の設定（2026 年の移行後）

楽天の旧 API（`app.rakuten.co.jp`）は 2026 年 5 月に停止しました。このアプリは新しい API（`openapi.rakuten.co.jp`）を使い、次の 3 つがそろって初めて動きます。

1. [楽天ウェブサービス](https://webservice.rakuten.co.jp/) で新しくアプリを登録し、**アプリケーション ID** と **アクセスキー** を取得する（移行前に作ったアプリの ID は使えません）。
2. アプリ設定の **「許可されたWebサイト」** に、Vercel の**本番の URL**（Vercel の Settings → Domains に出ている、`https://〇〇.vercel.app` のような変わらない URL）を登録する。アプリは楽天に `Referer` / `Origin` ヘッダーとしてこの URL を送ります。Vercel がデプロイごとに作る URL（`〇〇-c2i9bcd5a-….vercel.app` のように途中に英数字が入るもの）は毎回変わるので登録しても使えません。アプリは Vercel が自動で設定する `VERCEL_PROJECT_PRODUCTION_URL`（本番の URL）を優先して送ります。別の URL を送りたい場合は `RAKUTEN_SITE_URL` で指定できます。
3. Vercel の環境変数に `RAKUTEN_APP_ID` と `RAKUTEN_ACCESS_KEY` を登録して Redeploy する。

エラーが出たときは、画面の注意に原因（アクセスキー違い・アプリ ID 違い・許可されたWebサイト未登録など）と直し方が表示されます。

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
| `src/app/research/page.tsx` / `src/components/ResearchDashboard.tsx` | 自動リサーチの画面（`/research`） |
| `src/app/api/research/route.ts` | 自動リサーチの API（`POST /api/research`） |
| `src/lib/research.ts` | 自動リサーチ本体（国内検索 → 除外・識別 → eBay 照合） |
| `src/lib/domestic.ts` | 楽天・Yahoo!ショッピングの API 呼び出し（サーバー専用） |
| `src/lib/identify.ts` | JAN・カード番号・型番の抽出、除外ルール、eBay の検索条件 |
| `src/lib/researchProfit.ts` | 利益の計算とお宝の判定（画面側） |
| `src/lib/researchTypes.ts` / `src/lib/researchRequest.ts` | 自動リサーチの型・初期の検索条件・入力チェック |
| `src/components/AppNav.tsx` / `src/components/Fields.tsx` | 画面上部のタブ・入力欄の共通部品 |
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
