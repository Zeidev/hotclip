# Whisper (multilingual) local tier / 多语种 Whisper 本地档

The local tiers shipped before this one are Chinese-centric: SenseVoice covers
zh / yue / en / ja / ko, Paraformer zh / en, FireRedASR2 zh + dialects + en.
Turkish, Spanish, Arabic, Russian and everything else had **no offline path at
all** — the only option was the cloud ElevenLabs tier.

This tier adds Whisper **large-v3-turbo** (int8 ONNX, MIT) through the bundled
sherpa-onnx runtime, with word-level timestamps, so non-CJK languages get the
same local treatment: no uploads, no per-minute billing.

| | |
|---|---|
| Model | `cohearo/sherpa-onnx-whisper-large-v3-turbo-attention-int8` (attention export = word timestamps) |
| Size | ~1.04 GB (int8 encoder 674 MB + decoder 361 MB + tokens) |
| Languages | 90+ (multilingual Whisper turbo) |
| Download | HuggingFace, CN mirror (`hf-mirror.com`) tried first, resumable, SHA-256 verified after download |
| License | MIT (base model `openai/whisper-large-v3-turbo`) |

Punctuation and casing come from Whisper itself, so no CT-Transformer pass is
run for this tier. Whisper's byte-level BPE pieces (`▁Mer` + `haba`) are joined
back into words before timings, subtitles and cut points are computed — without
that step "Merhaba" would become two "words" and every word-level feature would
drift.

## Using it

Desktop: engine picker → **Multilingual · Whisper turbo**. First run downloads
the model once.

```sh
pnpm cli transcribe kayit.mp4 --engine whisper --language tr
pnpm cli clip kayit.mp4 --engine whisper --language tr --max-clips 6
pnpm cli highlights kayit.mp4 --engine whisper --language tr --json
```

MCP: `transcribe_video` / `detect_highlights` / `clip_video` accept
`engineId: "whisper"` and an optional `language` (for example `"tr"`).

`--language` is a hint; omit it and Whisper detects the language from the audio
itself. Pinning it is faster and more reliable on short or noisy clips.

## CPU speed — read this before picking the tier

Whisper turbo is an 809M-parameter encoder. It is **much slower on CPU** than
SenseVoice (a small int8 CTC model). Pick this tier for the *languages*, not for
speed: for a 2-hour Turkish stream, CPU transcription is a coffee-break-to-
lunch-break job, while Chinese/English content should still use SenseVoice or
FireRedASR2.

Measure your own machine instead of guessing:

```sh
pnpm whisper:smoke path/to/clip.wav tr
```

It downloads the managed model into `./.whisper-smoke` (override with
`HOTCLIP_WHISPER_SMOKE_DIR`), transcribes the file through the real engine and
prints segments, words and the realtime factor (`elapsed / media duration`).

Measured here (Ryzen 5 2600, 6 threads, sherpa-onnx-node 1.13.3, Windows):
13.4 s of English speech in **17.2 s wall clock = ~1.3× realtime**, including
model load and the first ONNX session — so a one-hour stream is roughly an
hour of CPU. Word timings were correct (`Hello@0.00 this@0.64 is@1.04 ...`,
three sentences split at 5.08 s / 7.90 s / 12.38 s).

> Note for anybody touching this tier: sherpa-onnx only returns token
> timestamps when `whisper.enableTokenTimestamps = 1` is passed (it runs DTW
> over cross-attention weights). Without it the same call returns 39 tokens and
> **zero** timestamps, and every word silently degrades to "estimated" — good
> text, useless caption sync. A regression test pins the flag.

## GPU (optional, not bundled)

The bundled `sherpa-onnx-node` binary is **CPU-only**, so the app does not ship
a GPU path. Two honest options:

1. **Self-built sherpa-onnx with CUDA / DirectML.** Build the Node addon from
   source with GPU support, then point the app at that execution provider:

   ```sh
   HOTCLIP_ASR_PROVIDER=cuda     # or directml, only with a GPU-enabled build
   ```

   Without such a build the provider string is ignored or errors; the prebuilt
   addon used by this repo only has the CPU provider.
