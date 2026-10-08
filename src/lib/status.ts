// 各モールの API キーが「設定されているか」だけを返す（値は絶対に返さない）。画面の「接続状況」と原因の案内に使う。

import { readAmazonCredentials } from "./amazon";
import { isRakutenConfigured, isYahooConfigured } from "./domestic";
import { readKeepaKey } from "./keepa";

export type ConfigStatus = {
  keepa: boolean;
  spApi: boolean;
  rakuten: boolean;
  yahoo: boolean;
  /** 名前に KEEPA を含む環境変数の名前（値は含めない）。KEEPA_API_KEY の名前違いを見つけるため */
  keepaLikeNames: string[];
  /** Vercel の環境（production / preview / development）。Vercel 以外では undefined */
  vercelEnv?: string;
};

export function configStatus(env: Record<string, string | undefined> = process.env): ConfigStatus {
  return {
    keepa: readKeepaKey(env) !== undefined,
    spApi: readAmazonCredentials(env) !== undefined,
    rakuten: isRakutenConfigured(env),
    yahoo: isYahooConfigured(env),
    keepaLikeNames: Object.keys(env)
      .filter((name) => /keepa(?!live)/i.test(name) && name !== "KEEPA_API_KEY")
      .sort(),
    vercelEnv: env.VERCEL_ENV || undefined,
  };
}
