/**
 * Generic sherpa-onnx offline engine runner. Every local model tier
 * (SenseVoice / Paraformer / FireRedASR…) shares the same pipeline:
 * ensure models → extract 16k f32le samples → windowed decode with token timestamps →
 * optional punctuation restoration → sentence segmentation.
 * A tier is described by a spec; adding a model = adding a spec.
 */
import { join } from "path";
import { stat } from "fs/promises";
import {
  ensureModel,
  isModelDirComplete,
  isModelInstalled,
  modelDir,
  PUNCT_MODEL,
  type ModelAsset,
} from "../models";
import { toAnsiSafeDir } from "../win-ansi-path";
import { joinWords } from "./segment";
import { applyPunctuation } from "./punctuate";
import type { Transcript, TranscribeEngine, TranscribeOptions, TranscriptWord } from "./types";

import { transcribeWindows } from "./windowed";

export interface SherpaResult {
  text: string;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null;
/** sherpa-onnx-node is a native addon — require lazily so importing core stays cheap. */
export function loadSherpa(): any {
  if (!sherpa) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpa = require("sherpa-onnx-node");
  }
  return sherpa;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Convert one window's sherpa result into timed words offset to absolute time.
 * Engines emit per-token start times; each token's end is the next token's
 * start (last token gets +0.3s tail).
 */
export function tokensToWords(result: SherpaResult, offsetSec: number, windowEndSec: number): TranscriptWord[] {
  const tokens = result.tokens ?? [];
  const stamps = result.timestamps ?? [];
  const words: TranscriptWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i];
    if (!text || !text.trim()) continue;
    const start = Math.min(windowEndSec, Math.max(offsetSec, offsetSec + (stamps[i] ?? 0)));
    const nextStamp = stamps[i + 1];
    const end = nextStamp !== undefined ? offsetSec + nextStamp : Math.min(start + 0.3, windowEndSec);
    words.push({
      text: text.trim(),
      startSec: start,
      endSec: Math.min(windowEndSec, Math.max(end, start)),
      timingSource: stamps[i] !== undefined ? "native" : "estimated",
    });
  }
  return words;
}

/**
 * Whisper (and any other byte-level BPE model) emits sub-word pieces instead of
 * words: a word start carries U+2581 ("▁") — the tokenizer's space marker —
 * while continuations carry nothing. Feeding those pieces through the
 * one-token-one-word rule would split "Merhaba" into "Mer"+"haba" and break
 * every word-level timestamp, subtitle line and cut point.
 *
 * Models that already emit whole words (no marker anywhere) fall back to the
 * plain rule, so this stays safe for non-BPE result shapes.
 */
export function bpeTokensToWords(result: SherpaResult, offsetSec: number, windowEndSec: number): TranscriptWord[] {
  const tokens = result.tokens ?? [];
  const stamps = result.timestamps ?? [];
  const marked = tokens.some((token) => typeof token === "string" && /[\u2581 ]/.test(token));
  if (!marked) return tokensToWords(result, offsetSec, windowEndSec);

  const groups: { text: string; firstIndex: number; lastIndex: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (typeof raw !== "string" || !raw) continue;
    // The marker itself is the word separator; trim it off the emitted text.
    const text = raw.replace(/\u2581/g, " ").trim();
    if (!text) continue;
    const startsWord = groups.length === 0 || /^[\u2581 ]/.test(raw);
    if (startsWord) groups.push({ text, firstIndex: i, lastIndex: i });
    else {
      const group = groups[groups.length - 1];
      group.text += text;
      group.lastIndex = i;
    }
  }

  return groups.map((group) => {
    const start = Math.min(windowEndSec, Math.max(offsetSec, offsetSec + (stamps[group.firstIndex] ?? 0)));
    const nextStamp = stamps[group.lastIndex + 1];
    const end = nextStamp !== undefined ? offsetSec + nextStamp : Math.min(start + 0.3, windowEndSec);
    return {
      text: group.text,
      startSec: start,
      endSec: Math.min(windowEndSec, Math.max(end, start)),
      timingSource: stamps[group.firstIndex] !== undefined ? "native" : "estimated",
    };
  });
}

export interface SherpaEngineSpec {
  id: string;
  label: string;
  asset: ModelAsset;
  /** sherpa OfflineRecognizer modelConfig for this tier (paths inside `dir`). */
  buildModelConfig(dir: string, options?: TranscribeOptions): Record<string, unknown>;
  /** Fixed language, or a reader that pulls it from the first decode result. */
  language: string | ((result: SherpaResult) => string | undefined);
  /** Restore punctuation via CT-Transformer (models that emit none). */
  punctuate?: boolean;
  numThreads?: number;
  /**
   * How the decoder's tokens map to words. Default "token" (one token = one
   * word, right for CTC models like SenseVoice/Paraformer); "bpe" joins
   * Whisper-style sub-word pieces into real words.
   */
  tokenJoin?: "token" | "bpe";
  /**
   * Token table file name inside the model directory. Default "tokens.txt";
   * HuggingFace exports often carry their own name (Whisper: turbo-tokens.txt).
   */
  tokensFile?: string;
  /**
   * ONNX Runtime execution provider. "cpu" everywhere by default — the bundled
   * sherpa-onnx-node prebuilt is CPU-only; a locally built CUDA/DirectML
   * runtime can be enabled with HOTCLIP_ASR_PROVIDER.
   */
  provider?: string;
  /**
   * Use this directory instead of the managed model directory — for a model
   * the user exported/installed themselves. Files must carry the asset's file
   * names. Set by HOTCLIP_WHISPER_MODEL_DIR for Whisper.
   */
  overrideDir?: string;
}

