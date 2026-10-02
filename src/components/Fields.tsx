// 入力欄の共通部品（スマホで押しやすく、iPhone で入力時に拡大されない大きさ）。

/** 入力欄の共通の見た目。16px 以上の文字にして、iPhone で入力時に画面が拡大されないようにする */
export const INPUT_CLASS =
  "h-12 w-full rounded-lg border border-black/20 bg-transparent px-3 text-base dark:border-white/25";

export function TextField({
  label,
  value,
  onChange,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
    </label>
  );
}

/** 数値の入力欄。スマホでは小数点つきの数字キーボードを出す（値のチェックは保存時に行う） */
export function NumberField({
  label,
  value,
  onChange,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </label>
  );
}
