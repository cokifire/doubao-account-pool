import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, clipboard } from "electron";
import type { AppDatabase } from "./database.js";
import { toPublicApiRequest } from "./public-api.js";
import type { Account, ApiRequest, AppSettings, DoubaoModel } from "./types.js";
import { resolveCleanVideoUrl } from "./watermark.js";

const DOUBAO_THREAD_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/thread\/[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i;

type DataChangedCallback = () => void;
type QueueItem = { requestId: string; mode: "generate" | "recover" };

export class DoubaoExecutor {
  private readonly queue: QueueItem[] = [];
  private running = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly onDataChanged: DataChangedCallback
  ) {}

  enqueue(requestId: string) {
    if (!this.queue.some((item) => item.requestId === requestId)) {
      this.queue.push({ requestId, mode: "generate" });
    }
    void this.drain();
  }

  enqueueRecovery(requestId: string) {
    if (!this.queue.some((item) => item.requestId === requestId)) {
      this.queue.push({ requestId, mode: "recover" });
    }
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        if (item.mode === "recover") {
          await this.recoverResult(item.requestId);
        } else {
          await this.execute(item.requestId);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async recoverResult(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request?.accountId) return;

    const account = this.database.getAccount(request.accountId);
    if (!account) return;

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在定位豆包已生成视频并重试复制分享链接"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await wait(2500);

      if (await looksLoggedOut(win)) {
        throw new Error("豆包账号未登录，无法恢复视频结果");
      }

      const shareUrl = await findGeneratedConversationAndCopyShare(win, request.prompt);
      if (!shareUrl) {
        throw new Error("未在该账号最近对话中找到匹配的已生成视频，或仍未复制到分享链接");
      }

      const cleanVideoUrl = await resolveCleanVideoUrl(settings, shareUrl);
      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, cleanVideoUrl);
      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? "已恢复结果，去水印 MP4 已验证并保存到本地"
          : "已恢复结果，去水印 MP4 地址已验证",
        doubaoThreadUrl: shareUrl,
        rawVideoUrl: null,
        cleanVideoUrl,
        outputVideoPath
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });
    } catch (error) {
      await this.failRequest(request, `恢复结果失败：${errorMessage(error)}`, false);
      this.database.updateAccount({ id: account.id, currentStatus: "error" });
      this.onDataChanged();
    } finally {
      if (win && !win.isDestroyed()) win.close();
    }
  }

  private async execute(requestId: string) {
    const request = this.database.getApiRequest(requestId);
    if (!request) return;

    if (!request.accountId) {
      await this.failRequest(request, "请求没有分配账号", false);
      return;
    }

    const account = this.database.getAccount(request.accountId);
    if (!account) {
      await this.failRequest(request, "分配账号不存在", false);
      return;
    }

    const settings = this.database.getSettings();
    let win: BrowserWindow | null = null;
    let submittedToDoubao = false;
    let keepWindowOpen = false;

    try {
      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在打开豆包执行窗口"
      });
      this.database.updateAccount({ id: account.id, currentStatus: "busy" });

      win = this.createExecutionWindow(account, settings);
      await loadUrl(win, settings.doubaoChatUrl || "https://www.doubao.com/chat");
      await wait(2500);

      if (await looksLoggedOut(win)) {
        this.database.updateAccount({
          id: account.id,
          loginStatus: "logged_out",
          currentStatus: "login_required"
        });
        keepWindowOpen = true;
        if (!win.isVisible()) {
          win.show();
        }
        throw new Error("豆包账号未登录，已打开登录窗口，请登录后重试");
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在切换豆包视频生成模式"
      });
      await activateVideoMode(win, request.model);

      if (request.referenceImagePath) {
        await this.updateProgress({
          requestId,
          status: "running",
          message: "正在上传参考图"
        });
        await uploadReferenceImage(win, request.referenceImagePath);
      }

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在填写提示词"
      });
      await fillPrompt(win, request.prompt);

      await this.updateProgress({
        requestId,
        status: "running",
        message: "正在提交豆包生成"
      });
      await submitPromptAndWait(win, request.model);
      submittedToDoubao = true;

      await this.updateProgress({
        requestId,
        status: "running",
        message: "已提交豆包，等待视频完成并复制分享链接"
      });

      const generationResult = await waitForGenerationResult(win, settings.generationTimeoutSeconds, async (message) => {
        await this.updateProgress({ requestId, status: "running", message });
      });

      if (!generationResult.shareUrl) {
        throw new Error("视频已生成，但未提取到豆包分享链接，无法获取去水印视频");
      }

      const doubaoThreadUrl = generationResult.shareUrl;
      if (!request.removeWatermark) {
        throw new Error("接口仅返回去水印视频，本次请求未启用去水印");
      }

      const cleanVideoUrl = await resolveCleanVideoUrl(settings, doubaoThreadUrl);
      const outputVideoPath = await downloadCleanVideoIfNeeded(settings, requestId, cleanVideoUrl);

      await this.updateProgress({
        requestId,
        status: "success",
        message: outputVideoPath
          ? "视频生成完成，去水印 MP4 已验证并保存到本地"
          : "视频生成完成，去水印 MP4 地址已验证",
        doubaoThreadUrl,
        rawVideoUrl: null,
        cleanVideoUrl,
        outputVideoPath
      });
      this.database.updateAccount({ id: account.id, currentStatus: "idle" });

      if (settings.autoCloseExecutorWindow) {
        win.close();
      }
    } catch (error) {
      if (!submittedToDoubao) {
        this.database.refundQuota(account.id, request.model);
      }
      await this.failRequest(request, errorMessage(error), !submittedToDoubao);
      this.database.updateAccount({
        id: account.id,
        currentStatus: submittedToDoubao ? "error" : "idle"
      });
      this.onDataChanged();
      if (win && !settings.showExecutorWindow && !keepWindowOpen && !win.isDestroyed()) {
        win.close();
      }
    }
  }

  private async updateProgress(input: Parameters<AppDatabase["updateApiRequest"]>[0]) {
    const updated = this.database.updateApiRequest(input);
    this.onDataChanged();
    await postCallback(updated);
    return updated;
  }

  private async failRequest(request: ApiRequest, message: string, refunded: boolean) {
    const suffix = refunded ? "，已退回预扣额度" : "";
    return this.updateProgress({
      requestId: request.requestId,
      status: "failed",
      message: `${message}${suffix}`
    });
  }

  private createExecutionWindow(account: Account, settings: AppSettings) {
    const titleName = account.remark || account.name;
    return new BrowserWindow({
      width: 1320,
      height: 860,
      show: settings.showExecutorWindow,
      title: `豆包执行器 - ${titleName}`,
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
  }
}

async function loadUrl(win: BrowserWindow, url: string) {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event: Electron.Event, _code: number, description: string) => {
      cleanup();
      reject(new Error(`豆包页面加载失败：${description}`));
    };
    win.webContents.once("did-finish-load", onFinish);
    win.webContents.once("did-fail-load", onFail);
    void win.loadURL(url);
  });
}

