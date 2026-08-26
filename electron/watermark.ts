import type { AppSettings } from "./types.js";

const VIDEO_URL_KEYS = [
  "cleanVideoUrl",
  "videoUrl",
  "downloadUrl",
  "download_url",
  "playUrl",
  "play_url",
  "url"
];

const UNSUPPORTED_RE = /平台暂不支持|暂不支持|不支持该平台|unsupported platform|not supported/i;
// The provider may return before its clean MP4/CDN object is ready. Use a
// longer backoff so eventual-consistency responses are not treated as failures.
export const WATERMARK_RETRY_DELAYS_MS = [0, 5000, 15000, 30000, 60000] as const;
const REQUEST_TIMEOUT_MS = 20000;
const SHARE_PAGE_TIMEOUT_MS = 10000;

export interface WatermarkRetryInfo {
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
  elapsedMs: number;
}

type WatermarkRetryCallback = (info: WatermarkRetryInfo) => void | Promise<void>;

export interface WatermarkResolveOptions {
  maxAttempts?: number;
}

export function getWatermarkRetryDelays(
  maxAttempts: number = WATERMARK_RETRY_DELAYS_MS.length
) {
  const attemptCount = Math.max(
    1,
    Math.min(WATERMARK_RETRY_DELAYS_MS.length, Math.floor(maxAttempts))
  );
  return WATERMARK_RETRY_DELAYS_MS.slice(0, attemptCount);
}

// 只有 /thread/（以及 /share/）才是豆包公开分享链接；
// /chat/<id> 是需登录的会话页面地址，不是分享链接，不能用于去水印解析。
const DOUBAO_SHARE_URL_RE = /^https?:\/\/(?:www\.)?doubao\.com\/(?:thread|share)\/[A-Za-z0-9._~-]+/i;

export function isValidDoubaoShareUrl(url: string) {
  return DOUBAO_SHARE_URL_RE.test(url);
}

export async function verifyDoubaoShareVideoResource(shareUrl: string) {
  if (!isValidDoubaoShareUrl(shareUrl)) {
    throw new Error(`复制出的地址不是豆包分享链接：${shareUrl}`);
  }

  let response: Response;
  try {
    response = await fetch(shareUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(SHARE_PAGE_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`复制出的豆包分享页无法访问：${errorMessage(error)}`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`复制出的豆包分享页无法访问：HTTP ${response.status}`);
  }

  const html = await response.text();
  // 豆包 thread 分享页是客户端渲染（SPA），视频数据不会出现在初始 HTML 里，
  // 因此这里只做“页面确实能打开”的轻量检查；分享链接是否真的包含视频，
  // 由后续去水印接口解析该 thread 链接时的结果来最终确认。
  if (html.trim().length < 2000) {
    throw new Error("复制出的豆包分享页没有正常加载内容");
  }
}

export async function resolveCleanVideoUrl(
  settings: AppSettings,
  shareUrl: string,
  onRetry?: WatermarkRetryCallback,
  options: WatermarkResolveOptions = {}
) {
  if (!settings.watermarkApiToken.trim()) {
    throw new Error("未配置去水印 Token，无法返回可用视频");
  }

  let lastError: unknown;
  const startedAt = Date.now();
  const retryDelays = getWatermarkRetryDelays(options.maxAttempts);
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    const delayMs = retryDelays[attempt];
    if (delayMs) await wait(delayMs);

    try {
      return await resolveCleanVideoUrlOnce(settings, shareUrl);
    } catch (error) {
      lastError = error;
      if (!isRetryableWatermarkError(error) || attempt === retryDelays.length - 1) {
        throw error;
      }
      await onRetry?.({
        failedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: retryDelays.length,
        delayMs: retryDelays[attempt + 1],
        error: errorMessage(error),
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  throw lastError;
}

async function resolveCleanVideoUrlOnce(settings: AppSettings, shareUrl: string) {
  const apiUrl = `${settings.watermarkApiUrl}?url=${encodeURIComponent(shareUrl)}`;
  const upstream = await fetch(apiUrl, {
    headers: { Authorization: settings.watermarkApiToken },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`去水印接口失败：HTTP ${upstream.status} ${text.slice(0, 160)}`);
  }

  const payload = parseJson(text);
  const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (UNSUPPORTED_RE.test(payloadText)) {
    throw new Error("去水印接口返回：平台暂不支持");
  }

  if (payload && typeof payload === "object" && "code" in payload) {
    const code = Number((payload as Record<string, unknown>).code);
    if (Number.isFinite(code) && code !== 0 && code !== 200) {
      const message = String((payload as Record<string, unknown>).message || "解析失败");
      throw new Error(`去水印接口失败：${message}`);
    }
  }

  const cleanVideoUrl = extractVideoUrlFromPayload(payload);
  if (!cleanVideoUrl) {
    throw new Error("去水印接口没有返回 MP4 视频地址");
  }

  await verifyPlayableVideoUrl(cleanVideoUrl);
  return cleanVideoUrl;
}

export function isRetryableWatermarkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (UNSUPPORTED_RE.test(message)) return false;
  return /未找到资源|资源未就绪|处理中|稍后重试|解析失败|获取失败|没有返回 MP4|HTTP (?:404|408|409|425|429|5\d\d)|无法访问|不是可播放视频|fetch failed|network|timeout|aborted/i.test(message);
}

export function extractVideoUrlFromPayload(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of VIDEO_URL_KEYS) {
    const item = record[key];
    if (typeof item === "string" && isMp4VideoUrl(item)) {
      return item;
    }
  }

  for (const item of Object.values(record)) {
    const result = extractVideoUrlFromPayload(item);
    if (result) return result;
  }
  return null;
}

export function isMp4VideoUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    const decoded = decodeURIComponent(`${url.pathname}?${url.searchParams.toString()}`).toLowerCase();
    return decoded.includes(".mp4")
      || decoded.includes("video_mp4")
      || decoded.includes("video/mp4")
      || decoded.includes("format=mp4");
  } catch {
    return false;
  }
}

export async function verifyPlayableVideoUrl(url: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`去水印视频地址无法访问：${errorMessage(error)}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const videoContent = contentType.startsWith("video/") || contentType.includes("application/octet-stream");
  await response.body?.cancel().catch(() => undefined);

  if (!response.ok || !videoContent) {
    throw new Error(`去水印结果不是可播放视频：HTTP ${response.status}，Content-Type ${contentType || "unknown"}`);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
