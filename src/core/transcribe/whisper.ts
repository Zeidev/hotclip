/**
 * Local ASR, multilingual tier: Whisper large-v3-turbo int8 via sherpa-onnx
 * (MIT, 809M params, 99 languages). Every other local tier is Chinese-centric
 * (SenseVoice zh/yue/en/ja/ko, Paraformer zh/en, FireRedASR2 zh/dialects/en),
 * so Turkish, Spanish, Arabic, Russian... had no offline path at all.
 *
 * ~1.04GB download, and unlike the CTC models it is *slow on CPU* — an 809M
 * encoder does not run at SenseVoice speed. It is here for the languages the
 * fast tiers cannot hear; word timestamps come from the attention export, and
 * Whisper emits its own punctuation (no CT-Transformer pass needed).
 *
 * A Turkish fine-tune (e.g. selimc/whisper-large-v3-turbo-turkish) can be used
 * without rebuilding anything: export it to the same three file names and set
 * HOTCLIP_WHISPER_MODEL_DIR to that directory — see docs/local-speech.md.
 */
import { join } from "path";
import { cpus } from "os";
import { WHISPER_TURBO_MODEL } from "../models";
import { SherpaOfflineEngine, type SherpaEngineSpec } from "./sherpa-offline";

/** User-supplied model directory (encoder/decoder/tokens), taking precedence. */
export function whisperModelDirOverride(): string | undefined {
  const value = process.env.HOTCLIP_WHISPER_MODEL_DIR?.trim();
  return value ? value : undefined;
}

/**
 * The Whisper tier's sherpa-onnx spec. Exported so a regression test can pin
 * the parts that silently destroy word timings when they change (the timestamp
 * flag, the token table name, the BPE join and the language hint).
 */
export function whisperEngineSpec(overrideDir?: string): SherpaEngineSpec {
  return {
    id: "whisper-local",
    label: "Whisper large-v3-turbo (local · multilingual)",
    asset: WHISPER_TURBO_MODEL,
    buildModelConfig: (dir, options) => ({
      whisper: {
        encoder: join(dir, "turbo-encoder.int8.onnx"),
        decoder: join(dir, "turbo-decoder.int8.onnx"),
        // Empty = let Whisper detect the language from the audio itself;
        // a hint from the caller (CLI --language / saved project setting)
        // pins it when the user already knows.
        ...(options?.language && options.language !== "auto" ? { language: options.language } : {}),
        task: "transcribe",
        // Without this the decoder returns text and tokens but *no* timestamps
        // at all (verified against sherpa-onnx 1.13.3: 39 tokens, 0 timestamps),
        // which would leave every word "estimated" and break word-synced
        // captions and cut points. It makes sherpa-onnx run DTW over
        // cross-attention weights, so it needs the attention export (this model
        // has it). Key is camelCase — the node binding ignores an
        // `enable_token_timestamps` spelling.
        enableTokenTimestamps: 1,
      },
    }),
    language: (result) => result.lang?.replace(/[<|>]/g, ""),
    tokenJoin: "bpe",
    tokensFile: "turbo-tokens.txt",
    // Whisper carries its own punctuation and casing.
    punctuate: false,
    numThreads: Math.min(6, Math.max(2, cpus().length - 2)),
    overrideDir,
  };
}

export class WhisperEngine extends SherpaOfflineEngine {
  constructor(modelsRoot: string, overrideDir = whisperModelDirOverride()) {
    super(whisperEngineSpec(overrideDir), modelsRoot);
  }
}
