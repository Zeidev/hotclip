import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { ASR_CATALOG } from "../asr-catalog";
import { isLocalAsrEngineId, LOCAL_ASR_ENGINE_IDS } from "../asr-engines";
import { MCP_TOOLS } from "../../mcp/protocol";
import { MODEL_CATALOG } from "../../core/models-inventory";
import { WHISPER_TURBO_MODEL } from "../../core/models";

describe("ASR engine registry", () => {
  it("keeps the shared id list and the catalog in sync (no surface forgotten)", () => {
    const local = ASR_CATALOG.filter((engine) => engine.kind === "local").map((engine) => engine.id).sort();
    expect(local).toEqual([...LOCAL_ASR_ENGINE_IDS].sort());
  });

  it("offers Whisper as an offline tier for languages the CJK models cannot hear", () => {
    const whisper = ASR_CATALOG.find((engine) => engine.id === "whisper");
    expect(whisper).toMatchObject({ kind: "local", uploads: false });
    expect(whisper?.langs).toContain("tr");
    expect(MODEL_CATALOG.some((row) => row.asset === WHISPER_TURBO_MODEL)).toBe(true);
  });

  it("advertises the same engine ids in every MCP tool schema", () => {
    let checked = 0;
    for (const tool of MCP_TOOLS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
      if (!properties.engineId) continue;
      expect(properties.engineId.enum).toEqual([...LOCAL_ASR_ENGINE_IDS]);
      expect(properties.language).toBeDefined();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("accepts only known engine ids", () => {
    expect(isLocalAsrEngineId("whisper")).toBe(true);
    expect(isLocalAsrEngineId("fireredasr")).toBe(true);
    expect(isLocalAsrEngineId("whisper-large")).toBe(false);
    expect(isLocalAsrEngineId("toString")).toBe(false);
    expect(isLocalAsrEngineId(undefined)).toBe(false);
  });

  it("is dispatched by every surface that builds a local engine", async () => {
    // Adding a tier means touching the desktop worker, the IPC map and the
    // headless pipeline. Miss one and the engine silently falls back to
    // SenseVoice for that entry point — this test fails instead.
    for (const file of ["src/main/speech-worker.ts", "src/main/index.ts", "src/core/pipeline.ts"]) {
      const source = await readFile(resolve(process.cwd(), file), "utf8");
      for (const id of LOCAL_ASR_ENGINE_IDS) {
        expect(source, `${file} does not dispatch "${id}"`).toContain(id);
      }
    }
  });
});
