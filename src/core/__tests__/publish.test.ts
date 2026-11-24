import { describe, it, expect } from "vitest";
import {
  publishSystemPrompt,
  publishUserPrompt,
  parsePublishCopies,
  publishRewritePrompt,
  generatePublishCopies,
  postTextFile,
  type PublishSource,
  type PublishChatFn,
} from "../publish";

const LLM = { baseUrl: "http://x/v1", apiKey: "k", model: "m" };

const SOURCES: PublishSource[] = [
  { id: 1, title: "半杯水都不渗", hook: "你看这个吸水速度", text: "正文".repeat(400), keywords: ["吸水速度"] },
  { id: 2, title: "差价10倍", hook: "有什么区别", text: "正文", keywords: [] },
];

describe("publishUserPrompt", () => {
  it("素材逐条成段,正文截断到 300 字", () => {
    const p = publishUserPrompt(SOURCES, "zh");
    expect(p).toContain("[1] 片名:半杯水都不渗 钩子:你看这个吸水速度 关键词:吸水速度");
    expect(p).toContain("[2]");
    const line1 = p.split("\n\n")[0];
    expect(line1.length).toBeLessThan(400);
  });

  it("土耳其语素材块用土耳其语字段名(不再夹中文标签)", () => {
    const p = publishUserPrompt(SOURCES, "tr");
    expect(p).toContain("Klip adı:半杯水都不渗");
    expect(p).toContain("Kanca:");
    expect(p).toContain("Anahtar kelimeler:吸水速度");
    expect(p).not.toContain("片名:");
    expect(p).not.toContain("钩子:");
  });
});

describe("parsePublishCopies", () => {
  it("解析标准输出,# 前缀自动补齐,标签截到 6 个", () => {
    const content = JSON.stringify({
      posts: [
        { id: 1, title: "倒半杯水会怎样?", hashtags: ["#纸巾测评", "好物推荐", "#a", "#b", "#c", "#d", "#e"], description: "实测给你看。" },
      ],
    });
    const map = parsePublishCopies(content, new Set([1]));
    const c = map.get(1)!;
    expect(c.title).toBe("倒半杯水会怎样?");
    expect(c.hashtags[1]).toBe("#好物推荐"); // 自动补 #
    expect(c.hashtags.length).toBe(6);
    expect(c.description).toBe("实测给你看。");
  });

  it("无效条目跳过:缺标题/未知 id/垃圾输出", () => {
    expect(parsePublishCopies('{"posts":[{"id":1,"hashtags":[]}]}', new Set([1])).size).toBe(0);
    expect(parsePublishCopies('{"posts":[{"id":9,"title":"x"}]}', new Set([1])).size).toBe(0);
    expect(parsePublishCopies("做不到", new Set([1])).size).toBe(0);
  });

  it("剥 think 块后仍能解析", () => {
    const map = parsePublishCopies('<think>嗯</think>{"posts":[{"id":1,"title":"钩子标题"}]}', new Set([1]));
    expect(map.get(1)?.title).toBe("钩子标题");
    expect(map.get(1)?.hashtags).toEqual([]);
  });

  it("角度与 CTA:菜单内保留,菜单外丢弃成没标,ctaType 只在有 cta 时保留", () => {
    const content = JSON.stringify({
      posts: [
        { id: 1, title: "A", angle: "pain", cta: "评论区聊聊你的做法", ctaType: "comment" },
        { id: 2, title: "B", angle: "clickbait", cta: "  ", ctaType: "comment" },
        { id: 3, title: "C", ctaType: "share" },
      ],
    });
    const map = parsePublishCopies(content, new Set([1, 2, 3]));
    expect(map.get(1)).toMatchObject({ angle: "pain", cta: "评论区聊聊你的做法", ctaType: "comment" });
    expect(map.get(2)?.angle).toBeUndefined();
    expect(map.get(2)?.cta).toBeUndefined();
    expect(map.get(3)?.ctaType).toBeUndefined(); // 没有 cta 正文,类型标签没意义
  });
});