async function looksLoggedOut(win: BrowserWindow) {
  return runPageScript<boolean>(win, `
    (() => {
      const text = document.body?.innerText || "";
      const loginWords = ["扫码登录", "手机号登录", "验证码登录", "登录/注册"];
      return loginWords.some((word) => text.includes(word));
    })()
  `);
}

async function uploadReferenceImage(win: BrowserWindow, imagePath: string) {
  const resolvedPath = path.resolve(imagePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`参考图不存在：${resolvedPath}`);
  }

  if (await setFirstFileInput(win, resolvedPath)) {
    await wait(2500);
    return;
  }

  await clickByKeywords(win, ["上传", "参考图", "图片", "添加图片", "附件", "image", "upload"]);
  await wait(1200);

  if (await setFirstFileInput(win, resolvedPath)) {
    await wait(2500);
    return;
  }

  throw new Error("没有找到豆包页面的图片上传控件");
}

async function setFirstFileInput(win: BrowserWindow, filePath: string) {
  const debug = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debug.isAttached()) {
      debug.attach("1.3");
      attachedHere = true;
    }
    const documentResult = await debug.sendCommand("DOM.getDocument", { depth: -1, pierce: true }) as {
      root: { nodeId: number };
    };
    const inputs = await debug.sendCommand("DOM.querySelectorAll", {
      nodeId: documentResult.root.nodeId,
      selector: 'input[type="file"]'
    }) as { nodeIds: number[] };

    if (!inputs.nodeIds.length) return false;
    await debug.sendCommand("DOM.setFileInputFiles", {
      nodeId: inputs.nodeIds[0],
      files: [filePath]
    });
    return true;
  } finally {
    if (attachedHere && debug.isAttached()) {
      debug.detach();
    }
  }
}

