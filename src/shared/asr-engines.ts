/**
 * Local ASR engine ids, shared by every entry point (desktop IPC, headless
 * CLI, MCP tool schemas) so a new tier cannot be added to one surface and
 * forgotten in another. Cloud engines (elevenlabs) are validated separately
 * because they need credentials instead of a model.
 */
export const LOCAL_ASR_ENGINE_IDS = ["sensevoice", "paraformer", "fireredasr", "whisper", "whisper-cpp", "qwen3"] as const;

export type LocalAsrEngineId = (typeof LOCAL_ASR_ENGINE_IDS)[number];

export function isLocalAsrEngineId(value: unknown): value is LocalAsrEngineId {
  return typeof value === "string" && (LOCAL_ASR_ENGINE_IDS as readonly string[]).includes(value);
}