describe("generatePublishCopies", () => {
  it("正常路径:中文提示词 + id 素材对", async () => {
    const chat: PublishChatFn = async (_llm, system, user) => {
      expect(system).toContain("短视频运营");
      expect(user).toContain("[1] 片名:半杯水都不渗");
      return '{"posts":[{"id":1,"title":"A","hashtags":["#x"],"description":"d"},{"id":2,"title":"B"}]}';
    };
    const map = await generatePublishCopies(SOURCES, "zh", LLM, chat);
    expect(map?.size).toBe(2);
  });

  it("英文素材走英文提示词", async () => {
    const chat: PublishChatFn = async (_llm, system) => {
      expect(system).toContain("social manager");
      return '{"posts":[{"id":1,"title":"A"}]}';
    };
    await generatePublishCopies(SOURCES, "en", LLM, chat);
  });

  it("土耳其语素材走土耳其语提示词(修掉「tr 当 zh 出中文文案」)", async () => {
    let seenSystem = "";
    let seenUser = "";
    const chat: PublishChatFn = async (_llm, system, user) => {
      seenSystem = system;
      seenUser = user;
      return '{"posts":[{"id":1,"title":"A"}]}';
    };
    const map = await generatePublishCopies(SOURCES, "tr", LLM, chat);
    expect(map?.size).toBe(1);
    expect(seenSystem).toContain("Kısa video sosyal medya yöneticisisin");
    expect(seenSystem).toContain("kanca açısı menüsünden");
    expect(seenSystem).toContain("pain = ");
    expect(seenSystem).not.toMatch(/[一-鿿]/);
    expect(seenUser).toContain("Klip adı:");
  });

  it("端点失败/解析为空 → fail-open null;上游取消上抛", async () => {
    expect(await generatePublishCopies(SOURCES, "zh", LLM, async () => { throw new Error("down"); })).toBeNull();
    expect(await generatePublishCopies(SOURCES, "zh", LLM, async () => "垃圾")).toBeNull();
    expect(await generatePublishCopies([], "zh", LLM, async () => "{}")).toBeNull();
    const ac = new AbortController();
    ac.abort();
    await expect(
      generatePublishCopies(SOURCES, "zh", LLM, async () => { throw new Error("aborted"); }, ac.signal)
    ).rejects.toThrow();
  });
});