async function fillPrompt(win: BrowserWindow, prompt: string) {
  const target = await runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = [
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            el.getAttribute("data-placeholder")
          ].filter(Boolean).join(" ");
          const composerScore = /发送消息|发消息|输入消息|prompt|message/i.test(label) ? 100000 : 0;
          const searchPenalty = /搜索|search/i.test(label) ? 100000 : 0;
          return { el, rect, label, score: composerScore - searchPenalty + rect.bottom };
        })
        .sort((a, b) => b.score - a.score);

      const candidate = candidates[0];
      if (!candidate) return null;

      const el = candidate.el;
      el.focus();
      return {
        x: Math.round(candidate.rect.left + Math.min(120, candidate.rect.width * 0.25)),
        y: Math.round(candidate.rect.top + candidate.rect.height / 2),
        debug: candidate.label || el.tagName.toLowerCase()
      };
    })()
  `);

  if (!target) {
    throw new Error("没有找到豆包提示词输入框");
  }

  await sendMouseClick(win, target.x, target.y);
  await sendKeyboard(win, "A", ["meta"], 100);
  await sendKeyboard(win, "Backspace", undefined, 100);
  await win.webContents.insertText(prompt);
  await wait(900);

  const diagnostics = await inspectComposer(win);
  if (!diagnostics.promptPresent) {
    throw new Error(`豆包输入框没有真正接收提示词（${formatComposerDiagnostics(diagnostics)}）`);
  }
}

async function activateVideoMode(win: BrowserWindow, model: DoubaoModel) {
  const target = model === "seedance_2_0_mini" ? "Mini" : "Fast";
  await clickByKeywords(win, ["视频生成"]);
  await wait(800);
  await clickByKeywords(win, ["Seedance", "模型", "model"]);
  await wait(500);
  await clickByKeywords(win, [target, model === "seedance_2_0_mini" ? "mini" : "fast"]);
  await wait(500);
}

async function submitPromptAndWait(win: BrowserWindow, model: DoubaoModel) {
  const attempts: Array<{ label: string; run: () => Promise<boolean> }> = [
    {
      label: "Enter",
      run: async () => {
        await sendKeyboard(win, "Enter");
        return true;
      }
    },
    {
      label: "Command+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["meta"]);
        return true;
      }
    },
    {
      label: "Control+Enter",
      run: async () => {
        await sendKeyboard(win, "Enter", ["control"]);
        return true;
      }
    },
    {
      label: "右下角发送图标",
      run: async () => {
        const sendPoint = await findComposerSendButtonPoint(win);
        if (!sendPoint) return false;
        await sendMouseClick(win, sendPoint.x, sendPoint.y);
        return true;
      }
    },
    {
      label: "发送文字按钮",
      run: () => clickByKeywords(win, ["发送", "提交"])
    }
  ];

  const tried: string[] = [];
  for (const attempt of attempts) {
    const didRun = await attempt.run();
    if (!didRun) continue;
    tried.push(attempt.label);
    if (await waitForSubmissionStarted(win, model, 5000)) return;
  }

  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : "Seedance 2.0 Fast";
  const diagnostics = await inspectComposer(win);
  throw new Error(
    `没有看到豆包提交确认文案：本次使用 ${modelLabel} 生成；已尝试 ${tried.join("、") || "无可用发送动作"}；${formatComposerDiagnostics(diagnostics)}`
  );
}

async function sendKeyboard(
  win: BrowserWindow,
  keyCode: string,
  modifiers?: Array<"control" | "meta">,
  settleMs = 700
) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  await wait(80);
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await wait(settleMs);
}

async function inspectComposer(win: BrowserWindow) {
  return runPageScript<{
    promptPresent: boolean;
    textLength: number;
    activeElement: string;
    sendCandidates: number;
    enabledSendCandidates: number;
  }>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const active = document.activeElement;
      const activeEditable = active?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      const editorText = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
        ? editor.value
        : (editor?.innerText || editor?.textContent || "");
      const sendNodes = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title]'))
        .filter((el) => visible(el))
        .filter((el) => /发送|提交|send/i.test([
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title")
        ].filter(Boolean).join(" ")));
      const enabled = sendNodes.filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const normalizedText = editorText.replace(/\\s+/g, "").trim();
      return {
        promptPresent: normalizedText.length > 0,
        textLength: normalizedText.length,
        activeElement: active
          ? active.tagName.toLowerCase() + (active.getAttribute("role") ? "[role=" + active.getAttribute("role") + "]" : "")
          : "none",
        sendCandidates: sendNodes.length,
        enabledSendCandidates: enabled.length
      };
    })()
  `);
}

