// 画面上部の切り替えタブ（自動リサーチ ⇄ 手入力で計算）とログアウト。

import Link from "next/link";

const TABS = [
  { href: "/research", label: "自動リサーチ" },
  { href: "/", label: "手入力で計算" },
] as const;

export default function AppNav({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="flex items-center justify-between gap-2 border-b border-black/10 dark:border-white/15">
      <div className="flex">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.href === current ? "page" : undefined}
            className={`flex min-h-12 items-center border-b-2 px-3 text-sm font-medium ${
              tab.href === current ? "border-foreground" : "border-transparent opacity-60 active:opacity-100"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <form method="post" action="/api/logout">
        <button type="submit" className="min-h-11 px-2 text-sm underline opacity-70 active:opacity-100">
          ログアウト
        </button>
      </form>
    </nav>
  );
}
