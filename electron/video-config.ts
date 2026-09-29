/**
 * 视频生成参数（时长 / 比例）的取值定义与归一化。
 *
 * 纯函数模块：不依赖 Electron 与 DOM，便于单测。
 * 取值白名单与 doubao-studio 的 `packages/contracts/src/enums.ts` 保持一致，
 * 这样两边对同一份豆包页面说的是同一种语言。
 */

export type VideoDuration =
  | "4s" | "5s" | "6s" | "7s" | "8s" | "9s" | "10s" | "11s" | "12s" | "13s" | "14s" | "15s";

export type VideoAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9";

export const VIDEO_DURATIONS: readonly VideoDuration[] = [
  "4s", "5s", "6s", "7s", "8s", "9s", "10s", "11s", "12s", "13s", "14s", "15s"
];

export const VIDEO_ASPECT_RATIOS: readonly VideoAspectRatio[] = ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"];

/**
 * 豆包时长滑杆的量纲：`aria-valuemin=0` ↔ 4s、`aria-valuemax=11` ↔ 15s。
 * 这不是猜测值，是 doubao-studio 在真实页面上验证过的映射，改动会导致时长整体偏移。
 */
export const DURATION_SLIDER = { minSeconds: 4, maxSeconds: 15, minValue: 0, maxValue: 11 } as const;

/** 创作栏把比例与时长合并回显成一个控件文本，如 `16:9 · 10s`。 */
const COMPOSITE_LABEL_RE = /^(自动|[0-9]+:[0-9]+)\s*·\s*([0-9]+)s$/;

export interface VideoParameterRequest {
  duration: VideoDuration | null;
  aspectRatio: VideoAspectRatio | null;
}

export function durationToSeconds(duration: VideoDuration): number {
  return Number.parseInt(duration.replace(/s$/i, ""), 10);
}

function secondsToDuration(seconds: number): VideoDuration | null {
  const value = `${seconds}s`;
  return (VIDEO_DURATIONS as readonly string[]).includes(value) ? (value as VideoDuration) : null;
}

/** 滑杆位置值：0 ↔ 4s，11 ↔ 15s。 */
export function durationToSliderValue(duration: VideoDuration): number {
  return durationToSeconds(duration) - DURATION_SLIDER.minSeconds;
}

export function sliderValueToDuration(value: number): VideoDuration | null {
  return secondsToDuration(value + DURATION_SLIDER.minSeconds);
}

/** 入参可能来自 JSON（数字）或 multipart（字符串），统一收敛到白名单里的字面量。 */
export function normalizeVideoDuration(raw: unknown): VideoDuration | null {
  if (typeof raw === "number") return secondsToDuration(raw);
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const withUnit = /^\d+$/.test(text) ? `${text}s` : text;
  return (VIDEO_DURATIONS as readonly string[]).includes(withUnit) ? (withUnit as VideoDuration) : null;
}

export function normalizeVideoAspectRatio(raw: unknown): VideoAspectRatio | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return (VIDEO_ASPECT_RATIOS as readonly string[]).includes(text) ? (text as VideoAspectRatio) : null;
}

export function getVideoCompositeLabel(aspectRatio: VideoAspectRatio, duration: VideoDuration): string {
  return `${aspectRatio} · ${duration}`;
}

/** 判断文本是否就是创作栏那个「比例 · 时长」组合控件的回显。 */
export function isVideoCompositeControlText(text: string | null | undefined): boolean {
  return COMPOSITE_LABEL_RE.test(String(text ?? "").replace(/\s+/g, " ").trim());
}

export interface ParsedCompositeLabel {
  aspectRatio: string;
  duration: VideoDuration | null;
}

/** 解析组合控件回显；页面用「自动」表示未选比例，因此比例部分不做白名单收窄。 */
export function parseCompositeLabel(text: string | null | undefined): ParsedCompositeLabel | null {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  const match = normalized.match(COMPOSITE_LABEL_RE);
  if (!match) return null;
  return { aspectRatio: match[1], duration: secondsToDuration(Number.parseInt(match[2], 10)) };
}
