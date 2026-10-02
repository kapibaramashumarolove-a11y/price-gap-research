// ブラウザの localStorage への保存・読み込み（画面側専用）。
// 保存できない環境（プライベートモード等）でも画面が止まらないように、失敗は無視する。

/** 手入力の画面と自動リサーチで共通の計算条件（為替・手数料・国際送料） */
export const SETTINGS_KEY = "price-gap:settings";

export function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できない環境でも画面は動かす
  }
}