function formatComposerDiagnostics(input: Awaited<ReturnType<typeof inspectComposer>>) {
  return `输入框实际字数 ${input.textLength}，焦点 ${input.activeElement}，可用发送按钮 ${input.enabledSendCandidates}/${input.sendCandidates}`;
}

async function findComposerSendButtonPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const editableSelector = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';
      const activeEditable = document.activeElement?.closest?.(editableSelector);
      const editables = Array.from(document.querySelectorAll(editableSelector))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = activeEditable && visible(activeEditable) ? activeEditable : editables[0];
      if (!editor) return null;

      const editorRect = editor.getBoundingClientRect();
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").trim();
      const isEditorAncestor = (el) => el === editor || editor.contains(el);
      const clickables = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex], [aria-label]'))
        .filter((el) => visible(el) && !el.disabled && !isEditorAncestor(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const nearEditor = cy >= editorRect.top - 40
            && cy <= editorRect.bottom + 90
            && cx >= editorRect.left + editorRect.width * 0.62
            && cx <= Math.max(editorRect.right + 140, window.innerWidth);
          const lowerRight = cy >= window.innerHeight * 0.55 && cx >= window.innerWidth * 0.55;
          const compact = rect.width <= 96 && rect.height <= 96;
          const badText = /视频生成|图像生成|音乐生成|更多|快速|帮我写作|录音转写|翻译|图片|\\+|添加|上传/.test(text);
          const sendText = /发送|提交/.test(text) ? 1000 : 0;
          return { el, rect, text, cx, cy, nearEditor, lowerRight, compact, badText, score: sendText + cx + cy / 10 };
        })
        .filter((item) => (item.nearEditor || item.lowerRight) && item.compact && !item.badText)
        .sort((a, b) => b.score - a.score);

      const target = clickables[0];
      if (!target) return null;
      return {
        x: Math.round(target.cx),
        y: Math.round(target.cy),
        debug: target.text || target.el.tagName
      };
    })()
  `);
}

async function sendMouseClick(win: BrowserWindow, x: number, y: number) {
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await wait(80);
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

async function waitForSubmissionStarted(win: BrowserWindow, model: DoubaoModel, timeoutMs = 15000) {
  const modelLabel = model === "seedance_2_0_mini" ? "Seedance 2.0 Mini" : "Seedance 2.0 Fast";
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await runPageScript<{ confirmed: boolean; pageTextExcerpt: string }>(win, `
      (() => {
        const modelLabel = ${JSON.stringify(modelLabel)};
        const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const expected = "本次使用 " + modelLabel + " 生成";
        return {
          confirmed: pageText.includes(expected)
            && pageText.includes("视频生成好后")
            && pageText.includes("本次生成将消耗每日免费额度"),
          pageTextExcerpt: pageText.slice(-500)
        };
      })()
    `);

    if (state.confirmed) {
      return true;
    }
    await wait(1000);
  }

  return false;
}

interface GenerationPageState {
  generated: boolean;
  failed: boolean;
  directVideoUrl: string | null;
  visibleVideoCount: number;
}

interface GenerationResult {
  shareUrl: string | null;
  directVideoUrl: string | null;
}

async function waitForGenerationResult(
  win: BrowserWindow,
  timeoutSeconds: number,
  onProgress: (message: string) => Promise<void> | void
): Promise<GenerationResult> {
  const timeoutMs = Math.max(60, timeoutSeconds || 900) * 1000;
  const startedAt = Date.now();
  let generatedAt = 0;
  let lastProgressAt = 0;
  let directVideoUrl: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const pageState = await inspectGenerationPage(win);
    if (pageState.failed) {
      throw new Error("豆包已返回视频生成失败");
    }

    if (pageState.generated) {
      if (!generatedAt) {
        generatedAt = Date.now();
        await onProgress("视频已生成，正在进入分享模式并复制链接");
      }
      directVideoUrl ||= pageState.directVideoUrl;

      const copiedUrl = await tryCopyShareLink(win);
      if (copiedUrl) {
        return { shareUrl: copiedUrl, directVideoUrl };
      }

      if (Date.now() - generatedAt > 120000) {
        return { shareUrl: null, directVideoUrl };
      }
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (Date.now() - lastProgressAt > 30000) {
      lastProgressAt = Date.now();
      await onProgress(generatedAt
        ? `视频已生成，正在重试复制分享链接 ${Math.floor((Date.now() - generatedAt) / 1000)}s`
        : `已提交豆包，等待生成完成 ${elapsedSeconds}s`);
    }
    await wait(5000);
  }

  if (generatedAt) {
    return { shareUrl: null, directVideoUrl };
  }
  throw new Error("等待豆包视频生成超时");
}

async function inspectGenerationPage(win: BrowserWindow) {
  return runPageScript<GenerationPageState>(win, `
    (() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
      };
      const pageText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const videos = Array.from(document.querySelectorAll("video")).filter(visible);
      const videoUrls = videos.flatMap((video) => [
        video.currentSrc,
        video.src,
        ...Array.from(video.querySelectorAll("source[src]")).map((source) => source.src)
      ]).filter((value) => /^https?:\\/\\//i.test(value || ""));
      const completedByText = /你的视频生成好[了啦]|视频已生成|视频生成完成|生成视频已完成/.test(pageText);
      const playableVideo = videos.some((video) => Boolean(video.currentSrc || video.src || video.poster || video.readyState >= 1));
      return {
        generated: completedByText || playableVideo,
        failed: /视频生成失败|生成视频失败|未能生成视频/.test(pageText),
        directVideoUrl: videoUrls[videoUrls.length - 1] || null,
        visibleVideoCount: videos.length
      };
    })()
  `);
}

async function findGeneratedConversationAndCopyShare(win: BrowserWindow, prompt: string) {
  const candidates = await runPageScript<string[]>(win, `
    (() => Array.from(document.querySelectorAll('a[href*="/chat/"]'))
      .map((link) => link.href)
      .filter((href, index, values) => /^https?:\\/\\/(?:www\\.)?doubao\\.com\\/chat\\/[A-Za-z0-9_-]+(?:[?#].*)?$/i.test(href)
        && values.indexOf(href) === index)
      .slice(0, 30))()
  `);
  const signature = normalizeComparableText(prompt).slice(0, 42);

  for (const candidate of candidates) {
    await loadUrl(win, candidate);
    await wait(1200);
    const pageText = await runPageScript<string>(win, `document.body?.innerText || ""`);
    if (!normalizeComparableText(pageText).includes(signature)) continue;

    const pageState = await inspectGenerationPage(win);
    if (!pageState.generated || pageState.failed) continue;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const shareUrl = await tryCopyShareLink(win);
      if (shareUrl) return shareUrl;
      await wait(1000);
    }
  }

  return null;
}

function normalizeComparableText(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

async function tryCopyShareLink(win: BrowserWindow) {
  const before = clipboard.readText();
  const clipboardSentinel = `__doubao_share_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  clipboard.writeText(clipboardSentinel);
  let shareState = await inspectShareSelection(win);

  if (!shareState.active) {
    await openShareSelection(win);
    const directlyCopiedUrl = extractDoubaoShareUrl(clipboard.readText());
    if (directlyCopiedUrl) {
      return directlyCopiedUrl;
    }
    shareState = await inspectShareSelection(win);
  }

  if (!shareState.active) {
    restoreClipboardAfterFailedShare(before, clipboardSentinel);
    return null;
  }

  if (!shareState.hasSelection) {
    const selectAllPoint = await findTextControlPoint(win, ["全选"]);
    if (selectAllPoint) {
      await sendMouseClick(win, selectAllPoint.x, selectAllPoint.y);
      await wait(500);
      shareState = await inspectShareSelection(win);
    }
  }

  const copyPoint = await findTextControlPoint(win, ["复制链接"]);
  if (!copyPoint || (!shareState.copyEnabled && shareState.checkboxCount > 0)) {
    restoreClipboardAfterFailedShare(before, clipboardSentinel);
    return null;
  }

  await sendMouseClick(win, copyPoint.x, copyPoint.y);
  await wait(900);
  const copied = clipboard.readText();
  const shareUrl = extractDoubaoShareUrl(copied);
  if (shareUrl) {
    return shareUrl;
  }

  restoreClipboardAfterFailedShare(before, clipboardSentinel);
  return null;
}

function restoreClipboardAfterFailedShare(before: string, sentinel: string) {
  const current = clipboard.readText();
  if (current === sentinel || !extractDoubaoShareUrl(current)) {
    clipboard.writeText(before);
  }
}

async function inspectShareSelection(win: BrowserWindow) {
  return runPageScript<{
    active: boolean;
    hasSelection: boolean;
    checkboxCount: number;
    copyEnabled: boolean;
  }>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [tabindex]'))
        .filter(visible);
      const copyControls = controls.filter((el) => textOf(el).includes("复制链接"));
      const allText = (document.body?.innerText || "").replace(/\\s+/g, " ");
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
      const checked = checkboxes.filter((el) => el.checked === true || el.getAttribute("aria-checked") === "true");
      const copyEnabled = copyControls.some((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
      return {
        active: copyControls.length > 0 && allText.includes("全选"),
        hasSelection: checked.length > 0 || copyEnabled,
        checkboxCount: checkboxes.length,
        copyEnabled
      };
    })()
  `);
}

async function openShareSelection(win: BrowserWindow) {
  const sharePoint = await findTextControlPoint(win, ["分享"], ["分享图片"]);
  if (sharePoint) {
    await sendMouseClick(win, sharePoint.x, sharePoint.y);
    await wait(1000);
    if ((await inspectShareSelection(win)).active) return true;
  }

  const menuPoint = await findOverflowMenuPoint(win);
  if (menuPoint) {
    await sendMouseClick(win, menuPoint.x, menuPoint.y);
    await wait(500);
    const menuSharePoint = await findTextControlPoint(win, ["分享"], ["分享图片"]);
    if (menuSharePoint) {
      await sendMouseClick(win, menuSharePoint.x, menuSharePoint.y);
      await wait(1000);
      return (await inspectShareSelection(win)).active;
    }
  }

  return false;
}

async function findTextControlPoint(win: BrowserWindow, keywords: string[], excluded: string[] = []) {
  return runPageScript<{ x: number; y: number; debug: string } | null>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords)};
      const excluded = ${JSON.stringify(excluded)};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title")
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, label, [tabindex], [aria-label], [title], div, span'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const exact = keywords.some((word) => text === word);
          const contains = keywords.some((word) => text.includes(word));
          const blocked = excluded.some((word) => text.includes(word));
          const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
          return { el, rect, text, exact, contains, blocked, enabled };
        })
        .filter((item) => item.contains
          && !item.blocked
          && item.rect.width <= 480
          && item.rect.height <= 140)
        .sort((a, b) => Number(b.enabled) - Number(a.enabled)
          || Number(b.exact) - Number(a.exact)
          || b.rect.bottom - a.rect.bottom);
      const target = nodes[0];
      if (!target) return null;
      return {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2),
        debug: target.text
      };
    })()
  `);
}

