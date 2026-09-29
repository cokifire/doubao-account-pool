/**
 * 应用设置的唯一权威定义与归一化。
 *
 * 纯函数模块：不依赖 Electron 运行时，便于单测。
 *
 * 读写两侧共用这一份：SQLite 里被手工改脏、或旧版本残留的非法值，在读出时
 * 就会被夹回合法范围，不会一路流到执行器和额度计算里。
 */

import type { AppSettings, DoubaoModel } from "./types.js";

export const DEFAULT_SETTINGS: AppSettings = {
  apiServiceEnabled: true,
  apiPort: 17888,
  apiKey: "local-doubao-key",
  executorEnabled: true,
  showExecutorWindow: false,
  autoCloseExecutorWindow: true,
  doubaoChatUrl: "https://www.doubao.com/chat",
  dolaChatUrl: "https://dola.com/chat",
  defaultModel: "seedance_2_0_mini",
  dailyQuotaLimit: 10,
  miniCost: 2,
  fastCost: 3,
  dailyResetTime: "00:00",
  generationTimeoutSeconds: 900,
  maxConcurrentAccounts: 4,
  retryCount: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
};

export const VALID_MODELS: readonly DoubaoModel[] = ["seedance_2_0_mini", "seedance_2_0_fast"];

export const GENERATION_TIMEOUT_RANGE = { min: 60, max: 3600 } as const;
export const MAX_CONCURRENT_ACCOUNTS_RANGE = { min: 1, max: 20 } as const;
export const RETRY_COUNT_RANGE = { min: 0, max: 10 } as const;
export const QUOTA_RANGE = { min: 0, max: 1000 } as const;
export const COST_RANGE = { min: 1, max: 1000 } as const;

const DAILY_RESET_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** 缺省（undefined/null）不等于 false，必须回退到默认值，否则会把默认开启的开关关掉。 */
function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function asText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

/** 端口越界没有“夹到边界”的意义，直接回退到默认端口。 */
function asPort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const port = Math.floor(parsed);
  return port >= 1 && port <= 65535 ? port : fallback;
}

export function normalizeSettings(raw: Record<string, unknown>): AppSettings {
  return {
    apiServiceEnabled: asBoolean(raw.apiServiceEnabled, DEFAULT_SETTINGS.apiServiceEnabled),
    apiPort: asPort(raw.apiPort, DEFAULT_SETTINGS.apiPort),
    apiKey: asText(raw.apiKey, DEFAULT_SETTINGS.apiKey),
    executorEnabled: asBoolean(raw.executorEnabled, DEFAULT_SETTINGS.executorEnabled),
    showExecutorWindow: asBoolean(raw.showExecutorWindow, DEFAULT_SETTINGS.showExecutorWindow),
    autoCloseExecutorWindow: asBoolean(raw.autoCloseExecutorWindow, DEFAULT_SETTINGS.autoCloseExecutorWindow),
    doubaoChatUrl: asText(raw.doubaoChatUrl, DEFAULT_SETTINGS.doubaoChatUrl),
    dolaChatUrl: asText(raw.dolaChatUrl, DEFAULT_SETTINGS.dolaChatUrl),
    defaultModel: VALID_MODELS.includes(raw.defaultModel as DoubaoModel)
      ? (raw.defaultModel as DoubaoModel)
      : DEFAULT_SETTINGS.defaultModel,
    dailyQuotaLimit: clampNumber(raw.dailyQuotaLimit, QUOTA_RANGE.min, QUOTA_RANGE.max, DEFAULT_SETTINGS.dailyQuotaLimit),
    miniCost: clampNumber(raw.miniCost, COST_RANGE.min, COST_RANGE.max, DEFAULT_SETTINGS.miniCost),
    fastCost: clampNumber(raw.fastCost, COST_RANGE.min, COST_RANGE.max, DEFAULT_SETTINGS.fastCost),
    dailyResetTime: DAILY_RESET_TIME_RE.test(String(raw.dailyResetTime ?? ""))
      ? String(raw.dailyResetTime)
      : DEFAULT_SETTINGS.dailyResetTime,
    generationTimeoutSeconds: clampNumber(
      raw.generationTimeoutSeconds,
      GENERATION_TIMEOUT_RANGE.min,
      GENERATION_TIMEOUT_RANGE.max,
      DEFAULT_SETTINGS.generationTimeoutSeconds
    ),
    maxConcurrentAccounts: clampNumber(
      raw.maxConcurrentAccounts,
      MAX_CONCURRENT_ACCOUNTS_RANGE.min,
      MAX_CONCURRENT_ACCOUNTS_RANGE.max,
      DEFAULT_SETTINGS.maxConcurrentAccounts
    ),
    retryCount: clampNumber(raw.retryCount, RETRY_COUNT_RANGE.min, RETRY_COUNT_RANGE.max, DEFAULT_SETTINGS.retryCount),
    autoRemoveWatermark: asBoolean(raw.autoRemoveWatermark, DEFAULT_SETTINGS.autoRemoveWatermark),
    watermarkApiUrl: asText(raw.watermarkApiUrl, DEFAULT_SETTINGS.watermarkApiUrl),
    watermarkApiToken: typeof raw.watermarkApiToken === "string" ? raw.watermarkApiToken : DEFAULT_SETTINGS.watermarkApiToken,
    outputDir: typeof raw.outputDir === "string" ? raw.outputDir : DEFAULT_SETTINGS.outputDir
  };
}