describe("generatePublishCopies 返工(v0.38)", () => {
  /** 首轮:1 号是套话(必被点名),2 号干净。 */
  const DIRTY = '{"posts":[{"id":1,"title":"今天聊聊吸水性"},{"id":2,"title":"桌上一杯水倒了三天"}]}';

  it("干净的一批只花一次调用(不在常态路径上加钱)", async () => {
    let calls = 0;
    const map = await generatePublishCopies(SOURCES, "zh", LLM, async () => {
      calls++;
      return '{"posts":[{"id":1,"title":"半杯水都不渗,这张纸凭什么"},{"id":2,"title":"桌上一杯水倒了三天"}]}';
    });
    expect(calls).toBe(1);
    expect(map?.size).toBe(2);
  });

  it("命中套话 → 恰好一次返工,只覆盖点名条目、保留原有角度与 CTA", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const chat: PublishChatFn = async (_llm, system, user) => {
      seen.push({ system, user });
      if (seen.length === 1) {
        return '{"posts":[{"id":1,"title":"今天聊聊吸水性","angle":"pain","cta":"收藏慢慢看","ctaType":"save"},{"id":2,"title":"桌上一杯水倒了三天"}]}';
      }
      return '{"posts":[{"id":1,"title":"半杯水都不渗,这张纸凭什么"}]}';
    };
    const map = await generatePublishCopies(SOURCES, "zh", LLM, chat);
    expect(seen).toHaveLength(2);
    expect(seen[1].system).toContain("【返工】");
    expect(seen[1].system).toContain("短视频运营"); // 仍是同一套系统提示词打底
    expect(seen[1].user).toContain("[1]");
    expect(seen[1].user).not.toContain("[2]"); // 没点名的条目不进返工素材
    expect(seen[1].user).toContain("当前标题:");
    expect(map!.get(1)!.title).toBe("半杯水都不渗,这张纸凭什么");
    expect(map!.get(2)!.title).toBe("桌上一杯水倒了三天");
    expect(map!.get(1)!.angle).toBe("pain"); // 不是角度重复 → 首轮角度保留
    expect(map!.get(1)!.ctaType).toBe("save");
  });

  it("返工还是套话(没变好)就不覆盖", async () => {
    let calls = 0;
    const chat: PublishChatFn = async () => {
      calls++;
      return calls === 1 ? '{"posts":[{"id":1,"title":"今天聊聊吸水性"}]}' : '{"posts":[{"id":1,"title":"本视频聊聊吸水性"}]}';
    };
    const map = await generatePublishCopies([SOURCES[0]], "zh", LLM, chat);
    expect(calls).toBe(2);
    expect(map!.get(1)!.title).toBe("今天聊聊吸水性");
  });

  it("返工抛错/吐垃圾 → 首轮成果保住(fail-open)", async () => {
    let calls = 0;
    const throwing: PublishChatFn = async () => {
      calls++;
      if (calls === 1) return '{"posts":[{"id":1,"title":"今天聊聊吸水性"}]}';
      throw new Error("down");
    };
    expect((await generatePublishCopies([SOURCES[0]], "zh", LLM, throwing))!.get(1)!.title).toBe("今天聊聊吸水性");
    expect(calls).toBe(2);

    let calls2 = 0;
    const garbage: PublishChatFn = async () => {
      calls2++;
      return calls2 === 1 ? '{"posts":[{"id":1,"title":"今天聊聊吸水性"}]}' : "做不到";
    };
    expect((await generatePublishCopies([SOURCES[0]], "zh", LLM, garbage))!.get(1)!.title).toBe("今天聊聊吸水性");
  });

  it("返工写没被点名的 id 不算数", async () => {
    let calls = 0;
    const chat: PublishChatFn = async () => {
      calls++;
      return calls === 1 ? DIRTY : '{"posts":[{"id":2,"title":"半杯水都不渗,这张纸凭什么"}]}';
    };
    const map = await generatePublishCopies(SOURCES, "zh", LLM, chat);
    expect(calls).toBe(2);
    expect(map!.get(1)!.title).toBe("今天聊聊吸水性");
    expect(map!.get(2)!.title).toBe("桌上一杯水倒了三天");
  });

  it("返工途中上游取消 → 上抛(取消契约不变)", async () => {
    const ac = new AbortController();
    let calls = 0;
    const chat: PublishChatFn = async () => {
      calls++;
      if (calls === 1) return '{"posts":[{"id":1,"title":"今天聊聊吸水性"}]}';
      ac.abort();
      throw new Error("aborted");
    };
    await expect(generatePublishCopies([SOURCES[0]], "zh", LLM, chat, ac.signal)).rejects.toThrow();
  });

  it("土耳其语返工提示词的返工抬头也是土耳其语", async () => {
    const seen: string[] = [];
    const chat: PublishChatFn = async (_llm, system) => {
      seen.push(system);
      return seen.length === 1 ? '{"posts":[{"id":1,"title":"Merhaba arkadaşlar, bugün şunu konuşalım"}]}' : '{"posts":[]}';
    };
    await generatePublishCopies([SOURCES[0]], "tr", LLM, chat);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("Yeniden düzenleme");
    expect(seen[1]).not.toMatch(/[一-鿿]/);
  });

  it("publishRewritePrompt:素材块 + 当前标题 + 问题清单", () => {
    const current = new Map([[1, { title: "今天聊聊吸水性", hashtags: [], description: "" }]]);
    const p = publishRewritePrompt([SOURCES[0]], current, [{ id: 1, field: "title", codes: ["generic-opener"] }], "zh");
    expect(p).toContain("[1] 片名:半杯水都不渗"); // 同一份证据链
    expect(p).toContain("当前标题:");
    expect(p).toContain("[1] 今天聊聊吸水性");
    expect(p).toContain("套话");
  });
});

describe("postTextFile", () => {
  it("标题+话题+简介三段,空段省略", () => {
    expect(postTextFile({ title: "T", hashtags: ["#a", "#b"], description: "D" })).toBe("T\n\n#a #b\n\nD\n");
    expect(postTextFile({ title: "T", hashtags: [], description: "" })).toBe("T\n");
  });

  it("CTA 缀在简介后一行;没简介时 CTA 独立成段", () => {
    expect(postTextFile({ title: "T", hashtags: [], description: "D", cta: "关注我下期拆解", ctaType: "follow" })).toBe(
      "T\n\nD\n关注我下期拆解\n"
    );
    expect(postTextFile({ title: "T", hashtags: [], description: "", cta: "收藏慢慢看" })).toBe("T\n\n收藏慢慢看\n");
  });

  it("AIGC 提醒跟界面语言走;缺省仍是中文(CLI/MCP 输出不变)", () => {
    const copy = { title: "T", hashtags: [], description: "D" };
    expect(postTextFile(copy, true)).toContain("【AIGC 标注】");
    expect(postTextFile(copy, true, "zh")).toContain("【AIGC 标注】");
    expect(postTextFile(copy, true, "tr")).toContain("[AIGC beyanı]");
    expect(postTextFile(copy, true, "en")).toContain("[AIGC label]");
    // 没开 AIGC 标识就一行都不加
    expect(postTextFile(copy, false, "tr")).toBe("T\n\nD\n");
  });
});
