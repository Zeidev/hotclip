# 长稿编辑与本地语音 / Long transcripts and local speech

## 编辑与恢复

- 本地转写每完成一个 28 秒识别窗口就原子保存结果。停止、退出或异常中断后，对同一素材使用同一引擎再次开始，会复用已完成窗口。素材版本、模型配置、语言或运行契约变化会重新计算。可用“从头重新转写”清除本次进度。
- PCM 保存在临时磁盘文件，识别时每次只读一个窗口。恢复时只抽取剩余音频；完整结果缓存仍然保留。缓存不可写时仍可完成转写，但不能保证下次恢复。云端 ElevenLabs 不提供本地分段恢复。
- 逐句稿支持忽略大小写、标点和空白的跨句搜索，兼容组合重音、全角字符与多种文字。Enter / Shift+Enter 跳到下一项 / 上一项；匹配内容高亮。搜索范围可选全部 / 台词 / 画面，文字与已扫描的画面证据按时间统一导航，首次 Enter 定位第一项。最多展示 2,000 条台词命中和 200 条画面命中，达到上限时显示 +，可缩小关键词继续定位。
- 原文与词序、时间一致时直接定位命中字词；估算词时间标为“句内估时”，词序或时间不可靠时退回句级定位。可“试听上下文”（前后各 2 秒、最多 30 秒），再点“选这段”打开已勾选完整命中句的选段窗口。画面命中预选附近台词；没有附近台词时仅提供定位和试听。选段确认后加入候选，可继续调整、撤销和重做。
- 逐句稿和选段窗口都只渲染当前视口附近的句子，行高随文字内容变化。编辑区采用紧凑预览，时间轴可展开；较小窗口内仍可滚动到全部控件。
- 打开“校准时间”，勾选句子或选择当前待复核句，生成校准预览。支持原时间 / 新时间试听，确认应用后可用工作台撤销或重做。每批最多 20 句、总计 5 分钟，单句不超过 2 分钟 / 2,000 字符。校准保留原文和句子边界。
- Paraformer 校准仅用于中文 / 英文；其他语种选择 Qwen3 与明确语言。模型不支持、匹配不足或时间无效的句子会保留原时间并计入跳过项。自动语言无法明确识别时，请手动指定。
- 导出字幕按文字类型使用不同阅读速度预设，合并能容纳的短行，并在相邻字幕、说话人和剪辑边界内延长显示。ASS、动态字幕、SRT 与质检共用显示规划；逐字高亮的语音时间不随显示延长而改变。仍无法满足阅读速度的字幕继续报告告警。

## 模型连接与长稿预筛

- 文字分析每轮调用的等待上限为云端 3 分钟、本机 5 分钟；参数兼容回退和空正文重试共用该时限。画面研判每次最多 1 分钟，模型列表最多 12 秒。等待上限包含接收响应正文，接口只返回响应头后卡住也会结束等待。
- 文字和画面请求遇到短暂限流（HTTP 429）或服务忙（HTTP 503）时，最多额外重试一次；遵守服务端不超过 5 秒的等待指示，未提供时等待 1 秒。文字分析中这个重试额度也由参数回退与空正文重试共用。明确的余额不足、鉴权失败、断网和超时不自动重发；服务端要求更长等待时直接提示失败，文字分析会显示建议等待时长。模型列表失败后仍可手动填写模型名。
- 单次成功响应最多读取 2 MiB，错误详情中的当前 API Key 与 Bearer 凭据会被隐藏。停止任务可中断正在接收的响应和重试等待，但已被服务端接收的推理是否立即停止由服务端决定。
- 开启本地预筛后，长稿最多同时处理 2 段，共用 2 分钟预筛时限；超时不再派发排队段落。失败或尚未处理的段落会完整保留；整体不可用或筛选不足时沿用全文分析。地址识别支持 IPv4 / IPv6 回环与 localhost，仅根据实际主机名判断是否本机。

## 多语种 Whisper 档(90+ 语种)

SenseVoice / Paraformer / FireRedASR2 都偏中文;土耳其语、西语、阿语、俄语等此前只有云端档。新增的 **Whisper large-v3-turbo**(int8 ONNX,MIT)全程本地运行,逐词时间戳,自带标点。安装体积约 1.04GB,CPU 明显慢于 SenseVoice(809M 编码器),选它是为了语种而不是速度。