async function findOverflowMenuPoint(win: BrowserWindow) {
  return runPageScript<{ x: number; y: number } | null>(win, `
    (() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const allNodes = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title]'))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = [el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")]
            .filter(Boolean).join(" ").trim();
          return { rect, text };
        });
      const labeledNodes = allNodes
        .filter((item) => /更多|操作|^\\.{3}$|^…$|^⋯$/.test(item.text) && item.rect.width <= 80 && item.rect.height <= 80)
        .sort((a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
      const headerFallback = allNodes
        .filter((item) => item.rect.top >= 0
          && item.rect.top <= 120
          && item.rect.right >= window.innerWidth * 0.82
          && item.rect.width <= 80
          && item.rect.height <= 80)
        .sort((a, b) => b.rect.right - a.rect.right);
      const headerLabeled = labeledNodes.filter((item) => item.rect.top <= 120);
      const target = headerLabeled[0] || headerFallback[0] || labeledNodes[0];
      return target ? {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(target.rect.top + target.rect.height / 2)
      } : null;
    })()
  `);
}

async function clickByKeywords(win: BrowserWindow, keywords: string[]) {
  return runPageScript<boolean>(win, `
    (() => {
      const keywords = ${JSON.stringify(keywords.map((item) => item.toLowerCase()))};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => [
        el.innerText,
        el.textContent,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("placeholder")
      ].filter(Boolean).join(" ").trim();
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, label, div[tabindex], span[tabindex]'))
        .filter((el) => visible(el));
      const scored = nodes
        .map((el) => {
          const text = textOf(el).toLowerCase();
          const score = keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
          const tagScore = el.tagName === "BUTTON" ? 3 : el.getAttribute("role") === "button" ? 2 : 1;
          return { el, text, score, tagScore };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.tagScore - a.tagScore);
      const target = scored[0]?.el;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.click();
      return true;
    })()
  `);
}

async function downloadCleanVideoIfNeeded(settings: AppSettings, requestId: string, cleanVideoUrl: string) {
  if (!settings.outputDir.trim()) return null;
  await fs.mkdir(settings.outputDir, { recursive: true });
  const response = await fetch(cleanVideoUrl);
  if (!response.ok) {
    throw new Error(`下载去水印视频失败：HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("video/") && !contentType.includes("application/octet-stream")) {
    throw new Error(`下载结果不是视频文件：Content-Type ${contentType || "unknown"}`);
  }

  const outputPath = path.join(settings.outputDir, `${requestId}.mp4`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new Error("下载到的去水印 MP4 文件为空");
  }
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

async function postCallback(request: ApiRequest) {
  if (!request.callbackUrl) return;
  await fetch(request.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(request))
  }).catch(() => undefined);
}

async function runPageScript<T>(win: BrowserWindow, script: string) {
  return win.webContents.executeJavaScript(script, true) as Promise<T>;
}

function extractDoubaoShareUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_THREAD_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "执行器未知错误";
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
