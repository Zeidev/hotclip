/**
 * Fetch a whisper.cpp build plus a ggml Whisper model and print the two
 * environment variables HotClip's GPU tier needs.
 *
 *   pnpm whisper:cpp-setup                     # CPU build + ggml-large-v3-turbo (default)
 *   pnpm whisper:cpp-setup --cuda              # CUDA 12 build (Windows x64) + turbo
 *   pnpm whisper:cpp-setup --model ggml-tiny.bin --dir .whisper-cpp-tiny
 *
 * Nightly tags are resolved from the GitHub API, so no tag is hard-coded.
 * On Windows the official builds need the MSVC runtime (msvcp140.dll) and the
 * OpenMP runtime (vcomp140.dll); this tool runs the CLI once and says so
 * explicitly instead of leaving you with a bare 0xC0000135.
 */
import { createWriteStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import { dirname, join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const RELEASES_API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15";
const MODEL_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"];
const MODEL_REPO = "ggerganov/whisper.cpp";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

function parseArgs(argv: string[]): { cuda: boolean; model: string; dir: string } {
  const args = { cuda: false, model: "ggml-large-v3-turbo.bin", dir: ".whisper-cpp" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // pnpm/npm forward a literal "--" separator; ignore it rather than fail.
    if (flag === "--") continue;
    if (flag === "--cuda") args.cuda = true;
    else if (flag === "--model") args.model = argv[++i] ?? args.model;
    else if (flag === "--dir") args.dir = argv[++i] ?? args.dir;
    else throw new Error(`Unknown option ${flag}`);
  }
  return args;
}

/** Prebuilt CLI asset name for this platform, or a clear "build it yourself" error. */
function assetName(platform: NodeJS.Platform, arch: string, cuda: boolean): { name: string; kind: "zip" | "tar.gz" } {
  if (platform === "win32" && arch === "x64") {
    return { name: cuda ? "whisper-bin-win-cuda-12.4.0-x64.zip" : "whisper-bin-x64.zip", kind: "zip" };
  }
  if (platform === "linux" && arch === "x64") return { name: "whisper-bin-ubuntu-x64.tar.gz", kind: "tar.gz" };
  throw new Error(
    `No prebuilt whisper.cpp CLI for ${platform}-${arch}. Build it from source (https://github.com/ggml-org/whisper.cpp) ` +
    `or install it with your package manager, then set HOTCLIP_WHISPER_CPP_BIN yourself.`
  );
}

async function resolveAsset(wanted: string): Promise<{ tag: string; asset: ReleaseAsset }> {
  const response = await fetch(RELEASES_API, { headers: { "User-Agent": "hotclip-setup", Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  const releases = (await response.json()) as Release[];
  for (const release of releases) {
    const asset = release.assets?.find((candidate) => candidate.name === wanted);
    if (asset) return { tag: release.tag_name, asset };
  }
  throw new Error(`No "${wanted}" asset in the last ${releases.length} whisper.cpp releases`);
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "hotclip-setup" } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let done = 0;
  let lastPercent = -1;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    const percent = total ? Math.floor((done / total) * 100) : 0;
    if (percent !== lastPercent) {
      lastPercent = percent;
      process.stdout.write(`\r  ${percent}% (${(done / 1024 / 1024).toFixed(0)}MB)`);
    }
  });
  await pipeline(body, createWriteStream(dest));
  process.stdout.write("\r");
}

async function unzipArchive(archive: string, dest: string, kind: "zip" | "tar.gz"): Promise<void> {
  await mkdir(dest, { recursive: true });
  if (kind === "zip") {
    if (process.platform === "win32") {
      await execFileAsync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`]);
      return;
    }
    await execFileAsync("unzip", ["-o", "-q", archive, "-d", dest]);
    return;
  }
  await execFileAsync("tar", ["-xzf", archive, "-C", dest]);
}

/** Locate the CLI inside an extracted release tree. */
async function findCli(root: string): Promise<string> {
  const { readdir } = await import("fs/promises");
  const candidates = ["whisper-cli", "whisper-cli.exe", "main", "main.exe"];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (candidates.includes(entry.name)) return join(dir, entry.name);
    }
  }
  throw new Error(`No whisper-cli binary found under ${root}`);
}

/** Run the CLI once: a missing MSVC/OpenMP runtime shows up as 0xC0000135. */
async function checkRunnable(cli: string): Promise<void> {
  try {
    await execFileAsync(cli, ["--help"], { cwd: dirname(cli), timeout: 30_000 });
    process.stdout.write("binary runs: OK\n");
  } catch (error) {
    const failed = error as { code?: number | string; message?: string };
    if (failed.code === 3221225781 || failed.code === -1073741515 || failed.message?.includes("3221225781")) {
      process.stdout.write(
        "binary cannot start: DLL_NOT_FOUND (0xC0000135).\n" +
        "  Windows needs the MSVC runtime + OpenMP runtime next to the binary:\n" +
        "    msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll, vcomp140.dll\n" +
        "  Either install the Microsoft Visual C++ Redistributable (x64) or copy those DLLs into\n" +
        `  ${dirname(cli)}\n`
      );
      return;
    }
    process.stdout.write(`binary check skipped: ${failed.message ?? String(error)}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.dir);
  const { name, kind } = assetName(process.platform, process.arch, args.cuda);
  const { tag, asset } = await resolveAsset(name);
  process.stdout.write(`build: ${tag} / ${name} (${(asset.size / 1024 / 1024).toFixed(0)}MB)\n`);

  const buildDir = join(root, "build");
  const archive = join(root, name);
  await mkdir(root, { recursive: true });
  const existing = await stat(archive).catch(() => null);
  if (!existing || existing.size !== asset.size) {
    process.stdout.write("downloading build…\n");
    await download(asset.browser_download_url, archive);
  }
  await rm(buildDir, { recursive: true, force: true });
  await unzipArchive(archive, buildDir, kind);
  const cli = await findCli(buildDir);
  process.stdout.write(`cli: ${cli}\n`);
  await checkRunnable(cli);

  let modelPath = join(root, args.model);
  const model = await stat(modelPath).catch(() => null);
  if (!model) {
    process.stdout.write(`downloading ${args.model}…\n`);
    let lastError: unknown = null;
    for (const host of MODEL_HOSTS) {
      try {
        await download(`${host}/${MODEL_REPO}/resolve/main/${args.model}`, modelPath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await rm(modelPath, { force: true });
      }
    }
    if (lastError) throw lastError;
  }
  modelPath = resolve(modelPath);

  process.stdout.write(`\nmodel: ${modelPath} (${((await stat(modelPath)).size / 1024 / 1024).toFixed(0)}MB)\n`);
  process.stdout.write("\nSet these for the desktop app, CLI and MCP:\n\n");
  process.stdout.write(`  HOTCLIP_WHISPER_CPP_BIN=${cli}\n`);
  process.stdout.write(`  HOTCLIP_WHISPER_CPP_MODEL=${modelPath}\n\n`);
  process.stdout.write("Then verify end to end:\n\n");
  process.stdout.write(`  pnpm cli transcribe <media> --engine whisper-cpp --language tr\n\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`whisper.cpp setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