```sh
pnpm cli transcribe recording.mp4 --engine whisper --language tr
pnpm whisper:smoke recording.wav tr     # 真实模型端到端自检 + 实时倍率
```

自带的 `sherpa-onnx-node` 只有 CPU 执行器:`HOTCLIP_ASR_PROVIDER=cuda|directml` 只在自行编译的 GPU 版本上有效。自备 Whisper 微调(例如土耳其语模型)时,把它导出成三个 ONNX 文件并用 `HOTCLIP_WHISPER_MODEL_DIR` 指向该目录即可,HotClip 不会下载或覆盖它。完整说明见 [多语种 Whisper 说明](whisper-multilingual.md)。

## 可选 Qwen3 本地服务

默认引擎仍为 SenseVoice。Qwen3-ASR 0.6B / 1.7B 是用户管理的可选服务；HotClip 不自动安装 Python、不自动启动服务，也不将素材发送到远程地址。模型首次由服务加载时下载并缓存在本机。协议仅接受 `http://127.0.0.1:<端口>` 或 `http://[::1]:<端口>`，拒绝重定向。

在源码目录中建立独立 Python 3.12 环境（已验证 `qwen-asr==0.0.6`、`transformers==4.57.6`）：

```sh
python3.12 -m venv .venv-qwen
.venv-qwen/bin/python -m pip install "qwen-asr==0.0.6"
.venv-qwen/bin/python tools/qwen-speech-server.py --model 0.6B --device cpu --aligner
```

Windows 将 `.venv-qwen/bin/python` 换成 `.venv-qwen\Scripts\python.exe`。安装包也携带 `speech/qwen-speech-server.py`（位于应用的 Resources / resources 目录），可用独立环境直接运行。CPU 路径已做 macOS ARM64 实测；`--device mps` / `--device cuda:0` 与 Windows、Linux 需要在目标设备另行验证，不代表已验证的加速效果。

启动后，在“转写引擎”中选择 Qwen3-ASR，填写 `http://127.0.0.1:8766` 并“检查连接”。界面会显示实际加载的模型、设备和对齐器状态。`--model 1.7B` 选择更大的模型；`--port` 可改端口。省略 `--aligner` 可减少模型加载，转写字词时间将明确标为估算，编辑阶段的 Qwen 校准不可用。停止客户端任务会中止等待；服务可能仍在完成当前推理，忙碌时会返回明确错误，完成后可续跑。

