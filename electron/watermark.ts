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
const RETRY_DELAYS_MS = [0, 3000, 8000, 15000];

export async function resolveCleanVideoUrl(settings: AppSettings, shareUrl: string) {
  if (!settings.watermarkApiToken.trim()) {
    throw new Error("未配置去水印 Token，无法返回可用视频");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = RETRY_DELAYS_MS[attempt];
    if (delayMs) await wait(delayMs);

    try {
      return await resolveCleanVideoUrlOnce(settings, shareUrl);
    } catch (error) {
      lastError = error;
      if (!isRetryableWatermarkError(error) || attempt === RETRY_DELAYS_MS.length - 1) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function resolveCleanVideoUrlOnce(settings: AppSettings, shareUrl: string) {
  const apiUrl = `${settings.watermarkApiUrl}?url=${encodeURIComponent(shareUrl)}`;
  const upstream = await fetch(apiUrl, {
    headers: { Authorization: settings.watermarkApiToken }
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

function isRetryableWatermarkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (UNSUPPORTED_RE.test(message)) return false;
  return /未找到资源|获取失败|没有返回 MP4|HTTP (?:404|408|409|425|429|5\d\d)|无法访问|不是可播放视频|fetch failed|network|timeout/i.test(message);
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
      redirect: "follow"
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
