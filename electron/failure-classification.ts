/**
 * 豆包页面失败的结构化分类与 fail-closed 决策。
 *
 * 纯函数模块：不依赖 Electron、DOM 或数据库，便于单测。
 *
 * 两个决策必须分开看：
 * - `shouldStopPolling`：继续等待不会有结果 → 立即终止轮询，不再空等
 *   `generationTimeoutSeconds`（默认可能十几分钟）。
 * - `shouldRefundQuota`：平台没有真正生成 / 明确未扣费 → 退还本地预扣额度。
 *
 * 注意「平台免费次数用完」属于已无产能，不退款（否则会立刻复用死号），
 * 但必须立即终止，不能继续空等。
 */

export type DoubaoFailureCode =
  | "membership_required"
  | "quota_exhausted"
  | "content_rejected"
  | "face_restricted"
  | "generation_failed"
  | "login_required"
  | "submission_failed"
  | "unknown";

const LOGIN_REQUIRED_PATTERNS = [
  /扫码登录/,
  /请(?:先)?登录/,
  /登录(?:已)?(?:失效|过期)/,
  /登录状态已(?:失效|过期)/
];

const MEMBERSHIP_PATTERNS = [
  /升级会员/,
  /开通会员/,
  /会员专享/,
  /权益不足/,
  /购买会员/,
  /订阅后可/
];

const QUOTA_EXHAUSTED_PATTERNS = [
  /今日[^。]{0,12}次数[^。]{0,6}用完/,
  /免费次数[^。]{0,6}用完/,
  /额度[^。]{0,6}用完/,
  /(?:视频)?生成次数不够/
];

const FACE_RESTRICTED_PATTERNS = [
  /真人脸/,
  /人脸[^。]{0,8}限制/,
  /涉及人物肖像/
];

const CONTENT_REJECTED_PATTERNS = [
  /疑似包含[^。]{0,20}(?:侵权|违规)/,
  /(?:侵权|违规)内容/,
  /无法返回该内容/,
  /换个主题再试试/,
  /内容安全/,
  /审核不通过/
];

const GENERATION_FAILED_PATTERNS = [
  /视频生成失败/,
  /生成视频失败/,
  /未能生成视频/,
  /生成失败/
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * 从豆包页面返回的失败文案判定失败码。
 * 无法识别时返回 `unknown`，调用方不得据此做任何 fail-closed 假设。
 */
export function classifyDoubaoFailure(message: string | null | undefined): DoubaoFailureCode {
  const text = (message || "").replace(/\s+/g, " ").trim();
  if (!text) return "unknown";

  if (matchesAny(text, LOGIN_REQUIRED_PATTERNS)) return "login_required";
  if (matchesAny(text, MEMBERSHIP_PATTERNS)) return "membership_required";
  if (matchesAny(text, QUOTA_EXHAUSTED_PATTERNS)) return "quota_exhausted";
  if (matchesAny(text, FACE_RESTRICTED_PATTERNS)) return "face_restricted";
  if (matchesAny(text, CONTENT_REJECTED_PATTERNS)) return "content_rejected";
  if (matchesAny(text, GENERATION_FAILED_PATTERNS)) return "generation_failed";
  return "unknown";
}

/** 继续等待不会有结果、必须立即终止轮询的失败码。 */
const STOP_POLLING_CODES: ReadonlySet<DoubaoFailureCode> = new Set<DoubaoFailureCode>([
  "membership_required",
  "quota_exhausted",
  "content_rejected",
  "face_restricted",
  "generation_failed",
  "login_required",
  "submission_failed"
]);

/** 平台没有真正生成、应当退还本地预扣额度的失败码。 */
const REFUND_CODES: ReadonlySet<DoubaoFailureCode> = new Set<DoubaoFailureCode>([
  "membership_required",
  "content_rejected",
  "face_restricted",
  "login_required",
  "submission_failed"
]);

export function shouldStopPolling(code: DoubaoFailureCode): boolean {
  return STOP_POLLING_CODES.has(code);
}

export function shouldRefundQuota(code: DoubaoFailureCode): boolean {
  return REFUND_CODES.has(code);
}
