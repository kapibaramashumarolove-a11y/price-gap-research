// 写真から JAN を読む（ブラウザ側専用）。まずスマホの中でバーコードを読み、読めなければ AI に送るための画像を作る。

import { isValidJan } from "./jan";

/** 写真ファイルを画像として読み込む */
export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした。"));
    };
    img.src = url;
  });
}

/** 長い辺を maxSize 以下に縮めて canvas に描く（iPhone の写真は大きいので、読み取り・送信の前に縮める） */
export function drawScaled(img: HTMLImageElement, maxSize: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 読めた数字が JAN（EAN-13・EAN-8。UPC-A は先頭に 0 を付けて EAN-13 にする）なら返す */
export function toJan(text: string | undefined): string | undefined {
  const digits = (text ?? "").replace(/\D/g, "");
  const code = digits.length === 12 ? `0${digits}` : digits;
  return isValidJan(code) ? code : undefined;
}

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorConstructor = new (options: { formats: string[] }) => Detector;

/** 写真のバーコードから JAN を読む。読めなければ undefined */
export async function decodeJanFromImage(img: HTMLImageElement): Promise<string | undefined> {
  // 1. ブラウザに内蔵のバーコード読み取り（Android の Chrome など。iPhone の Safari にはない）
  const BarcodeDetector = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
  if (BarcodeDetector) {
    try {
      const found = await new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }).detect(img);
      for (const f of found) {
        const jan = toJan(f.rawValue);
        if (jan) return jan;
      }
    } catch {
      // 使えなければ下の方法で読む
    }
  }

  // 2. zxing（JavaScript のバーコード読み取り。iPhone でも動く）。大きさを変えて何度か試す
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);
  for (const size of [1600, 1000, 2400]) {
    try {
      const jan = toJan(reader.decodeFromCanvas(drawScaled(img, size)).getText());
      if (jan) return jan;
    } catch {
      // この大きさでは見つからなかった
    }
  }
  return undefined;
}

/** AI に送る画像（長い辺 1600px の JPEG。data URL） */
export function toUploadDataUrl(img: HTMLImageElement): string {
  return drawScaled(img, 1600).toDataURL("image/jpeg", 0.85);
}
