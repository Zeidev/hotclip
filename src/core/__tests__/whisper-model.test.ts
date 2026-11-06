import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bpeTokensToWords, tokensToWords } from "../transcribe/sherpa-offline";
import { isModelDirComplete, sha256File, WHISPER_TURBO_MODEL, type ModelAsset } from "../models";
import { whisperEngineSpec, whisperModelDirOverride, WhisperEngine } from "../transcribe/whisper";
import { resolveWhisperCpp, whisperCppWords, WhisperCppEngine, type WhisperCppJson } from "../transcribe/whisper-cpp";
import { transcriptCacheKey } from "../pipeline";

/** Whisper's byte-level BPE marks a word start with U+2581. */
const M = "\u2581";

describe("Whisper BPE tokens → words", () => {
  it("joins sub-word pieces into one word and spans the group", () => {
    const words = bpeTokensToWords(
      { text: "Merhaba dünya", tokens: [`${M}Mer`, "haba", `${M}dün`, "ya"], timestamps: [0, 0.4, 0.9, 1.3] },
      0,
      10
    );
    expect(words.map((w) => w.text)).toEqual(["Merhaba", "dünya"]);
    // First word ends where the next word starts, not at its own last piece.
    expect(words[0]).toMatchObject({ startSec: 0, endSec: 0.9, timingSource: "native" });
    expect(words[1].startSec).toBe(0.9);
    // Last word has no following stamp: short tail, clamped to the window.
    expect(words[1].endSec).toBeCloseTo(1.2, 5);
    expect(words[1].endSec).toBeLessThanOrEqual(10);
  });

  it("falls back to one-token-one-word when no BPE marker is present", () => {
    const raw = { text: "你好", tokens: ["你", "好"], timestamps: [0, 0.5] };
    expect(bpeTokensToWords(raw, 0, 5)).toEqual(tokensToWords(raw, 0, 5));
  });

  it("offsets to the window and never emits times outside it", () => {
    const words = bpeTokensToWords({ text: "hi", tokens: [`${M}hi`], timestamps: [0] }, 28, 28.1);
    expect(words[0].startSec).toBe(28);
    expect(words[0].endSec).toBeLessThanOrEqual(28.1);
  });

  it("marks words without timestamps as estimated", () => {
    expect(bpeTokensToWords({ text: "hi", tokens: [`${M}hi`] }, 0, 5)[0].timingSource).toBe("estimated");
  });
});