2. **`onnxruntime-node` prebuilt EP table** (what a from-source build would
   target): Windows x64 → DirectML / WebGPU, Linux x64 → CUDA / TensorRT. Note
   there is **no prebuilt CUDA** for Windows in that package, so DirectML is the
   realistic Windows GPU EP.

A dedicated GPU engine (for example `whisper.cpp` with CUDA/Vulkan/Metal) is a
separate, larger piece of work: it changes the runtime, not this tier's model.

## GPU with whisper.cpp (the fast path)

The bundled `sherpa-onnx-node` addon has only the CPU provider, so the tier
above runs at ~1.3× realtime. `whisper.cpp` ships CUDA / Vulkan / Metal builds
of the *same* model, and HotClip drives it as an external CLI (engine
**Multilingual · Whisper.cpp (GPU)**).

```sh
pnpm whisper:cpp-setup --cuda        # CUDA 12 build + ggml-large-v3-turbo
pnpm whisper:cpp-setup               # CPU build + turbo (sanity check)

# the tool prints exactly these two lines
HOTCLIP_WHISPER_CPP_BIN=/path/to/whisper-cli
HOTCLIP_WHISPER_CPP_MODEL=/path/to/ggml-large-v3-turbo.bin

pnpm cli transcribe kayit.mp4 --engine whisper-cpp --language tr
```

The binary and the model stay user-managed — nothing is bundled, nothing is
uploaded. `HOTCLIP_WHISPER_CPP_NO_GPU=1` forces `-ng` on a GPU build.

### Windows prerequisite that costs an hour if you miss it

The official Windows builds link the MSVC runtime **and** the OpenMP runtime. On
a machine without them `whisper-cli.exe` dies with `0xC0000135`
(`STATUS_DLL_NOT_FOUND`) before printing a single line — the error looks like a
corrupt download. Four DLLs are needed next to the binary:

| DLL | Comes from |
|---|---|
| `msvcp140.dll` | Visual C++ Redistributable (x64) |
| `vcruntime140.dll`, `vcruntime140_1.dll` | Visual C++ Redistributable (x64) |
| `vcomp140.dll` | Visual C++ Redistributable (x64) — the OpenMP runtime |

Install `https://aka.ms/vs/17/release/vc_redist.x64.exe` (needs admin), or drop
those four DLLs next to `whisper-cli.exe`. `pnpm whisper:cpp-setup` runs the CLI
once and reports this explicitly instead of leaving you with the bare code.

### Measured (Turkish, 29.3 s / 6 sentences, Ryzen 5 2600 / GTX 1060 6GB)

Word error rate against a human-verified reference, identical audio for every
runtime (the samples come from `atasoglu/turkish-emotional-speech-11h`):

| Runtime | Model | WER | CER | 29.3 s audio | 117 s audio |
|---|---|---|---|---|---|
| sherpa-onnx (bundled, CPU) | large-v3-turbo int8 | **40.0 %** | 38.0 % | 40.0 s | — |
| whisper.cpp (CPU build) | ggml-large-v3-turbo q5_0 | 5.0 % | 2.0 % | 51.4 s | — |
| whisper.cpp (**CUDA** build) | ggml-large-v3-turbo q5_0 | 5.0 % | 2.3 % | 28.9 s | 44.8 s (2.6× realtime) |
| whisper.cpp (CPU build) | **ggml whisper-large-v3-turkish** q5_0 | 3.3 % | 0.9 % | 92.3 s | — |
| whisper.cpp (**CUDA** build) | **ggml whisper-large-v3-turkish** q5_0 | **3.3 %** | **0.9 %** | 32.9 s | 89.4 s (1.31×) |

Three things this table says:

1. **For Turkish, use the fine-tune.** `turkmedstt/whisper-large-v3-turkish-general`
   (large-v3, Apache-2.0, card: WER 7.92 / CER 2.26) beats multilingual turbo on
   both error rates, and its ggml conversion already exists on HuggingFace
   (`JoaoZaokk/whisper-large-v3-turkish-general-ggml`, q4_0 / q5_0 / q8_0) — no
   conversion step, no torch install. `selimc/whisper-large-v3-turbo-turkish`
   scored 5.0 % here: usable, but the large-v3 fine-tune is clearly ahead.
2. **The bundled sherpa tier is not usable for Turkish yet (40 % WER).** Its
   transcript stops mid-sentence and drops whole sentences because ASR windows
   are cut at 28 s (`ASR_WINDOW_SEC` in `src/core/transcribe/windowed.ts`) while a
   Whisper decoder needs context; the CTC tiers tolerate that split, Whisper does
   not. Fixing the windowing (30 s + overlap, or VAD-based segmentation) is a
   separate, known task.
3. **CUDA pays off on long audio, not on short clips.** The CUDA build carries a
   ~25 s fixed startup cost on this Pascal card (NVRTC/JIT), so a 29 s clip shows
   almost no gain while 117 s runs at 2.6× realtime (turbo) and 1.31×
   (large-v3 fine-tune). An hour of Turkish is roughly 23 min (turbo) / 46 min
   (fine-tune) on this GPU, versus multiple hours on CPU. Earlier numbers in this
   document that said "CUDA is slower" came from a 13.4 s clip where that fixed
   cost dominated — long audio is the case that matters.

Caveat: the test audio is synthetic TTS (clean, studio-like), so absolute WER is
optimistic; trust the **ranking**, not the digits. Re-measure on your own
recording:

```sh
pnpm cli transcribe <media> --engine whisper-cpp --language tr --restart-transcription
```

Prefer the CUDA 12.4 build: the 11.8 build measured worse here (38.8 s on the
same clip).

Practical guidance:

- **Turkish / non-CJK on a GPU box:** `ggml whisper-large-v3-turkish q5_0` +
  whisper.cpp CUDA, wired from the settings screen (Settings › Storage →
  Whisper.cpp (GPU), environment variables optional).
- **Other languages, or no GPU:** the bundled sherpa-onnx tier needs no extra
  runtime; on a Turing-or-newer NVIDIA card, Apple Silicon (Metal) or a
  Vulkan-capable AMD/Intel GPU the whisper.cpp tier is worth wiring up.
- Verify on your own box before trusting any table, including this one.

### Cache note (fixed while measuring)

Transcript caching keys on the engine id, but a user-managed model can change
under a fixed id. That produced a real bug: a transcript produced with the tiny
model was replayed for the turbo model and looked "instant". Engines now expose
`cacheIdentity()`, and the key becomes `whisper-cpp:<binary>|<model>|<size>|<mtime>`
(and the same for `HOTCLIP_WHISPER_MODEL_DIR` exports), so swapping a model
transcribes for real instead of replaying the old result.

## Turkish fine-tune (or any other Whisper fine-tune)

`sherpa-onnx` publishes Whisper as three loose ONNX files, so any Whisper
fine-tune can be exported and used **without touching this repo**:

```sh
# 1) Python env (3.10-3.12 recommended)
python -m venv .venv-whisper
.venv-whisper/Scripts/pip install torch transformers onnx onnxruntime      # Windows
# .venv-whisper/bin/pip install ...                                        # macOS/Linux

# 2) Export with attention (word timestamps). Script:
#    https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/whisper/export-onnx-with-attention.py
python export-onnx-with-attention.py \
  --model selimc/whisper-large-v3-turbo-turkish \
  --output-dir tr-whisper-turbo

# 3) Rename to the three names HotClip expects inside the directory
#    <dir>/turbo-encoder.int8.onnx
#    <dir>/turbo-decoder.int8.onnx
#    <dir>/turbo-tokens.txt
```

Then point the app at it:

```sh
HOTCLIP_WHISPER_MODEL_DIR=/absolute/path/to/tr-whisper-turbo
pnpm cli transcribe kayit.mp4 --engine whisper --language tr
```

With `HOTCLIP_WHISPER_MODEL_DIR` set, the managed model is never downloaded or
overwritten; the directory is only checked for the three files.

### Before you commit to a fine-tune

`selimc/whisper-large-v3-turbo-turkish` reports **WER 18.92** on Common Voice
17 `tr` test (unverified, model updated 2025-03) — that is not obviously better
than base Whisper large-v3-turbo on Turkish. Compare both on the *same* set with
your own audio before shipping one:

```sh
# same fixtures.json, two model directories, two runs
pnpm quality:eval:asr fixtures.json whisper
```

(`--engine whisper` also appears in `pnpm quality:eval:asr`, so CER/WER,
word-boundary error and estimated-word counts are reported the same way as for
the other local tiers.)

Exporting fp32 instead of int8 works too, but roughly triples the size
(~3.2 GB) and uses the unquantized file names from the export script.

## Türkçe özet

- Yerel motorlara **Whisper large-v3-turbo** (çok dilli, 90+ dil) eklendi; Türkçe artık tamamen çevrimdışı çalışıyor, hiçbir şey yüklenmiyor.
- Masaüstünde motor seçiminden **Multilingual · Whisper turbo**; CLI'de `--engine whisper --language tr`; MCP'de `engineId: "whisper"`.
- Model ~1.04 GB, ilk kullanımda bir kez indirilir (CN aynası öncelikli, devam ettirilebilir, SHA-256 doğrulamalı).
- **CPU'da yavaş** (809M encoder). Çince/İngilizce içerik için SenseVoice/FireRedASR2 daha mantıklı; Whisper'ı dil kapsamı için seç.
- **Türkçe'de ölçülen sonuç:** sherpa turbo int8 **%40 WER** (28 sn pencere sınırı cümleleri düşürüyor — düzeltilecek), whisper.cpp + `ggml whisper-large-v3-turkish q5_0` **%3.3 WER / %0.9 CER**. Türkçe için fine-tune'u kullan.
- Kendi Türkçe fine-tune'unu ONNX'e çevirip `HOTCLIP_WHISPER_MODEL_DIR` ile gösterebilirsin — model indirilmez, dizin sadece doğrulanır. (Türkçe large-v3 fine-tune'unun ggml hali HuggingFace'de hazır: `JoaoZaokk/whisper-large-v3-turkish-general-ggml`.)
- GPU paketlenmiş değil: dahili `sherpa-onnx-node` yalnızca CPU. `HOTCLIP_ASR_PROVIDER=cuda|directml` ancak kendi GPU'lu derlemenle çalışır (Windows'ta önerilen EP DirectML'dir).
- **GPU'nun gerçek yolu:** `pnpm whisper:cpp-setup --cuda` **ya da** Ayarlar → Depolama → **Whisper.cpp (GPU)** bölümünden iki dosyayı seç (env değişkeni gerekmez; `HOTCLIP_WHISPER_CPP_BIN` / `_MODEL` verilirse onlar öncelikli). Sonra motordan **Multilingual · Whisper.cpp (GPU)** seç (veya `--engine whisper-cpp`).
- **CUDA kısa klipte kazandırmaz, uzun seste kazandırır:** Pascal'da ~25 sn sabit başlangıç maliyeti var; 117 sn ses turbo ile 2.6×, tr-large ile 1.31× realtime.
- Windows'ta resmi whisper.cpp derlemeleri MSVC + OpenMP runtime ister (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `vcomp140.dll`); eksikse `0xC0000135` alırsın. VC++ Redist kur ya da DLL'leri binary'nin yanına koy. CUDA 12.4 derlemesi 11.8'den daha hızlı ölçüldü.
- Kontrol: `pnpm whisper:smoke <dosya> tr` → segment/kelime çıktısı + gerçek zaman katsayısı.
