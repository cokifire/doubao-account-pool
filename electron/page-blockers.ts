/**
 * 豆包页面「会员 / 权益 / 登录」拦截检测。
 *
 * 纯函数模块：只接收调用方采集好的文本与 iframe 描述符，不碰 DOM。
 *
 * 命中即 fail-closed：这类拦截意味着继续等待也不会出视频，必须立刻停止并
 * 退还预扣额度，让调度器换号，而不是空等到 generationTimeoutSeconds 超时。
 */

import type { DoubaoFailureCode } from "./failure-classification.js";

export interface BlockerScanInput {
  /** 页面可见文本（document.body.innerText）。 */
  pageText: string;
  /** [role=dialog] / [role=alert] / modal / toast / popover 等浮层的可见文本。 */
  overlayTexts?: string[];
  /**
   * iframe 的 title / name / aria-label / src 拼接。
   * 会员面板常被放进跨源 iframe，父文档读不到 innerText，只能看这些描述符。
   */
  frameDescriptors?: string[];
}

export interface BlockerScanResult {
  blocked: boolean;
  /** 仅可能为 membership_required / login_required / unknown。 */
  code: DoubaoFailureCode;
  /** 脱敏的命中来源，用于日志排障；不落库页面原文。 */
  evidence: string | null;
}

const MEMBERSHIP_TEXT_PATTERNS = [
  /升级会员/,
  /开通会员/,
  /会员专享/,
  /权益不足/,
  /购买会员/,
  /订阅后可/
];

const LOGIN_TEXT_PATTERNS = [
  /扫码登录/,
  /手机号登录/,
  /验证码登录/,
  /登录后可用/,
  /请(?:先)?登录/
];

// 跨源 iframe 只能靠描述符判断，因此措辞要宽一点；但必须可见才会被采集。
const MEMBERSHIP_FRAME_PATTERN = /会员|订阅|subscribe|membership|upgrade|权益/i;

function normalize(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function detectPageBlocker(input: BlockerScanInput): BlockerScanResult {
  const texts = [normalize(input.pageText), ...(input.overlayTexts || []).map(normalize)].filter(Boolean);

  if (texts.some((text) => MEMBERSHIP_TEXT_PATTERNS.some((pattern) => pattern.test(text)))) {
    return { blocked: true, code: "membership_required", evidence: "membership_overlay" };
  }

  if (texts.some((text) => LOGIN_TEXT_PATTERNS.some((pattern) => pattern.test(text)))) {
    return { blocked: true, code: "login_required", evidence: "login_page" };
  }

  // 只有在没有明确文本命中时才回退到 iframe 描述符，避免普通页面里的
  // 「升级」字样被误判成会员拦截。
  const frames = (input.frameDescriptors || []).map(normalize).filter(Boolean);
  if (frames.some((descriptor) => MEMBERSHIP_FRAME_PATTERN.test(descriptor))) {
    return { blocked: true, code: "membership_required", evidence: "membership_iframe" };
  }

  return { blocked: false, code: "unknown", evidence: null };
}