describe("multi-file model asset (Whisper turbo)", () => {
  it("lists every file with the CN mirror first and the origin last", () => {
    expect(WHISPER_TURBO_MODEL.files).toHaveLength(3);
    for (const file of WHISPER_TURBO_MODEL.files ?? []) {
      expect(file.urls[0]).toContain("hf-mirror.com");
      expect(file.urls[file.urls.length - 1]).toContain("huggingface.co");
      expect(file.bytes).toBeGreaterThan(0);
    }
  });

  it("reports the total size as the sum of its files", () => {
    const total = (WHISPER_TURBO_MODEL.files ?? []).reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    expect(WHISPER_TURBO_MODEL.approxBytes).toBe(total);
  });

  it("is installed only when every file matches its published size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-whisper-asset-"));
    const asset: ModelAsset = {
      ...WHISPER_TURBO_MODEL,
      files: (WHISPER_TURBO_MODEL.files ?? []).map((file) => ({ ...file, bytes: 4 })),
    };
    try {
      expect(await isModelDirComplete(dir, asset)).toBe(false);
      for (const file of asset.files ?? []) await writeFile(join(dir, file.name), "abcd");
      expect(await isModelDirComplete(dir, asset)).toBe(true);
      // A truncated copy must not pass as installed (reruns would decode garbage).
      await writeFile(join(dir, (asset.files ?? [])[0].name), "ab");
      expect(await isModelDirComplete(dir, asset)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams a file checksum without reading it into memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-sha-"));
    try {
      const path = join(dir, "blob.bin");
      await writeFile(path, "hello");
      expect(await sha256File(path)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("whisper engine spec", () => {
  it("asks sherpa-onnx for token timestamps and the Whisper token table", () => {
    const spec = whisperEngineSpec();
    const config = spec.buildModelConfig("/models/whisper", undefined) as {
      whisper: { encoder: string; decoder: string; language?: string; task: string; enableTokenTimestamps: number };
    };
    // Without enableTokenTimestamps the decoder returns zero timestamps and
    // every word degrades to "estimated" — verified on sherpa-onnx 1.13.3.
    expect(config.whisper.enableTokenTimestamps).toBe(1);
    expect(config.whisper.encoder.endsWith("turbo-encoder.int8.onnx")).toBe(true);
    expect(config.whisper.decoder.endsWith("turbo-decoder.int8.onnx")).toBe(true);
    expect(config.whisper.task).toBe("transcribe");
    expect(config.whisper.language).toBeUndefined();
    expect(spec.tokensFile).toBe("turbo-tokens.txt");
    expect(spec.tokenJoin).toBe("bpe");
    // Whisper punctuates itself: a CT-Transformer pass would double it.
    expect(spec.punctuate).toBe(false);
  });

  it("passes a real language hint through and drops the auto placeholder", () => {
    const config = (language?: string) => (whisperEngineSpec().buildModelConfig("/models/whisper", { language }) as {
      whisper: { language?: string };
    }).whisper;
    expect(config("tr").language).toBe("tr");
    expect(config("auto").language).toBeUndefined();
  });

  it("keeps the user-managed model directory on the spec", () => {
    expect(whisperEngineSpec("D:\\models\\tr").overrideDir).toBe("D:\\models\\tr");
  });
});

describe("whisper.cpp (GPU tier) result parsing", () => {
  const payload: WhisperCppJson = {
    result: { language: "tr" },
    transcription: [
      {
        text: " Merhaba dünya",
        offsets: { from: 0, to: 1600 },
        tokens: [
          { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
          { text: " Mer", offsets: { from: 160, to: 400 } },
          { text: "haba", offsets: { from: 400, to: 800 } },
          { text: " dün", offsets: { from: 900, to: 1200 } },
          { text: "ya", offsets: { from: 1200, to: 1500 } },
          { text: "[_TT_160]", offsets: { from: 1600, to: 1600 } },
        ],
      },
    ],
  };

  it("drops control tokens and joins BPE pieces into real words", () => {
    const { words, language } = whisperCppWords(payload, 2);
    expect(language).toBe("tr");
    expect(words.map((w) => w.text)).toEqual(["Merhaba", "dünya"]);
    expect(words[0]).toMatchObject({ startSec: 0.16, endSec: 0.9, timingSource: "native" });
    expect(words[1].startSec).toBe(0.9);
    expect(words[1].endSec).toBeLessThanOrEqual(2);
  });

  it("pulls word times from token offsets, never past the media duration", () => {
    const { words } = whisperCppWords({ transcription: [{ tokens: [{ text: " hi", offsets: { from: 9000, to: 9500 } }] }] }, 5);
    expect(words[0].startSec).toBe(5);
    expect(words[0].endSec).toBe(5);
  });

  it("falls back to segment spans when a run produced no token detail", () => {
    const { words } = whisperCppWords({ transcription: [{ text: "merhaba dünya", offsets: { from: 1000, to: 3000 } }] }, 4);
    expect(words.map((w) => w.text)).toEqual(["merhaba", "dünya"]);
    expect(words[0].startSec).toBeCloseTo(1, 5);
    expect(words[0].timingSource).toBe("estimated");
  });

  it("returns nothing for an empty run instead of inventing words", () => {
    expect(whisperCppWords({ transcription: [] }, 10).words).toEqual([]);
  });
});

describe("whisper.cpp engine configuration", () => {
  it("needs both the binary and the model, and prefers the environment", () => {
    expect(resolveWhisperCpp({}, {})).toBeNull();
    expect(resolveWhisperCpp({ HOTCLIP_WHISPER_CPP_BIN: "/bin/whisper-cli" }, {})).toBeNull();
    expect(resolveWhisperCpp({ HOTCLIP_WHISPER_CPP_BIN: "/bin/whisper-cli", HOTCLIP_WHISPER_CPP_MODEL: " /m/ggml.bin " }, {}))
      .toEqual({ binary: "/bin/whisper-cli", model: "/m/ggml.bin", noGpu: false });
    expect(resolveWhisperCpp({ HOTCLIP_WHISPER_CPP_BIN: "/b", HOTCLIP_WHISPER_CPP_MODEL: "/m", HOTCLIP_WHISPER_CPP_NO_GPU: "1" }, {})?.noGpu)
      .toBe(true);
  });

  it("falls back to the paths saved from the settings screen", () => {
    // Desktop users have no environment to set: the settings file is the entry.
    expect(resolveWhisperCpp({}, { whisperCppBin: "/saved/whisper-cli.exe", whisperCppModel: "/saved/ggml.bin" }))
      .toEqual({ binary: "/saved/whisper-cli.exe", model: "/saved/ggml.bin", noGpu: false });
    // A half-configured pair stays unconfigured rather than guessing.
    expect(resolveWhisperCpp({}, { whisperCppBin: "/saved/whisper-cli.exe" })).toBeNull();
    // Environment still wins over the file.
    expect(resolveWhisperCpp(
      { HOTCLIP_WHISPER_CPP_BIN: "/env/bin", HOTCLIP_WHISPER_CPP_MODEL: "/env/model" },
      { whisperCppBin: "/saved/bin", whisperCppModel: "/saved/model" }
    )).toMatchObject({ binary: "/env/bin", model: "/env/model" });
  });

  it("is not ready without a wired-up binary and model", async () => {
    expect(await new WhisperCppEngine(null).isReady()).toBe(false);
    expect(await new WhisperCppEngine({ binary: "/nope/whisper-cli", model: "/nope/ggml.bin" }).isReady()).toBe(false);
  });

  it("is ready once both files exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-whisper-cpp-"));
    try {
      const binary = join(dir, "whisper-cli");
      const model = join(dir, "ggml.bin");
      await writeFile(binary, "x");
      await writeFile(model, "y");
      expect(await new WhisperCppEngine({ binary, model }).isReady()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains how to configure itself when asked to transcribe", async () => {
    await expect(new WhisperCppEngine(null).transcribe("x.wav")).rejects.toThrow(/HOTCLIP_WHISPER_CPP_BIN/);
  });
});

describe("transcript cache identity", () => {
  it("separates engines by default and by model variant when one is given", () => {
    expect(transcriptCacheKey("whisper-cpp")).toBe("whisper-cpp");
    expect(transcriptCacheKey("whisper-cpp", "q5_0|574MB")).toBe("whisper-cpp:q5_0|574MB");
    expect(transcriptCacheKey("sensevoice", "")).toBe("sensevoice");
  });

  it("changes when the user swaps the whisper.cpp model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-cache-id-"));
    try {
      const binary = join(dir, "whisper-cli.exe");
      const model = join(dir, "ggml.bin");
      await writeFile(binary, "bin");
      await writeFile(model, "small");
      const first = await new WhisperCppEngine({ binary, model }).cacheIdentity();
      await writeFile(model, "a much longer model file");
      const second = await new WhisperCppEngine({ binary, model }).cacheIdentity();
      expect(first).not.toBe(second);
      expect(first).toContain("ggml.bin");
      expect(await new WhisperCppEngine(null).cacheIdentity()).toBe("unconfigured");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when a user-supplied sherpa model directory changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hotclip-override-id-"));
    try {
      const files = WHISPER_TURBO_MODEL.files ?? [];
      for (const file of files) await writeFile(join(dir, file.name), "x");
      const engine = new WhisperEngine(dir, dir);
      const first = await engine.cacheIdentity();
      expect(first).toContain(dir);
      await writeFile(join(dir, files[0].name), "xxxx");
      expect(await engine.cacheIdentity()).not.toBe(first);
      const before = process.env.HOTCLIP_WHISPER_MODEL_DIR;
      delete process.env.HOTCLIP_WHISPER_MODEL_DIR;
      expect(await new WhisperEngine(dir).cacheIdentity()).toBe("");
      if (before !== undefined) process.env.HOTCLIP_WHISPER_MODEL_DIR = before;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("whisper model directory override", () => {
  it("reads HOTCLIP_WHISPER_MODEL_DIR and ignores blank values", () => {
    const before = process.env.HOTCLIP_WHISPER_MODEL_DIR;
    try {
      process.env.HOTCLIP_WHISPER_MODEL_DIR = "  D:\\models\\tr-whisper  ";
      expect(whisperModelDirOverride()).toBe("D:\\models\\tr-whisper");
      process.env.HOTCLIP_WHISPER_MODEL_DIR = "   ";
      expect(whisperModelDirOverride()).toBeUndefined();
      delete process.env.HOTCLIP_WHISPER_MODEL_DIR;
      expect(whisperModelDirOverride()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.HOTCLIP_WHISPER_MODEL_DIR;
      else process.env.HOTCLIP_WHISPER_MODEL_DIR = before;
    }
  });
});
