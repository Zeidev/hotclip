/**
 * GPU-capable Whisper tier: whisper.cpp as an external CLI.
 *
 * Why a second Whisper engine: the bundled sherpa-onnx runtime is CPU-only, and
 * Whisper turbo (809M encoder) runs at roughly 1.3x realtime on CPU — an hour of
 * stream costs an hour. whisper.cpp ships CUDA / Vulkan / Metal builds, so the
 * same model runs an order of magnitude faster on a GPU.
 *
 * Everything here is user-managed and local, like the Qwen3 service: HotClip
 * never bundles the binary or the model, it only drives them.
 *
 *   HOTCLIP_WHISPER_CPP_BIN=/path/to/whisper-cli(.exe)
 *   HOTCLIP_WHISPER_CPP_MODEL=/path/to/ggml-large-v3-turbo.bin
 *   HOTCLIP_WHISPER_CPP_NO_GPU=1   # force -ng (CPU) on a GPU build
 *
 * `pnpm whisper:cpp-setup` downloads a build plus a model and prints the two
 * variables. Note the official Windows builds need the MSVC runtime
 * (msvcp140.dll) and the OpenMP runtime (vcomp140.dll); the setup tool reports
 * what is missing instead of failing with a bare 0xC0000135.
 */
import { spawn, execFile } from "child_process";
import { cpus, tmpdir } from "os";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { dirname, basename, join } from "path";
import { promisify } from "util";
import { resolveFfmpegPath } from "../binaries";
import { probeMedia } from "../probe";
import { readAppSettings } from "../app-settings";
import { userDataDir } from "../appenv";
import { rebuildWords } from "../../shared/edit-transcript";
import { bpeTokensToWords } from "./sherpa-offline";
import { segmentWords } from "./segment";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

const execFileAsync = promisify(execFile);

export interface WhisperCppConfig {
  /** whisper-cli (or legacy main) executable. */
  binary: string;
  /** ggml model file (e.g. ggml-large-v3-turbo.bin). */
  model: string;
  /** Force CPU (-ng) even on a GPU build. */
  noGpu?: boolean;
}

/**
 * Resolve the whisper.cpp binary + model. Environment variables win (scripted
 * and CI use); otherwise the paths saved from the settings screen are used, so
 * a desktop user never has to touch environment variables.
 */
export function resolveWhisperCpp(
  env: NodeJS.ProcessEnv = process.env,
  stored: { whisperCppBin?: string; whisperCppModel?: string } = readAppSettings(userDataDir())
): WhisperCppConfig | null {
  const binary = env.HOTCLIP_WHISPER_CPP_BIN?.trim() || stored.whisperCppBin?.trim();
  const model = env.HOTCLIP_WHISPER_CPP_MODEL?.trim() || stored.whisperCppModel?.trim();
  return binary && model ? { binary, model, noGpu: env.HOTCLIP_WHISPER_CPP_NO_GPU === "1" } : null;
}

interface WhisperCppToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

interface WhisperCppSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperCppToken[];
}

/** Shape of whisper.cpp's `--output-json-full` payload (fields we consume). */
export interface WhisperCppJson {
  result?: { language?: string };
  transcription?: WhisperCppSegment[];
}

/** `[_BEG_]`, `[_TT_225]`, `[_EOT_]`…: control tokens, never words. */
const CONTROL_TOKEN = /^\[_.*\]$/;

/**
 * Turn whisper.cpp's token list into timed words.
 *
 * The token→word join is the same BPE rule the sherpa Whisper tier uses (a
 * leading space / U+2581 starts a word, a bare piece continues it), so
 * " Mer"+"haba" is one word and a lone "," sticks to the word before it.
 * Falls back to segment spans when a run produced no token detail at all.
 */
export function whisperCppWords(payload: WhisperCppJson, durationSec: number): { words: TranscriptWord[]; language?: string } {
  const tokens: string[] = [];
  const stamps: number[] = [];
  for (const segment of payload.transcription ?? []) {
    for (const token of segment.tokens ?? []) {
      const text = typeof token.text === "string" ? token.text : "";
      if (!text || CONTROL_TOKEN.test(text)) continue;
      tokens.push(text);
      stamps.push(Math.max(0, (token.offsets?.from ?? 0) / 1000));
    }
  }
  const language = payload.result?.language;
  if (tokens.length > 0) {
    return { words: bpeTokensToWords({ text: "", tokens, timestamps: stamps }, 0, durationSec), language };
  }
  const words = (payload.transcription ?? []).flatMap((segment) => {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) return [];
    const from = Math.max(0, (segment.offsets?.from ?? 0) / 1000);
    const to = Math.max(from, (segment.offsets?.to ?? from * 1000) / 1000);
    // Segment span only: spread the text over it and say so, exactly like the
    // Qwen3 service does when its aligner is unavailable.
    return rebuildWords(text, from, Math.min(to, durationSec)).map((word) => ({ ...word, timingSource: "estimated" as const }));
  });
  return { words, language };
}

