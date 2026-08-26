// 开发模式启动器（跨平台）。
//
// 背景：Windows 控制台默认代码页为 GBK(936)，而 Electron/Vite 等以 UTF-8 向
// stdout 写入中文日志。经 npm-run-all 管道转发后，终端会把 UTF-8 字节按 GBK
// 渲染，导致中文日志乱码（如「自动」显示成「鑷姩」）。
// 因此启动前先把共享控制台代码页切换为 UTF-8(65001)，仅对当前终端生效。
// macOS/Linux 无此问题，不需要处理。
import { spawnSync, spawn } from "node:child_process";

if (process.platform === "win32") {
  try {
    spawnSync("chcp", ["65001"], { stdio: "ignore", shell: true });
  } catch {
    // 无控制台等场景下失败可忽略，仅影响日志显示，不阻断启动。
  }
}

const child = spawn("npm-run-all", ["-p", "dev:renderer", "dev:electron"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("error", (error) => {
  console.error("启动 dev 失败：", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
