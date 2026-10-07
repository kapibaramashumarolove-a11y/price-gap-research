// 環境変数の値を読むときの共通処理（サーバー側）。

/**
 * 環境変数の値を整える。前後の空白・改行に加えて、コピー＆ペーストで紛れ込みやすい
 * 目に見えない文字（ゼロ幅スペース U+200B〜U+200D、WORD JOINER U+2060、BOM U+FEFF）を取り除く。
 */
export function cleanEnvValue(value: string | undefined): string {
  return (value ?? "").replace(/[​-‍⁠﻿]/g, "").trim();
}