export class WhisperCppEngine implements TranscribeEngine {
  id = "whisper-cpp-local";
  label = "Whisper.cpp GPU (local binary · 90+ languages)";

  constructor(private config: WhisperCppConfig | null = resolveWhisperCpp()) {}

  async isReady(): Promise<boolean> {
    if (!this.config) return false;
    const binary = await stat(this.config.binary).then((s) => s.isFile()).catch(() => false);
    const model = await stat(this.config.model).then((s) => s.isFile()).catch(() => false);
    return binary && model;
  }

  /**
   * The user can swap the binary or the model at any time, so a transcript
   * cache keyed on "whisper-cpp" alone would replay the old model's result.
   */
  async cacheIdentity(): Promise<string> {
    if (!this.config) return "unconfigured";
    const model = await stat(this.config.model).catch(() => null);
    return `${basename(this.config.binary)}|${basename(this.config.model)}|${model?.size ?? 0}|${Math.round(model?.mtimeMs ?? 0)}`;
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const config = this.config;
    if (!config) throw new Error("whisper-cpp:not-configured (set HOTCLIP_WHISPER_CPP_BIN and HOTCLIP_WHISPER_CPP_MODEL)");
    const { onProgress, signal } = options;
    signal?.throwIfAborted();

    const media = await probeMedia(filePath);
    if (!media.hasAudio || !Number.isFinite(media.durationSec) || media.durationSec <= 0) throw new Error("transcribe:no-audio");

    const temp = await mkdtemp(join(tmpdir(), "hotclip-whisper-cpp-"));
    const wav = join(temp, "audio.wav");
    const outBase = join(temp, "out");
    try {
      // whisper.cpp reads 16 kHz mono WAV; decode once, then hand over the file.
      onProgress?.({ fraction: 0, stage: "decoding" });
      await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
        { maxBuffer: 32 * 1024 * 1024, signal }
      );
      onProgress?.({ fraction: 0, stage: "transcribing" });
      await this.runCli(config, wav, outBase, options, (fraction) => onProgress?.({ fraction, stage: "transcribing" }));

      const payload = JSON.parse(await readFile(`${outBase}.json`, "utf8")) as WhisperCppJson;
      const { words, language } = whisperCppWords(payload, media.durationSec);
      if (words.length === 0) throw new Error("transcribe:empty-result");
      onProgress?.({ fraction: 1, stage: "finalizing" });
      return { language: language ?? "auto", segments: segmentWords(words), engine: this.id, durationSec: media.durationSec };
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Spawn one CLI run, streaming whisper.cpp's own progress line. */
  private runCli(
    config: WhisperCppConfig,
    wav: string,
    outBase: string,
    options: TranscribeOptions,
    onFraction: (fraction: number) => void
  ): Promise<void> {
    const language = options.language && options.language !== "auto" ? options.language : "auto";
    const threads = Math.max(2, Math.min(8, cpus().length - 2));
    const args = [
      "-m", config.model,
      "-f", wav,
      "-l", language,
      "-ojf",              // full JSON: per-token offsets (word timings)
      "-of", outBase,
      "-pp",               // print progress on stderr
      "-t", String(threads),
    ];
    if (config.noGpu) args.push("-ng");

    return new Promise<void>((resolve, reject) => {
      const child = spawn(config.binary, args, { cwd: dirname(config.binary), windowsHide: true });
      let tail = "";
      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
        child.kill();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const done = (): void => options.signal?.removeEventListener("abort", onAbort);

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        tail = (tail + text).slice(-4000);
        const match = /progress\s*=\s*(\d+)%/.exec(text);
        if (match) onFraction(Math.min(0.99, Number(match[1]) / 100));
      });
      child.on("error", (error) => {
        done();
        reject(error);
      });
      child.on("close", (code) => {
        done();
        if (cancelled) reject(new Error("speech:cancelled"));
        else if (code === 0) resolve();
        else reject(new Error(`whisper-cpp:exit-${code}\n${tail.slice(-600)}`));
      });
    });
  }
}
