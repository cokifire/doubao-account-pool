import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";
import log from "electron-log/main.js";
import { AppDatabase } from "./database.js";
import { DoubaoExecutor } from "./executor.js";
import { toPublicApiRequest } from "./public-api.js";
import type {
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  GenerateRequestBody
} from "./types.js";
import { resolveCleanVideoUrl } from "./watermark.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let executor: DoubaoExecutor;
let apiServer: LocalApiServer;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

class LocalApiServer {
  private server: Server | null = null;
  private status: ApiServerStatus = {
    enabled: false,
    running: false,
    port: 0,
    url: null,
    message: "未启动"
  };

  constructor(
    private readonly database: AppDatabase,
    private readonly requestExecutor: DoubaoExecutor
  ) {}

  async applySettings(settings: AppSettings) {
    await this.stop();

    this.status = {
      enabled: settings.apiServiceEnabled,
      running: false,
      port: settings.apiPort,
      url: null,
      message: settings.apiServiceEnabled ? "启动中" : "已关闭"
    };

    if (!settings.apiServiceEnabled) return this.status;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server!.once("error", (error) => {
        this.status = {
          enabled: true,
          running: false,
          port: settings.apiPort,
          url: null,
          message: `启动失败：${error.message}`
        };
        resolve();
      });

      this.server!.listen(settings.apiPort, "127.0.0.1", () => {
        this.status = {
          enabled: true,
          running: true,
          port: settings.apiPort,
          url: `http://127.0.0.1:${settings.apiPort}`,
          message: "运行中"
        };
        resolve();
      });
    });

    return this.status;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  getStatus() {
    return this.status;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const settings = this.database.getSettings();

    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "doubao-account-pool",
          api: this.getStatus()
        });
        return;
      }

      if (!isAuthorized(request, settings.apiKey)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
        sendJson(response, 200, { accounts: this.database.listAccounts() });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate") {
        const requestId = `doubao-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const body = await readGenerateRequest(request, requestId);
        const prompt = body.prompt?.trim();
        if (!prompt) {
          sendJson(response, 400, { error: "prompt is required" });
          return;
        }

        const model = normalizeModel(body.model || settings.defaultModel);
        if (!model) {
          sendJson(response, 400, { error: "unsupported model" });
          return;
        }

        const referenceImagePath = await prepareReferenceImage(body, requestId);
        const account = this.database.findAvailableAccount(model);
        const cost = model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost;

        if (!account) {
          const failed = this.database.createApiRequest({
            requestId,
            source: body.source,
            model,
            status: "failed",
            message: "没有可用账号，或该模型剩余额度不足",
            prompt,
            referenceImagePath,
            removeWatermark: true,
            callbackUrl: body.callbackUrl
          });
          notifyDataChanged();
          void postCallback(failed);
          sendJson(response, 409, toPublicApiRequest(failed));
          return;
        }

        this.database.deductQuota(account.id, model);
        const created = this.database.createApiRequest({
          requestId,
          source: body.source,
          model,
          accountId: account.id,
          status: "accepted",
          message: settings.executorEnabled
            ? `已接收，已预扣 ${cost} 额度，已进入执行队列`
            : `已接收，已预扣 ${cost} 额度，自动执行已关闭`,
          prompt,
          referenceImagePath,
          removeWatermark: true,
          callbackUrl: body.callbackUrl
        });
        if (settings.executorEnabled) {
          this.requestExecutor.enqueue(created.requestId);
        }
        notifyDataChanged();
        void postCallback(created);
        sendJson(response, 202, toPublicApiRequest(created));
        return;
      }

      const recoveryMatch = requestUrl.pathname.match(/^\/api\/requests\/([^/]+)\/retry-result$/);
      if (request.method === "POST" && recoveryMatch) {
        const requestId = decodeURIComponent(recoveryMatch[1]);
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        if (!apiRequest.accountId) {
          sendJson(response, 409, { error: "request has no assigned account" });
          return;
        }
        this.requestExecutor.enqueueRecovery(requestId);
        sendJson(response, 202, {
          requestId,
          status: "accepted",
          message: "已进入结果恢复队列，不会重新提交视频生成"
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/requests/")) {
        const requestId = decodeURIComponent(requestUrl.pathname.replace("/api/requests/", ""));
        const apiRequest = this.database.getApiRequest(requestId);
        if (!apiRequest) {
          sendJson(response, 404, { error: "request not found" });
          return;
        }
        sendJson(response, 200, toPublicApiRequest(apiRequest));
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/watermark/parse") {
        const body = await readJsonBody<{ url?: string }>(request);
        const sourceUrl = body.url?.trim();
        if (!sourceUrl) {
          sendJson(response, 400, { error: "url is required" });
          return;
        }
        try {
          const cleanVideoUrl = await resolveCleanVideoUrl(settings, sourceUrl);
          sendJson(response, 200, {
            status: "success",
            message: "去水印 MP4 地址已验证",
            cleanVideoUrl,
            outputVideoPath: null
          });
        } catch (error) {
          sendJson(response, 422, {
            status: "failed",
            message: error instanceof Error ? error.message : "去水印解析失败",
            cleanVideoUrl: null,
            outputVideoPath: null
          });
        }
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: "豆包账号池接口服务",
    webPreferences: {
      preload: path.join(__dirname, "preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function createDoubaoWindow(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const titleName = account.remark || account.name;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    title: `豆包 - ${titleName}`,
    webPreferences: {
      partition: account.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void win.loadURL("https://www.doubao.com/chat");
}

async function detectLoginStatus(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  const cookies = await accountSession.cookies.get({ url: "https://www.doubao.com" });
  return db.updateAccount({
    id: accountId,
    loginStatus: cookies.length > 0 ? "logged_in" : "logged_out",
    currentStatus: cookies.length > 0 ? "idle" : "login_required"
  });
}

async function detectAllLoginStatuses() {
  const accounts = db.listAccounts();
  for (const account of accounts) {
    await detectLoginStatus(account.id);
  }
  return db.listAccounts();
}

async function clearAccountSession(accountId: number) {
  const account = db.getAccount(accountId);
  if (!account) throw new Error("Account not found");

  const accountSession = session.fromPartition(account.partition);
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  return db.updateAccount({
    id: accountId,
    loginStatus: "logged_out",
    currentStatus: "login_required"
  });
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => db.listAccounts());
  ipcMain.handle("accounts:create", (_event, remark?: string) => db.createAccount({ remark }));
  ipcMain.handle("accounts:update", (_event, input: AccountUpdateInput) => db.updateAccount(input));
  ipcMain.handle("accounts:delete", async (_event, id: number) => {
    await clearAccountSession(id);
    db.deleteAccount(id);
    return true;
  });
  ipcMain.handle("accounts:open", (_event, id: number) => createDoubaoWindow(id));
  ipcMain.handle("accounts:relogin", async (_event, id: number) => {
    await clearAccountSession(id);
    createDoubaoWindow(id);
    return true;
  });
  ipcMain.handle("accounts:detect-login", (_event, id: number) => detectLoginStatus(id));
  ipcMain.handle("accounts:detect-all", () => detectAllLoginStatuses());
  ipcMain.handle("accounts:reset-quota", (_event, id: number) => db.resetAccountQuota(id));
  ipcMain.handle("accounts:reset-all-quotas", () => db.resetAllQuotas());

  ipcMain.handle("settings:get", () => db.getSettings());
  ipcMain.handle("settings:update", async (_event, input: AppSettingsUpdateInput) => {
    const settings = db.updateSettings(input);
    await apiServer.applySettings(settings);
    return settings;
  });

  ipcMain.handle("api-server:status", () => apiServer.getStatus());
  ipcMain.handle("api-server:restart", async () => apiServer.applySettings(db.getSettings()));

  ipcMain.handle("api-requests:list", (_event, limit?: number) => db.listApiRequests(limit || 100));
  ipcMain.handle("api-requests:clear", () => {
    db.clearApiRequests();
    return true;
  });
}

function notifyDataChanged() {
  mainWindow?.webContents.send("data:changed");
}

function normalizeModel(model: string): DoubaoModel | null {
  if (model === "seedance_2_0_mini" || model === "seedance_2_0_fast") return model;
  return null;
}

function isAuthorized(request: IncomingMessage, apiKey: string) {
  if (!apiKey.trim()) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

async function readGenerateRequest(request: IncomingMessage, requestId: string): Promise<GenerateRequestBody> {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartGenerateRequest(await readBufferBody(request), contentType, requestId);
  }
  return readJsonBody<GenerateRequestBody>(request);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = (await readBufferBody(request)).toString("utf8");
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

async function readBufferBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseMultipartGenerateRequest(buffer: Buffer, contentType: string, requestId: string): Promise<GenerateRequestBody> {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error("multipart boundary is required");

  const fields: Record<string, string> = {};
  let uploadedReferenceImagePath: string | null = null;
  const delimiter = Buffer.from(`--${boundary}`);

  for (const rawPart of splitBuffer(buffer, delimiter)) {
    let part = rawPart;
    if (part.length === 0 || part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    if (!disposition.name) continue;

    if (disposition.filename) {
      if (!uploadedReferenceImagePath && body.length > 0) {
        uploadedReferenceImagePath = await saveUploadedFile({
          requestId,
          fieldName: disposition.name,
          filename: disposition.filename,
          contentType: headers["content-type"],
          bytes: body
        });
      }
      continue;
    }

    fields[disposition.name] = body.toString("utf8");
  }

  return {
    model: fields.model as DoubaoModel | undefined,
    prompt: fields.prompt || "",
    referenceImagePath: uploadedReferenceImagePath || fields.referenceImagePath || null,
    referenceImageUrl: fields.referenceImageUrl || null,
    removeWatermark: parseOptionalBoolean(fields.removeWatermark),
    callbackUrl: fields.callbackUrl || null,
    source: fields.source || "multipart-api"
  };
}

async function prepareReferenceImage(body: GenerateRequestBody, requestId: string) {
  if (body.referenceImagePath?.trim()) return body.referenceImagePath.trim();
  const imageUrl = body.referenceImageUrl?.trim();
  if (!imageUrl) return null;

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`参考图下载失败：HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const urlExt = path.extname(new URL(imageUrl).pathname);
  const ext = urlExt || extensionFromContentType(contentType) || ".png";
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const imagePath = path.join(uploadDir, `${requestId}-reference${ext}`);
  await fs.writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
  return imagePath;
}

