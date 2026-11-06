import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readAppSettings, settingsPath, writeAppSettings } from "../app-settings";

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hotclip-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("app settings", () => {
  it("round-trips the whisper.cpp paths next to the models directory", async () => {
    await withDir(async (dir) => {
      writeAppSettings(dir, { modelsDir: "D:\\models", whisperCppBin: "C:\\w\\whisper-cli.exe", whisperCppModel: "C:\\w\\ggml.bin" });
      expect(readAppSettings(dir)).toEqual({
        modelsDir: "D:\\models",
        whisperCppBin: "C:\\w\\whisper-cli.exe",
        whisperCppModel: "C:\\w\\ggml.bin",
      });
    });
  });

  it("drops blank values instead of storing empty paths", async () => {
    await withDir(async (dir) => {
      writeAppSettings(dir, { whisperCppBin: "   ", whisperCppModel: "" });
      expect(readAppSettings(dir)).toEqual({});
    });
  });

  it("survives a missing or corrupt settings file", async () => {
    await withDir(async (dir) => {
      expect(readAppSettings(dir)).toEqual({});
      await writeFile(settingsPath(dir), "{ not json", "utf8");
      expect(readAppSettings(dir)).toEqual({});
      await writeFile(settingsPath(dir), JSON.stringify({ whisperCppBin: 42, whisperCppModel: "  C:\\m.bin  " }), "utf8");
      expect(readAppSettings(dir)).toEqual({ whisperCppModel: "C:\\m.bin" });
    });
  });
});
