import { afterEach, describe, expect, it, vi } from "vitest";
import { llmRequestBudget, modelErrorDetail, requestLlmText, retryAfterMs } from "../llm-transport";

const URL = "http://127.0.0.1:11434/v1/chat/completions";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("模型请求等待与响应边界", () => {
  it("响应头一直不来时超时，且不重发已可能被接收的请求", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestLlmText(URL, {}, { budget: llmRequestBudget(100, 1) });
    const check = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("收到响应头后正文卡住也能超时并关闭流", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); }, cancel,
    }))));
    const pending = requestLlmText(URL, {}, { budget: llmRequestBudget(100) });
    const check = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("用户取消在读正文时保留取消原因且释放流", async () => {
    const controller = new AbortController();
    let began!: () => void;
    const reading = new Promise<void>((resolve) => { began = resolve; });
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() { began(); }, cancel }))));
    const pending = requestLlmText(URL, {}, { signal: controller.signal });
    const reason = new Error("user-cancelled");
    const check = expect(pending).rejects.toBe(reason);
    await reading;
    controller.abort(reason);
    await check;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("UTF-8 字符跨响应块时不损坏文本", async () => {
    const bytes = new TextEncoder().encode("字幕 café");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1, 5)); c.enqueue(bytes.slice(5)); c.close();
    } }))));
    expect((await requestLlmText(URL, {})).text).toBe("字幕 café");
  });

  it.each([true, false])("在 Content-Length 已知或流式累积时拒绝过大正文 (%s)", async (declared) => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel }), {
      headers: declared ? { "content-length": "20" } : {},
    })));
    await expect(requestLlmText(URL, {}, { maxBytes: 10 })).rejects.toMatchObject({ kind: "response-too-large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("请求前已取消时不访问模型服务", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(requestLlmText(URL, {}, { signal: AbortSignal.abort(new Error("stopped")) })).rejects.toThrow("stopped");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("模型请求有限重试", () => {
  it("遵守秒数与日期格式 Retry-After", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("Wed, 16 Sep 2026 12:00:02 GMT", Date.parse("2026-09-16T12:00:00Z"))).toBe(2000);
    for (const value of [null, "", "-1", "nonsense"]) expect(retryAfterMs(value)).toBeNull();
  });

  it.each([429, 503])("短暂 HTTP %s 后等待再成功，释放所有定时器", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("busy", { status, headers: { "retry-after": "1" } })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestLlmText(URL, {}, { budget: llmRequestBudget(5000, 1) });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 500])("HTTP %s 不自动重试", async (status) => {
    const fetchMock = vi.fn(async () => new Response("failure", { status })); vi.stubGlobal("fetch", fetchMock);
    expect((await requestLlmText(URL, {}, { budget: llmRequestBudget(5000, 1) })).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("余额不足的 429 不反复请求", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await requestLlmText(URL, {}, { budget: llmRequestBudget(5000, 1) })).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("服务端要求长等待时交回调用方，不提前重试", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await requestLlmText(URL, {}, { budget: llmRequestBudget(300000, 1) })).headers.get("retry-after")).toBe("120");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("等待重试时取消不会再次发请求", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503, headers: { "retry-after": "2" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestLlmText(URL, {}, { signal: controller.signal, budget: llmRequestBudget(5000, 1) });
    const check = expect(pending).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("stopped"));
    await check;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("断网异常不重复发送", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("fetch failed"); }); vi.stubGlobal("fetch", fetchMock);
    await expect(requestLlmText(URL, {}, { budget: llmRequestBudget(5000, 1) })).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("错误详情隐藏服务商回显的密钥", () => {
    expect(modelErrorDetail('{"error":{"message":"Invalid key sk-secret"}}', "sk-secret")).toBe("Invalid key [redacted]");
    expect(modelErrorDetail("Authorization: Bearer secret-value", "")).not.toContain("secret-value");
  });
});
