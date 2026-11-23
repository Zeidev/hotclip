import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoClipConfig } from "../pipeline";
import type { Transcript, TranscriptSegment } from "../../shared/api-types";

vi.mock("../probe", () => ({ probeMedia: vi.fn(async () => ({ hasVideo: false })) }));
vi.mock("../media-evidence", () => ({
  collectSignalsEvidence: vi.fn(async () => undefined), detectShotBoundariesEvidence: vi.fn(),
}));
vi.mock("../emotion", () => ({ collectEmotionSignal: vi.fn(async () => null) }));
vi.mock("../voice-emotion", () => ({ collectVoiceEmotionSignal: vi.fn(async () => null) }));
vi.mock("../danmaku", () => ({ collectDanmakuSignal: vi.fn(async () => null) }));
vi.mock("../subtitle-import", () => ({ importSubtitleFile: vi.fn() }));
vi.mock("../export", () => ({ exportClips: vi.fn(async () => []), sanitizeFilename: (s: string) => s }));

import { detectForPipeline } from "../pipeline";
import { MAX_STAGE1_PASSES, REVIEW_BATCH, STAGE1_PASS_MAX, planStage1 } from "../highlight/detect";
import { buildHighlightPrompt } from "../highlight/prompt";

// 40 句 × 20 秒:足够长到值得分窗口,又落在默认 standard 时长带里。
const segments: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  startSec: i * 20,
  endSec: i * 20 + 20,
  text: `第${i + 1}个话题从背景一路讲到结论,整段都讲完了。`,
  words: [],
}));
const transcript: Transcript = { engine: "test", language: "zh", durationSec: 800, segments };
const config: AutoClipConfig = {
  modelsRoot: "/unused", cacheDir: "/unused", outDir: "/unused/output", subtitlePath: "/unused/source.srt",
  llm: { baseUrl: "http://localhost:11434/v1", model: "test", apiKey: "test" },
};

interface Req { messages: Array<{ content: string }> }
let requests: Req[];
/** scope index (1-based) → HTTP status to fail with; absent = success. */
let failWindow = new Set<number>();

const clipFor = (id: number) => {
  const s = segments[id - 1];
  return {
    title: `话题${id}`, hook: s.text, quoteStart: s.text, quoteEnd: s.text,
    startSegmentId: id, endSegmentId: id, score: 90, reason: "完整话题", keywords: [],
  };
};
const body = (payload: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
}));

/** 从窗口提示词里读出这一轮拿到哪些句 id。 */
const windowIds = (user: string): number[] =>
  [...user.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));

beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  failWindow = new Set();
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Req;
    requests.push(req);
    const user = req.messages[1].content;
    if (user.includes("【高能时刻清单】")) return body({ clips: [] });
    if (/盲评下面的候选片段/.test(user)) {
      const ids = [...user.matchAll(/【候选 (\d+)】/g)].map((m) => Number(m[1]));
      return body({
        reviews: ids.map((id) => ({
          id, verdict: "publish", hook: 90, flow: 90, value: 90, trend: 90, payoff: 90,
          teaser: "先别走", loop: false, note: "完整",
        })),
      });
    }
    const scope = user.match(/第 (\d+)\/(\d+) 段/);
    const index = scope ? Number(scope[1]) : 1;
    if (failWindow.has(index)) return new Response("upstream boom", { status: 500 });
    return body({ clips: windowIds(user).slice(0, 10).map(clipFor) });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const stage1Requests = () => requests.filter((r) => r.messages[1].content.includes("挑出最多"));
const reviewRequests = () => requests.filter((r) => r.messages[1].content.includes("盲评下面的候选片段"));

describe("planStage1", () => {
  it("keeps a single window up to the single-pass ceiling", () => {
    for (const limit of [1, 6, 12]) {
      const plan = planStage1(segments, limit);
      expect(plan.windows).toHaveLength(1);
      expect(plan.windows[0]).toHaveLength(40);
      expect(plan.cap).toBe(limit);
    }
  });

  it("splits into contiguous windows that cover the transcript once", () => {
    const plan = planStage1(segments, 20);
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows.flat().map((s) => s.id)).toEqual(segments.map((s) => s.id));
    // 每窗留余量,不然「宁缺毋滥」会让某一窗交白卷
    expect(plan.cap).toBeGreaterThan(Math.ceil(20 / 2));
  });

  it("caps the window count at four however many clips are asked for", () => {
    expect(planStage1(segments, 40).windows).toHaveLength(4);
    expect(MAX_STAGE1_PASSES).toBe(4);
  });

  it("cuts fewer windows when the transcript is short", () => {
    // 8 句 = 正好一个 MIN_WINDOW_SEGMENTS 窗口,即使要 40 条也不切
    expect(planStage1(segments.slice(0, 8), 40).windows).toHaveLength(1);
    expect(planStage1(segments.slice(0, 17), 40).windows).toHaveLength(2);
    // 空稿不崩
    expect(planStage1([], 40).windows).toHaveLength(1);
  });

  it("uses 12 as the single-pass ceiling", () => {
    expect(STAGE1_PASS_MAX).toBe(12);
  });
});

