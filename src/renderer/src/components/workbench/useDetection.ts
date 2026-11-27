/**
 * 检测编排:把「调 detectHighlights → 结果落 session store」收成一个动作。
 * 与旧版最大的区别:参数改动只标脏,唯一的触发点是显式调用 run()——
 * 「重新检测」按钮是花 LLM 钱的那只手,用户永远知道自己按了它。
 */
import { useCallback } from "react";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useLlmStore } from "../../stores/llm-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { stripIpcError } from "../../../../shared/transcribe-errors";

// 结果回写的世代号:检测跑在 IPC 上,回来时项目可能已经换了、逐句稿可能已经重转录。
// 旧一次的结果不能盖到新状态上(store 的 detecting 也只能由当前那次收尾)。
let detectRunSeq = 0;
let liveDetectRun = 0;

export function useDetection(): { run: () => Promise<void> } {
  const { config, prefilter, vision } = useLlmStore();
  const { prefs } = useRenderPrefs();

  const run = useCallback(async (): Promise<void> => {
    const s = useSession.getState();
    if (!s.transcript || s.detecting) return;
    const runId = ++detectRunSeq;
    liveDetectRun = runId;
    const sourceTranscript = s.transcript;
    const stale = (): boolean => {
      const current = useSession.getState();
      return runId !== liveDetectRun || current.transcript !== sourceTranscript;
    };
    s.setDetecting(true);
    s.setDetectError(null);
    // 阶段提示只是「卡在哪一步」的标签:主进程发、这里收,漏掉几帧不影响结果。
    const offStage = getApi().onDetectStage((p) => useSession.getState().setDetectStage(p.stage));
    try {
      const focus = prefs.briefFocus.trim();
      const exclude = prefs.briefExclude.trim();
      const result = await getApi().detectHighlights(
        s.transcript,
        config,
        s.file?.path,
        s.diarize,
        prefilter.enabled ? { baseUrl: prefilter.baseUrl, model: prefilter.model } : null,
        vision.enabled ? { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey || undefined } : null,
        prefs.clipLength,
        prefs.products,
        s.referencePath,
        { id: prefs.genreId, custom: prefs.genreCustom },
        focus || exclude ? { focus: focus || undefined, exclude: exclude || undefined } : null,
        prefs.fullScan && vision.enabled,
        prefs.maxClips,
        prefs.promptLang
      );
      const st = useSession.getState();
      // 换代或换稿:这批结果已经不属于当前会话,整批丢弃。
      if (stale()) return;
      st.setCandidates(result.candidates);
      st.setStats({
        funnel: result.funnel ?? null,
        vision: result.vision ?? null,
        emotion: result.emotion ?? null,
        danmaku: result.danmaku ?? null,
        voice: result.voice ?? null,
        reference: result.reference ?? null,
        referenceError: result.referenceError ?? null,
      });
      // 复评通过的预选出片;右栏聚焦第一条推荐(没有就第一条)
      st.setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      st.setFocusedId(result.candidates.find((c) => c.recommended)?.id ?? result.candidates[0]?.id ?? null);
      // 带说话人标注的逐句稿回流(导出按说话人给字幕上色)
      if (result.transcript) st.setTranscript(result.transcript);
      st.markParamsDirty(false);
    } catch (e) {
      // IPC 包装串只会淹没真正有用的那句话——先剥壳再展示(issue #6)
      // 过期那次的报错同样无关当前会话,不往界面上丢。
      if (!stale()) useSession.getState().setDetectError(stripIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      offStage();
      if (runId === liveDetectRun) {
        liveDetectRun = 0;
        useSession.getState().setDetecting(false);
      }
    }
  }, [config, prefilter, vision, prefs]);

  return { run };
}
