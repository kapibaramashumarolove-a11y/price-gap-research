// Vercel の本番では、デプロイごとに作られる URL（例: price-gap-research-86nf2ix1j-….vercel.app）で
// 開かれたとき、変わらない本番 URL（VERCEL_PROJECT_PRODUCTION_URL）へ移す。
// 楽天 API は「許可されたWebサイト」に登録した URL からしか使えないため、
// 開く URL が更新のたびに変わると楽天が使えなくなる。本番 URL に揃えれば、楽天には 1 つ登録するだけで済む。

/**
 * 本番 URL へ移すべきなら、移り先の URL を返す。
 * プレビュー（VERCEL_ENV が production 以外）や手元の開発では移さない。
 * フォームの送信などを壊さないよう、ページの表示（GET / HEAD）のときだけ移す。
 */
export function canonicalRedirectUrl(
  /** ブラウザが開いているホスト名（X-Forwarded-Host か Host ヘッダー）。URL のホストはサーバー自身の名前になることがあるので使わない */
  requestHost: string | null,
  url: URL,
  method: string,
  env: Record<string, string | undefined> = process.env,
): URL | undefined {
  if (env.VERCEL_ENV !== "production") return undefined;
  const productionHost = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().toLowerCase();
  const host = (requestHost ?? "").split(",")[0].trim().toLowerCase();
  // ホストが分からないときは、転送の繰り返しを避けるため移さない
  if (!productionHost || !host || host === productionHost) return undefined;
  if (method !== "GET" && method !== "HEAD") return undefined;
  const target = new URL(url.pathname + url.search, `https://${productionHost}`);
  return target;
}
