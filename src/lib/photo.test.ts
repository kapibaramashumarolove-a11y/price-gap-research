import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { PHOTO_MODEL, PhotoError, readProductFromPhoto } from "./photo";

/** messages.parse の応答だけを返すダミーの Claude クライアント */
function fakeClient(response: unknown) {
  const parse = vi.fn(async () => response);
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe("readProductFromPhoto", () => {
  it("写真を Claude に送り、JAN・型番・商品名と検索語を返す（JAN はチェックデジットを確かめる）", async () => {
    const { client, parse } = fakeClient({
      stop_reason: "end_turn",
      parsed_output: { jan: "4902370-548495", model: "HAC-001", name: "ニンテンドースイッチ 本体", brand: "任天堂" },
    });
    expect(await readProductFromPhoto("AAAA", "image/jpeg", client)).toEqual({
      jan: "4902370548495",
      model: "HAC-001",
      name: "ニンテンドースイッチ 本体",
      brand: "任天堂",
      query: "4902370548495",
    });
    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({ model: PHOTO_MODEL, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(JSON.stringify(params.messages)).toContain('"media_type":"image/jpeg"');
  });

  it("JAN が読めない（チェックデジット違い）なら、型番（メーカー名つき）で検索する", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", parsed_output: { jan: "1234567890123", model: "ZV-E10", name: "ソニー VLOGCAM", brand: "ソニー" } });
    expect(await readProductFromPhoto("AAAA", "image/png", client)).toMatchObject({ jan: undefined, query: "ソニー ZV-E10" });
  });

  it("型番もなければ商品名で検索する。読み取れなければエラー", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", parsed_output: { jan: "", model: "", name: "強炭酸水 500ml", brand: "" } });
    expect(await readProductFromPhoto("AAAA", "image/png", client)).toMatchObject({ query: "強炭酸水 500ml" });
    const refused = fakeClient({ stop_reason: "refusal", parsed_output: null });
    await expect(readProductFromPhoto("AAAA", "image/png", refused.client)).rejects.toBeInstanceOf(PhotoError);
    const empty = fakeClient({ stop_reason: "end_turn", parsed_output: null });
    await expect(readProductFromPhoto("AAAA", "image/png", empty.client)).rejects.toThrow(/読み取れませんでした/);
  });
});
