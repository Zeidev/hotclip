import { describe, it, expect } from "vitest";
import { createWhisperCppAligner } from "../align-whisper-cpp";

describe("whisper.cpp forced aligner", () => {
  it("is unavailable when whisper.cpp is not wired up", () => {
    expect(createWhisperCppAligner(undefined, null)).toBeNull();
  });

  it("does not touch the model for an empty word list", async () => {
    const align = createWhisperCppAligner(undefined, { binary: "/nope/whisper-cli", model: "/nope/ggml.bin" });
    expect(align).not.toBeNull();
    const result = await align!("/nope/media.mp4", [{ id: 1, startSec: 0, endSec: 1, words: [] }]);
    expect(result.get(1)).toBeNull();
  });
});