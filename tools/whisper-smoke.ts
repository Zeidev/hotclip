/**
 * Whisper tier smoke test — the one check that proves the whole tier works on
 * this machine: managed model download (mirrors → resume → checksum), sherpa
 * ONNX recognizer creation, BPE→word joining and word-level timings.
 *
 *   pnpm whisper:smoke <media-file> [language]
 *
 * The model lands in HOTCLIP_WHISPER_SMOKE_DIR (default ./.whisper-smoke) so a
 * smoke run never disturbs the desktop app's own model directory. Tip: point
 * HOTCLIP_WHISPER_MODEL_DIR at the same directory to transcribe with it in the
 * app or the CLI.
 */
import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { WhisperEngine } from "../src/core/transcribe/whisper";
import { isModelInstalled, WHISPER_TURBO_MODEL } from "../src/core/models";

async function main(): Promise<void> {
  const [media, language] = process.argv.slice(2);
  if (!media) throw new Error("Usage: pnpm whisper:smoke <media-file> [language]");

  const modelsRoot = resolve(process.env.HOTCLIP_WHISPER_SMOKE_DIR ?? join(process.cwd(), ".whisper-smoke"));
  await mkdir(modelsRoot, { recursive: true });
  process.stdout.write(`model dir: ${modelsRoot}\n`);
  process.stdout.write(`installed before: ${await isModelInstalled(modelsRoot, WHISPER_TURBO_MODEL)}\n`);

  const engine = new WhisperEngine(modelsRoot);
  const started = Date.now();
  let lastPercent = -1;
  let lastStage = "";

  const transcript = await engine.transcribe(resolve(media), {
    language: language && language !== "auto" ? language : undefined,
    onProgress: (progress) => {
      if (progress.stage === "downloading-model" || progress.stage === "extracting-model") {
        const percent = progress.totalBytes ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 100) : 0;
        if (percent !== lastPercent || progress.stage !== lastStage) {
          lastPercent = percent;
          lastStage = progress.stage;
          process.stdout.write(`\r${progress.stage}: ${percent}%          `);
        }
      } else {
        process.stdout.write(`\r${progress.stage}: ${Math.floor(progress.fraction * 100)}%          `);
      }
    },
  });

  const elapsedSec = (Date.now() - started) / 1000;
  const words = transcript.segments.flatMap((segment) => segment.words);
  const realtime = transcript.durationSec > 0 ? elapsedSec / transcript.durationSec : 0;
  process.stdout.write(`\nengine=${transcript.engine} language=${transcript.language} duration=${transcript.durationSec.toFixed(1)}s ` +
    `segments=${transcript.segments.length} words=${words.length} elapsed=${elapsedSec.toFixed(1)}s (${realtime.toFixed(2)}x realtime)\n`);

  for (const segment of transcript.segments.slice(0, 12)) {
    process.stdout.write(`[${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}] ${segment.text}\n`);
  }
  process.stdout.write(`first words: ${words.slice(0, 10).map((word) => `${word.text}@${word.startSec.toFixed(2)}${word.timingSource === "estimated" ? "(est)" : ""}`).join(" ")}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`whisper smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