describe("multi-window detection", () => {
  it("runs one stage-1 call per window and batches stage-2 review", async () => {
    const candidates = await detectForPipeline("/source.mp4", transcript, { ...config, maxClips: 20 });
    expect(stage1Requests()).toHaveLength(2);
    const prompts = stage1Requests().map((r) => r.messages[1].content);
    expect(prompts.some((p) => p.includes("第 1/2 段"))).toBe(true);
    expect(prompts.some((p) => p.includes("第 2/2 段"))).toBe(true);
    // 20 条候选 → 12 + 8 两批复评
    expect(reviewRequests()).toHaveLength(2);
    expect(reviewRequests().map((r) => [...r.messages[1].content.matchAll(/【候选 (\d+)】/g)].length).sort((a, b) => a - b))
      .toEqual([8, 12]);
    expect(REVIEW_BATCH).toBe(12);
    expect(candidates).toHaveLength(20);
    // 覆盖面:第二个窗口(第 21 句起 = 400 秒后)的候选也在,不是只挑全场最好的 20 条
    expect(candidates.some((c) => c.startSec >= 400)).toBe(true);
    expect(candidates.some((c) => c.startSec < 400)).toBe(true);
  });

  it("keeps the default ceiling on the single-call path", async () => {
    const candidates = await detectForPipeline("/source.mp4", transcript, { ...config, maxClips: 12 });
    expect(stage1Requests()).toHaveLength(1);
    expect(stage1Requests()[0].messages[1].content).not.toMatch(/第 \d+\/\d+ 段/);
    expect(reviewRequests()).toHaveLength(1);
    expect(candidates).toHaveLength(10);
  });

  it("keeps the surviving window's candidates when one window fails", async () => {
    failWindow = new Set([2]);
    const candidates = await detectForPipeline("/source.mp4", transcript, { ...config, maxClips: 20 });
    expect(stage1Requests()).toHaveLength(2);
    expect(reviewRequests()).toHaveLength(1);
    expect(candidates).toHaveLength(10);
    // 只有第一个窗口活下来:候选全部来自 400 秒之前的句子
    expect(candidates.every((c) => c.startSec < 400)).toBe(true);
  });

  it("throws the first window's error when every window fails", async () => {
    failWindow = new Set([1, 2]);
    await expect(detectForPipeline("/source.mp4", transcript, { ...config, maxClips: 20 }))
      .rejects.toThrow(/HTTP 500/);
    expect(reviewRequests()).toHaveLength(0);
  });
});

describe("stage-1 scope line", () => {
  const three = (language: string, texts: string[]): Transcript => ({
    engine: "test", language, durationSec: 12,
    segments: texts.map((text, i) => ({ id: i + 1, startSec: i * 4, endSec: i * 4 + 4, text, words: [] })),
  });
  const trTx = three("tr", [
    "Bunu kimse söylemiyor ama indirim asla gelmiyor.",
    "Şimdi her şeye yüzde elli indirim yapıyoruz.",
    "Iğdır'dan gelen siparişler de dahil.",
  ]);
  const enTx = three("en", [
    "Nobody says this out loud, but the discount never comes.",
    "Right now we are cutting every price in half.",
    "Orders from out of town count too.",
  ]);

  it("tells the model which slice it is reading, in the transcript's language", () => {
    const zh = buildHighlightPrompt(transcript, 12, undefined, { index: 2, total: 3 });
    expect(zh).toContain("第 2/3 段");
    expect(zh).not.toMatch(/part 2\/3|bölümü/);

    const tr = buildHighlightPrompt(trTx, 12, undefined, { index: 2, total: 3 });
    expect(tr).toContain("yalnız 2/3. bölümü veriliyor");
    expect(/[一-鿿]/.test(tr)).toBe(false);

    const en = buildHighlightPrompt(enTx, 12, undefined, { index: 2, total: 3 });
    expect(en).toContain("only part 2/3 of the transcript");
    expect(/[一-鿿]/.test(en)).toBe(false);
  });

  it("omits the scope line for the whole-transcript call", () => {
    expect(buildHighlightPrompt(transcript, 12)).not.toMatch(/第 \d+\/\d+ 段/);
    expect(buildHighlightPrompt(trTx, 12)).not.toContain("bölümü veriliyor");
    expect(buildHighlightPrompt(enTx, 12)).not.toContain("only part");
  });
});