async function saveUploadedFile(input: {
  requestId: string;
  fieldName: string;
  filename: string;
  contentType?: string;
  bytes: Buffer;
}) {
  const safeName = sanitizeFilename(input.filename || `${input.fieldName}${extensionFromContentType(input.contentType) || ".png"}`);
  const uploadDir = path.join(app.getPath("userData"), "uploads", new Date().toISOString().slice(0, 10));
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, `${input.requestId}-${input.fieldName}-${safeName}`);
  await fs.writeFile(filePath, input.bytes);
  return filePath;
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    if (index > start) {
      parts.push(buffer.subarray(start, index));
    }
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function parsePartHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string) {
  const result: { name?: string; filename?: string } = {};
  for (const item of value.split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const unquoted = rawValue.join("=").trim().replace(/^"|"$/g, "");
    if (key === "name") result.name = unquoted;
    if (key === "filename") result.filename = unquoted;
  }
  return result;
}

function parseOptionalBoolean(value: string | undefined) {
  if (value == null || value === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function extensionFromContentType(contentType?: string) {
  if (!contentType) return null;
  if (contentType.includes("jpeg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return null;
}

function sanitizeFilename(value: string) {
  const cleaned = value.replace(/[/\\?%*:|"<>]/g, "_").trim();
  return cleaned.slice(0, 120) || "reference-image";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (statusCode === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(payload, null, 2));
}

async function postCallback(payload: ApiRequest) {
  if (!payload.callbackUrl) return;
  await fetch(payload.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toPublicApiRequest(payload))
  }).catch(() => undefined);
}

app.whenReady().then(async () => {
  log.initialize();
  db = new AppDatabase();
  executor = new DoubaoExecutor(db, notifyDataChanged);
  apiServer = new LocalApiServer(db, executor);
  registerIpc();
  await apiServer.applySettings(db.getSettings());
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((error) => {
  log.error(error);
});

app.on("before-quit", async () => {
  await apiServer?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