Qwen3-ASR 的识别语种范围和 ForcedAligner 的对齐语种范围不同。对齐支持 zh / en / yue / fr / de / it / ja / ko / pt / ru / es，其他识别语种使用估算时间。零时长字词不会被当作准确时间锚点，保留文字并标记插值或估时。完整识别原文（含标点）保留。[模型与运行接口说明](https://github.com/QwenLM/Qwen3-ASR)

```sh
pnpm cli transcribe recording.mp4 --engine qwen3 --asr-url http://127.0.0.1:8766 --json
pnpm cli transcribe recording.mp4 --engine sensevoice --restart-transcription
```

`transcribe`、`highlights`、`clip` 都支持 `--engine` / `--asr-url` / `--restart-transcription`。MCP 的三个对应工具支持 `engineId` / `localServiceUrl` / `restart`。显式提供字幕文件时仍优先导入字幕，不启动 ASR。

## 可复现评估

```json
[
  { "id": "clean-zh", "audio": "speech.wav", "text": "人工确认的原文" },
  { "id": "silence", "audio": "silence.wav", "text": "" }
]
```

将上面的清单保存为 `fixtures.json`，音频路径相对于清单；显式选择参与测试的本地模型：

```sh
pnpm quality:eval:asr fixtures.json sensevoice,qwen3
```

输出字符 / 单词错误率、实时率、静音误识别、时间来源和主进程内存采样。`HOTCLIP_MODELS_DIR` 指定本地模型缓存，`HOTCLIP_QWEN_URL` 指定服务。首次测试可含模型准备耗时，应预热后再比较；主进程 RSS 不包含独立 Qwen 服务，不能直接作两种模型的内存排名。若需边界误差，给样例添加人工标注的 `boundaries: { firstSec, lastSec }`，未标注时输出 null。

2026-09-05 的 macOS ARM64 CPU 冒烟覆盖合成中文 10.94 秒、英文 8.57 秒、静音 5 秒。Qwen3-ASR 0.6B + ForcedAligner 与 SenseVoice 的两条语音样例字符错误率均为 0，纯静音样例均无误识别；Qwen 英语虚词的零时长输出已通过插值兼容。两种校准器均完成了同一中文句子的 41 字词校准，并保留原文。样例规模不足以判断真实录播、方言、噪音环境中的整体质量；1.7B 未在本次下载实测。

## English

Local transcription checkpoints each completed 28-second decode window and resumes the same source/model configuration after interruption. PCM stays on disk; only one window is read at a time. Use **Start over** to discard that run's partial results. Cache faults lose reuse, not the ability to transcribe; cloud jobs do not support local window recovery.

The transcript supports Unicode-aware cross-sentence search and chronological navigation across speech and scanned visual evidence. Filter by All / Speech / Visuals. The first Enter seeks the first match; subsequent Enter / Shift+Enter move forward / backward. Limits are 2,000 speech matches and 200 visual matches, with + displayed at the cap. Matching word times are used only when the word sequence and timing are valid; estimated times are labeled and stale words fall back to sentence bounds.

**Play context** includes up to two seconds on either side, capped at 30 seconds. **Pick this moment** opens the picker with complete matched sentences selected; visual matches select nearby speech only. Review and confirm before adding a candidate, then undo or redo as needed. Both the transcript and picker virtualize long lists. Picker search spans sentences and preserves selections while filtering. The transcript workspace provides a compact player and an expandable timeline.

**Align timing** previews selected or uncertain sentences before an explicit apply. Listen before/after, apply, then undo or redo. Limits: 20 sentences / 5 minutes per batch, 2 minutes / 2,000 characters per sentence. Original text and cue boundaries remain intact. Unsupported languages, poor matches and invalid timings keep the originals with a skipped count. Paraformer is Chinese/English; choose Qwen3 and an explicit supported language for other scripts.

Exports share a language-aware caption display plan across ASS, web overlays, SRT and quality checks. Short lines merge only within width, speaker and splice constraints. Display duration extends into available space without moving speech/karaoke timestamps. Unresolved reading-speed issues remain visible in the report.

Qwen3 is optional and user-managed. Follow the Python commands above, then choose Qwen3-ASR and check the loopback URL in the engine settings. The service accepts `--model 0.6B|1.7B`, `--device cpu|mps|cuda:0`, `--port` and `--aligner`. First load downloads model weights locally. HotClip installs no Python runtime automatically and rejects remote service URLs and redirects. Without the aligner, word times are marked estimated. The ASR and alignment language sets differ; see the explicit list above. Client cancellation stops waiting; a service already inferring may finish that request before becoming available again.

Run `pnpm quality:eval:asr fixtures.json sensevoice,qwen3` against locally annotated fixtures to measure character/word errors, runtime, silence hallucinations and timing provenance. Paths are relative to the manifest. Memory is a host-process sample, not total service memory; boundary error requires manual `boundaries` labels. The small CPU smoke covered 0.6B, Chinese/English synthesized speech and silence; it does not establish general accuracy or GPU/cross-platform performance. The 1.7B path remains opt-in and was not benchmarked in this run.

**Model requests** have deadlines covering both response headers and body: text analysis gets 3 minutes for remote services or 5 minutes for loopback services, shared across parameter fallback and empty-content retries; visual calls get 1 minute and model lists 12 seconds. Text and vision requests retry HTTP 429/503 at most once, honoring a server wait of up to 5 seconds (1 second when absent). Text fallback attempts share that retry allowance. Recognized insufficient-quota errors, authentication failures, network failures and timeouts are not automatically resent. Longer waits return an error; text analysis includes the suggested delay. Model-list failure still permits manual model entry. Successful responses are limited to 2 MiB; error details redact the configured key and Bearer credentials. Cancellation stops the client request or retry wait; server-side inference may continue.

**Local screening** runs at most two chunks concurrently within a shared two-minute deadline. Failed or unprocessed chunks remain intact, and unavailable or ineffective screening falls back to the full transcript. Local model detection checks the URL hostname and supports localhost, IPv4 loopback and IPv6 loopback.
