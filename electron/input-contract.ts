/**
 * 对外生成接口（POST /api/generate）的入参契约。
 *
 * 纯函数模块：不依赖 Electron 运行时，便于单测。
 *
 * 目的：multipart 与 JSON 两种内容类型都会把字段变成字符串，历史代码直接
 * `as GenerateRequestBody` 断言后就使用，脏值会一路流到数据库和执行器。
 * 这里统一做白名单校验与归一化，非法入参在进入队列之前就被 400 拦下。
 */

import type { DoubaoModel } from "./types.js";

export const VALID_MODELS: readonly DoubaoModel[] = ["seedance_2_0_mini", "seedance_2_0_fast"];
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_SOURCE_LENGTH = 64;
export const FALLBACK_MODEL: DoubaoModel = "seedance_2_0_mini";

export interface NormalizedGenerateInput {
  model: DoubaoModel;
  prompt: string;
  referenceImagePaths: string[];
  callbackUrl: string | null;
  source: string;
}

export type GenerateInputResult =
  | { ok: true; value: NormalizedGenerateInput }
  | { ok: false; error: string };

export interface GenerateInputDefaults {
  defaultModel: DoubaoModel;
  maxReferenceImages: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 回调地址必须是不带凭据的 http(s)，避免把回调打到意外协议或泄露账号口令。 */
function normalizeCallbackUrl(raw: unknown): { value: string | null } | { error: string } {
  const text = asString(raw).trim();
  if (!text) return { value: null };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "callbackUrl must be an absolute http(s) url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "callbackUrl must be an absolute http(s) url" };
  }
  if (parsed.username || parsed.password) {
    return { error: "callbackUrl must not contain credentials" };
  }
  return { value: parsed.toString() };
}

/** 参考图路径可以是数组，也可以是 JSON 数组字符串或逗号分隔字符串。 */
function normalizeReferenceImagePaths(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return [];

  let list: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      list = trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(list)) return null;
  if (list.some((item) => typeof item !== "string")) return null;
  return (list as string[]).map((item) => item.trim()).filter(Boolean);
}

export function normalizeGenerateInput(
  raw: unknown,
  defaults: GenerateInputDefaults
): GenerateInputResult {
  if (!isPlainObject(raw)) return { ok: false, error: "request body must be an object" };

  const prompt = asString(raw.prompt).trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `prompt is too long (max ${MAX_PROMPT_LENGTH} characters)` };
  }

  const rawModel = asString(raw.model).trim();
  const requestedModel = rawModel || defaults.defaultModel;
  const model = VALID_MODELS.includes(requestedModel as DoubaoModel)
    ? (requestedModel as DoubaoModel)
    : VALID_MODELS.includes(defaults.defaultModel)
      ? defaults.defaultModel
      : FALLBACK_MODEL;
  // 显式传入的非法模型必须报错：静默回落会让调用方以为用了想要的模型。
  if (rawModel && !VALID_MODELS.includes(rawModel as DoubaoModel)) {
    return { ok: false, error: "unsupported model" };
  }

  const callback = normalizeCallbackUrl(raw.callbackUrl);
  if ("error" in callback) return { ok: false, error: callback.error };

  const referenceImagePaths = normalizeReferenceImagePaths(raw.referenceImagePaths);
  if (referenceImagePaths === null) {
    return { ok: false, error: "referenceImagePaths must be an array or comma separated string" };
  }
  if (referenceImagePaths.length > defaults.maxReferenceImages) {
    return { ok: false, error: `参考图数量超出限制，最多 ${defaults.maxReferenceImages} 张` };
  }

  return {
    ok: true,
    value: {
      model,
      prompt,
      referenceImagePaths,
      callbackUrl: callback.value,
      source: asString(raw.source).trim().slice(0, MAX_SOURCE_LENGTH)
    }
  };
}
