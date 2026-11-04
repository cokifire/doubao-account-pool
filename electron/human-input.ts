/**
 * 拟人化输入纯逻辑模块：打字节奏、贝塞尔鼠标轨迹、随机抖动延时。
 *
 * 与 fingerprint.ts / readiness.ts / page-blockers.ts 同一套设计约束：
 * - 纯函数、无 Electron 依赖，便于单测；
 * - 所有随机量由种子驱动（同一 seed 结果可复现），方便排查；
 * - 段数与轨迹点数都设上界，避免大提示词把执行拖得太慢。
 *
 * 用途：把执行器里“整段瞬间 insertText + 鼠标瞬移 + 固定 wait”替换成
 * “分段 insertText（带拟人停顿）+ 贝塞尔曲线移动 + 抖动延时”，
 * 让豆包前端的富文本编辑器与风控 JS 看到更像真实用户的输入节奏。
 */

/** 确定性伪随机数发生器（mulberry32）。同一 seed 产出同一序列。 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把若干字符串/数字稳定地合并成一个 32 位种子（FNV-1a 风格）。 */
export function seedFromParts(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

export interface Point {
  x: number;
  y: number;
}

/** 单段打字内容与“输入本段之后、下一段之前”的停顿毫秒数。 */
export interface TypingChunk {
  text: string;
  pauseMs: number;
}

export interface TypingOptions {
  /** 段数上界，防大提示词拖慢执行。默认 45。 */
  maxChunks?: number;
  /** 每段基础停顿（毫秒）。默认 90。 */
  basePauseMs?: number;
  /** 句末（。！？!?；;\n）额外停顿（毫秒）。默认 320。 */
  sentencePauseMs?: number;
  /** 抖动幅度比例（0~1）。默认 0.4。 */
  spread?: number;
}

/** 在句末标点或换行处切分，标点保留在所属片段末尾。 */
function splitSentences(prompt: string): string[] {
  return prompt.split(/(?<=[。！？!?；;\n])/).filter((part) => part.length > 0);
}

/** 把过长的句子按目标长度切成小段，优先在空格/逗号/顿号处断开。 */
function chunkSentence(sentence: string, targetSize: number, rng: Rng): string[] {
  if (sentence.length <= targetSize + 2) return [sentence];

  const chunks: string[] = [];
  let remaining = sentence;
  while (remaining.length > targetSize) {
    let cut = targetSize + Math.floor(rng() * 3);
    cut = Math.min(cut, remaining.length - 1);

    const slice = remaining.slice(0, cut + 1);
    const spaceAt = Math.max(
      slice.lastIndexOf(" "),
      slice.lastIndexOf("，"),
      slice.lastIndexOf(","),
      slice.lastIndexOf("、")
    );
    if (spaceAt > targetSize * 0.4) cut = spaceAt + 1;

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** 段数超上限时合并相邻最短段，保证段数不超 maxChunks。 */
function mergeChunks(chunks: string[], maxChunks: number): string[] {
  const out = chunks.slice();
  while (out.length > maxChunks) {
    let best = 0;
    let bestLen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const len = out[i].length + out[i + 1].length;
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    out.splice(best, 2, out[best] + out[best + 1]);
  }
  return out;
}

/**
 * 把整段提示词拆成带拟人停顿的分段输入计划。
 * 段与段之间返回的 pauseMs 由种子驱动，同一 (seed, prompt) 结果可复现。
 */
export function typingPlan(prompt: string, seed: number, options: TypingOptions = {}): TypingChunk[] {
  const rng = createRng(seed);
  const maxChunks = Math.max(4, options.maxChunks ?? 45);
  const basePauseMs = options.basePauseMs ?? 90;
  const sentencePauseMs = options.sentencePauseMs ?? 320;
  const spread = options.spread ?? 0.4;

  const text = prompt ?? "";
  if (!text.trim()) return [];

  const sentences = splitSentences(text);

  // 先按自然段数估算目标段长，段数超上限就放大段长，避免后续大量合并。
  let targetSize = 6;
  const roughChunks = sentences.reduce(
    (sum, sentence) => sum + Math.max(1, Math.ceil(sentence.length / targetSize)),
    0
  );
  if (roughChunks > maxChunks) {
    targetSize = Math.max(3, Math.ceil(text.length / maxChunks));
  }

  let chunks: string[] = [];
  for (const sentence of sentences) {
    chunks.push(...chunkSentence(sentence, targetSize, rng));
  }
  if (chunks.length > maxChunks) {
    chunks = mergeChunks(chunks, maxChunks);
  }

  const result: TypingChunk[] = chunks.map((chunk) => {
    const endsSentence = /[。！？!?；;\n]$/.test(chunk);
    const base = endsSentence ? basePauseMs + sentencePauseMs : basePauseMs;
    return { text: chunk, pauseMs: jitterDelay(base, rng, spread) };
  });

  // 最后一段之后无需停顿。
  if (result.length) result[result.length - 1].pauseMs = 0;
  return result;
}

export interface BezierOptions {
  /** 轨迹点数（含终点）。默认按距离在 minSteps~maxSteps 之间取。 */
  steps?: number;
  minSteps?: number;
  maxSteps?: number;
  /** 控制点相对直线的垂直抖动幅度（像素）。默认 24。 */
  wobblePx?: number;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/**
 * 生成从 from 到 to 的三次贝塞尔鼠标轨迹点列（含终点）。
 * 控制点带随机垂直抖动，让轨迹更像人手移动而非直线瞬移。
 */
export function bezierPath(from: Point, to: Point, seed: number, options: BezierOptions = {}): Point[] {
  const rng = createRng(seed);
  const minSteps = options.minSteps ?? 6;
  const maxSteps = options.maxSteps ?? 18;
  const wobblePx = options.wobblePx ?? 24;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  const steps = options.steps ?? Math.min(maxSteps, Math.max(minSteps, Math.round(distance / 40)));
  const actualSteps = Math.max(2, steps);

  // 两个控制点沿路径 30%~70% 分布，外加随机垂直抖动。
  const cp1 = {
    x: from.x + dx * (0.3 + rng() * 0.2),
    y: from.y + dy * (0.3 + rng() * 0.2) + (rng() - 0.5) * 2 * wobblePx
  };
  const cp2 = {
    x: from.x + dx * (0.6 + rng() * 0.2),
    y: from.y + dy * (0.6 + rng() * 0.2) + (rng() - 0.5) * 2 * wobblePx
  };

  const points: Point[] = [];
  for (let i = 0; i <= actualSteps; i++) {
    const t = i / actualSteps;
    points.push({
      x: Math.round(cubic(from.x, cp1.x, cp2.x, to.x, t)),
      y: Math.round(cubic(from.y, cp1.y, cp2.y, to.y, t))
    });
  }
  return points;
}

/**
 * 给固定延时长叠加一个小幅抖动，返回抖动后的毫秒数。
 * 传入同一个 rng 可产生连续变化的抖动序列（而非固定值）。
 */
export function jitterDelay(baseMs: number, rng: Rng, spread = 0.4): number {
  const factor = 1 + (rng() * 2 - 1) * spread;
  return Math.max(20, Math.round(baseMs * factor));
}
