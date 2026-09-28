// ログイン画面。合言葉（環境変数 APP_PASSWORD）を入力する。

import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "ログイン | 価格差リサーチ" };

const ERROR_MESSAGES: Record<string, string> = {
  wrong: "合言葉がちがいます。",
  locked: "まちがいが続いたため、しばらく（15 分ほど）ログインできません。",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERROR_MESSAGES[params.error] : undefined;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-center text-xl font-bold">価格差リサーチ</h1>
      <form method="post" action="/api/login" className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-2">
          <span className="text-sm">合言葉</span>
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            className="h-12 rounded-lg border border-black/20 bg-transparent px-3 text-base dark:border-white/25"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background active:opacity-80"
        >
          ログイン
        </button>
      </form>
    </main>
  );
}