/** Execution provider for local sherpa models (opt-in GPU builds only). */
export function asrProvider(): string {
  const value = process.env.HOTCLIP_ASR_PROVIDER?.trim().toLowerCase();
  return value && /^[a-z0-9_-]+$/.test(value) ? value : "cpu";
}

export class SherpaOfflineEngine implements TranscribeEngine {
  id: string;
  label: string;

  constructor(
    private spec: SherpaEngineSpec,
    private modelsRoot: string
  ) {
    this.id = spec.id;
    this.label = spec.label;
  }

  async isReady(): Promise<boolean> {
    if (this.spec.overrideDir) return isModelDirComplete(this.spec.overrideDir, this.spec.asset).catch(() => false);
    return isModelInstalled(this.modelsRoot, this.spec.asset);
  }

  /**
   * A user-supplied model directory (HOTCLIP_WHISPER_MODEL_DIR) is not part of
   * the engine id, so without this a transcript made with one fine-tune would be
   * replayed for another.
   */
  async cacheIdentity(): Promise<string> {
    const dir = this.spec.overrideDir;
    if (!dir) return "";
    const parts = await Promise.all((this.spec.asset.files ?? []).map(async (file) => {
      const s = await stat(join(dir, file.name)).catch(() => null);
      return `${file.name}:${s?.size ?? 0}`;
    }));
    return `${dir}|${parts.join(",")}`;
  }

  async transcribe(filePath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { onProgress, signal } = options;
    const spec = this.spec;

    onProgress?.({ fraction: 0, stage: "downloading-model" });
    const download = (p: { downloadedBytes: number; totalBytes: number; phase?: "download" | "extract" }): void =>
      onProgress?.({
        fraction: 0,
        stage: p.phase === "extract" ? "extracting-model" : "downloading-model",
        downloadedBytes: p.downloadedBytes,
        totalBytes: p.totalBytes,
      });
    const override = spec.overrideDir;
    if (override) {
      // User-managed model directory: never download over it, just verify.
      if (!(await isModelDirComplete(override, spec.asset).catch(() => false))) {
        throw new Error(`transcribe:model-missing (${override})`);
      }
    } else {
      await ensureModel(this.modelsRoot, spec.asset, download, signal);
    }
    if (spec.punctuate) await ensureModel(this.modelsRoot, PUNCT_MODEL, download, signal);

    const sh = loadSherpa();
    // 模型文件由原生层自己打开(ANSI):Windows 中文路径先转 8.3 短路径(issue #4)
    const dir = await toAnsiSafeDir(override ?? modelDir(this.modelsRoot, spec.asset));
    const recognizer = new sh.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        ...spec.buildModelConfig(dir, options),
        tokens: join(dir, spec.tokensFile ?? "tokens.txt"),
        numThreads: spec.numThreads ?? 2,
        provider: spec.provider ?? asrProvider(),
        debug: 0,
      },
    });
    const punct = spec.punctuate
      ? new sh.OfflinePunctuation({
          model: {
            ctTransformer: join(await toAnsiSafeDir(modelDir(this.modelsRoot, PUNCT_MODEL)), "model.int8.onnx"),
            numThreads: 1,
            provider: "cpu",
            debug: 0,
          },
        })
      : null;

    return transcribeWindows(filePath, this.id,
      JSON.stringify([this.id, spec.asset, spec.buildModelConfig("MODEL"), spec.punctuate, spec.overrideDir ?? "", "sherpa-1.13-v2"]), options,
      async (samples, startSec, endSec) => {
        signal?.throwIfAborted();
        const stream = recognizer.createStream();
        try {
          stream.acceptWaveform({ sampleRate: 16000, samples });
          recognizer.decode(stream);
          const result = recognizer.getResult(stream) as SherpaResult;
          let words = spec.tokenJoin === "bpe"
            ? bpeTokensToWords(result, startSec, endSec)
            : tokensToWords(result, startSec, endSec);
          if (punct && words.length > 0) words = applyPunctuation(words, punct.addPunct(joinWords(words)) as string);
          return { words, language: typeof spec.language === "string" ? spec.language : spec.language(result) };
        } finally {
          stream.free?.();
        }
      });
  }
}
