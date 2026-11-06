import { afterEach, describe, it, expect, vi } from "vitest";
import { listModels, parseModelIds, MODEL_LIST_MAX, MODEL_LIST_TIMEOUT_MS } from "../llm-models";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("listModels 请求边界", () => {
  it("正文挂起在 12 秒内结束并允许手填", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const pending = listModels("http://[::1]:11434/v1", "");
    await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS);
    expect(await pending).toEqual({ ids: [], error: expect.stringContaining("超时") });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("接口错误隐藏密钥且不自动重发模型列表请求", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"busy for sk-private"}}', { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listModels("https://example.com/v1", "sk-private")).toEqual({ ids: [], error: "HTTP 503: busy for [redacted]" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("响应头声明过大的模型列表时关闭流并允许手填", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": "9000000" } })));
    expect(await listModels("http://127.0.0.1:11434/v1", "")).toEqual({ ids: [], error: expect.stringContaining("响应过大") });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("parseModelIds", () => {
  it("认 OpenAI 标准形状 {data:[{id}]}", () => {
    expect(parseModelIds({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] })).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("也认裸数组和 {models:[]}(个别家不按标准来)", () => {
    expect(parseModelIds(["glm-4.7"])).toEqual(["glm-4.7"]);
    expect(parseModelIds({ models: [{ id: "qwen-plus" }] })).toEqual(["qwen-plus"]);
  });

  it("去重、去空白、按字母序排——下拉里不该出现重复项", () => {
    expect(parseModelIds({ data: [{ id: "b" }, { id: " b " }, { id: "a" }, { id: "" }] })).toEqual(["a", "b"]);
  });

  it("形状不对时返回空数组而不是抛异常(这只是个填表帮手)", () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({ error: "unauthorized" })).toEqual([]);
    expect(parseModelIds("nope")).toEqual([]);
  });

  it("聚合平台几百个模型时截断,不撑爆下拉", () => {
    const many = Array.from({ length: MODEL_LIST_MAX + 50 }, (_, i) => ({ id: `m${String(i).padStart(4, "0")}` }));
    expect(parseModelIds({ data: many })).toHaveLength(MODEL_LIST_MAX);
  });
});
