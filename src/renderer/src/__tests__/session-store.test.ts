/**
 * 自动保存的触发判定(checkpointFieldsChanged):检测进度/阶段是每几百毫秒一跳的
 * 瞬态字段,不入 checkpoint;若它们也重开 650ms 防抖窗口,草稿就永远等不到安静、
 * 一直不落盘。反过来,任何会进 checkpoint 的字段都必须触发保存。
 */
import { describe, expect, it } from "vitest";
import { checkpointFieldsChanged, useSession, type SessionState } from "../stores/session-store";

const base = useSession.getState();
const withPatch = (patch: Partial<SessionState>): SessionState => ({ ...base, ...patch });

describe("checkpointFieldsChanged", () => {
  it("同一份状态不触发", () => {
    expect(checkpointFieldsChanged(base, base)).toBe(false);
  });

  it("瞬态字段(检测进度/阶段/报错/导出中/弹层)不触发", () => {
    const next = withPatch({
      detecting: true,
      detectStage: "chat",
      detectStartedAt: Date.now(),
      detectError: "boom",
      exporting: { clips: [], options: {} as never },
      settingsOpen: true,
      auto: true,
    });
    expect(checkpointFieldsChanged(base, next)).toBe(false);
  });

  it("每个会落盘的字段单独变化都触发", () => {
    const cases: Partial<SessionState>[] = [
      { file: { path: "/a.mp4" } as never },
      { transcript: {} as never },
      { candidates: [] },
      { selected: new Set<number>() },
      { focusedId: 1 },
      { stats: { ...base.stats } },
      { diarize: true },
      { referencePath: "/ref.mp4" },
      { paramsDirty: true },
      { editHistory: { undo: [], redo: [] } },
    ];
    for (const patch of cases) expect(checkpointFieldsChanged(base, withPatch(patch))).toBe(true);
  });
});