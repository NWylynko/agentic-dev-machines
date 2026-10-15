import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

const binaries = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

async function browserBinary() {
  for (const path of binaries) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("chromium is not installed in this workspace image");
}

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  process.stderr.write("browser: first argument must be an http(s) URL\n");
  process.exit(1);
}
const shot = process.argv.indexOf("--screenshot");
const screenshot = shot >= 0 ? process.argv[shot + 1] : "";
if (shot >= 0 && (!screenshot || screenshot.includes("\0"))) {
  process.stderr.write(
    "browser: --screenshot needs a path inside the workspace\n",
  );
  process.exit(1);
}

let profile;
let child;
let receivedSignal;
const signalBrowserGroup = (signal) => {
  if (!child) return;
  if (process.platform === "win32") {
    child.kill(signal);
  } else if (child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        process.stderr.write(
          `browser: failed to signal Chromium process group: ${error.message}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
};
const forwardSignal = (signal) => {
  receivedSignal = signal;
  signalBrowserGroup(signal);
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);

try {
  const binary = await browserBinary();
  profile = await mkdtemp(join(tmpdir(), "adm-browser-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`,
  ];
  if (screenshot)
    args.push(`--screenshot=${screenshot}`, "--window-size=1280,720");
  else args.push("--dump-dom");
  args.push("--virtual-time-budget=10000", url);
  child = spawn(binary, args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
    env: { ...process.env, TMPDIR: profile },
  });
  if (receivedSignal) signalBrowserGroup(receivedSignal);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (receivedSignal) {
    process.exitCode = 128 + (osConstants.signals[receivedSignal] ?? 1);
  } else if (result.code !== null) process.exitCode = result.code;
  else if (result.signal) {
    process.exitCode = 128 + (osConstants.signals[result.signal] ?? 1);
  }
} catch (error) {
  process.stderr.write(
    `browser: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exitCode = 1;
} finally {
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);
  if (receivedSignal && process.platform !== "win32")
    signalBrowserGroup("SIGKILL");
  if (profile) await rm(profile, { recursive: true });
}
