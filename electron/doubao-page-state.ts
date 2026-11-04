import { appSiteHostRegExpSource, isAppSiteHostname } from "./app-site.js";

export function normalizeComparableText(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

// 豆包（doubao.com）与 Dola（dola.com）共用同一套前端，分享/会话地址只是域名不同，
// 因此 URL 判定一律走这两个域名，不要把具体实现绑定到其中某一个站点上。
const APP_SITE_HOST = appSiteHostRegExpSource();
const DOUBAO_SHARE_URL_RE = new RegExp(`https?://${APP_SITE_HOST}/(?:thread|share)/[A-Za-z0-9._~-]+(?:[/?#][^\\s"'<>]*)?`, "i");
const DOUBAO_CONVERSATION_URL_RE = new RegExp(`https?://${APP_SITE_HOST}/chat/[A-Za-z0-9._~-]+(?:[/?#][^\\s"'<>]*)?`, "i");

export function extractDoubaoShareUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_SHARE_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

export function extractDoubaoConversationUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_CONVERSATION_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

const DOUBAO_LOCAL_DRAFT_CONVERSATION_URL_RE = /\/chat\/local_/i;

/**
 * 判断是否为豆包浏览器端本地草稿会话地址（/chat/local_...）。
 * 该前缀地址只是客户端本地草稿，尚未在服务端创建正式会话；
 * 提示词真正发送成功后，豆包会把 URL 切换为服务端正式会话地址。
 */
export function isLocalDraftDoubaoConversationUrl(url: string | null | undefined) {
  return Boolean(url && DOUBAO_LOCAL_DRAFT_CONVERSATION_URL_RE.test(url));
}

export function promptSignature(prompt: string) {
  const normalized = normalizeComparableText(prompt);
  return normalized.slice(0, Math.min(42, Math.max(12, normalized.length)));
}

export function containsPromptSignature(value: string, prompt: string) {
  const signature = promptSignature(prompt);
  return signature.length > 0 && normalizeComparableText(value).includes(signature);
}

/**
 * 判断某个历史会话里的视频能否归属为“本次任务的结果”。
 *
 * 历史恢复遍历的是账号“最近对话”列表，里面混着**以前任务的会话**，那些会话里
 * 也可能有已经生成好的视频。“只要会话里有视频就复制链接”会把上一个任务的旧视频
 * 当成本次结果提交去水印（真机事故：本次任务因未二次确认而根本没生成，
 * 却把第二个对话的视频交付了出去）。
 *
 * 归属规则（宁可判失败退额度，也不能交付别人的视频）：
 * - 记录会话（本次提交后记录的会话地址）天然属于本次任务；
 * - 其余会话必须命中本次提示词，否则一律跳过。
 */
export function isConversationResultForCurrentTask(input: {
  isRecordedConversation: boolean;
  promptMatched: boolean;
}) {
  return input.isRecordedConversation || input.promptMatched;
}

/** 豆包真正开始生成视频时会在回话里带上这句额度提示，是「已开工」的强证据。 */
export const DOUBAO_GENERATION_STARTED_TEXT = "本次生成将消耗每日免费额度";

/** 需要二次确认时回复的词：像普通对话一样发出去，豆包收到后才开始生成。 */
export const DOUBAO_GENERATION_CONFIRM_REPLY = "生成视频";

/** 提交后给豆包留出把回话输出完的时间（约 10~15 秒），期间不急着补确认。 */
export const DOUBAO_GENERATION_CONFIRM_GRACE_MS = 12000;

/**
 * `waitForGenerationResult` 主循环每轮的间隔。
 * 完成检测、失败检测、拦截检测、分享链接复制都按这个节奏跑，别为了拉开
 * 二次确认的间隔而放慢它——那样会把分享链接重试次数一起砍掉。
 */
export const GENERATION_POLL_INTERVAL_MS = 5000;

/** 两次「生成视频」补发之间的最小间隔：给豆包时间消化上一条回复，避免连续追问。 */
export const DOUBAO_GENERATION_CONFIRM_RETRY_MS = 30000;

/** 「均进行二次确认」的重试上限：避免失败态里无限刷屏。 */
export const DOUBAO_GENERATION_CONFIRM_MAX_REPLIES = 5;

/**
 * 豆包回话里有没有「已开始生成」的额度文案。
 * 注意：本函数引用模块级常量，只在 Node 侧调用，**不要** toString() 注入页面。
 */
export function isDoubaoGenerationStarted(pageText: string) {
  // 文案可能被 DOM 拆成多行/多节点，去掉全部空白再比。
  return pageText.replace(/\s+/g, "").includes(DOUBAO_GENERATION_STARTED_TEXT);
}

/**
 * 是否要补发一次「生成视频」二次确认。
 *
 * 判定标准（2026-11-04 改）：不再去猜「视频生成参数确认」面板的文案，
 * 只要豆包回话里**没有**「本次生成将消耗每日免费额度」，就说明生成还没开始，
 * 每轮轮询都补一次确认，最多 5 次。
 *
 * 四道闸门：
 * - 提交后先等豆包回话稳定（宽限期），否则「没有文案」在头几秒恒成立会抢发；
 * - 距上一条补发不足 30s 就不再发（主循环仍每 5s 判一次，只是被这道闸门挡住）；
 * - 已出现失败文案 / 视频已生成，不再往对话里发东西；
 * - 回复次数封顶，避免失败态里连发。
 */
export function shouldSendGenerationConfirmation(input: {
  pageText: string;
  elapsedMs: number;
  replyCount: number;
  /** null 表示还没有发过，首次补发不受间隔限制。 */
  msSinceLastReply: number | null;
  hasFailure: boolean;
  generated: boolean;
}) {
  if (input.elapsedMs < DOUBAO_GENERATION_CONFIRM_GRACE_MS) return false;
  if (input.replyCount >= DOUBAO_GENERATION_CONFIRM_MAX_REPLIES) return false;
  if (input.msSinceLastReply !== null
    && input.msSinceLastReply < DOUBAO_GENERATION_CONFIRM_RETRY_MS) return false;
  if (input.hasFailure || input.generated) return false;
  return !isDoubaoGenerationStarted(input.pageText);
}

export function isDoubaoPromptRewritePage(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  return /完整\s*\d+(?:\.\d+)?\s*秒视频生成指令|可直接用于(?:AI\s*)?视频生成工具|要不要我再精简一版提示词/.test(text);
}

export function isDoubaoDesktopDownloadPrompt(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  const oldVariant = text.includes("下载电脑版")
    && text.includes("使用完整功能")
    && text.includes("下次提醒我");
  const subscriptionVariant = (text.includes("下载电脑版") || text.includes("下载豆包电脑版"))
    && text.includes("免费领取 30 天订阅");
  const quotaVariant = text.includes("天天领额度")
    && text.includes("下载电脑版");
  return oldVariant || subscriptionVariant || quotaVariant;
}

export function isDoubaoGenerationComplete(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  return /你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])|生成视频(?:已经|已)?完成/.test(text);
}

const GENERATION_COMPLETE_PATTERNS = [
  /你的视频(?:已经|已)?生成好[了啦]/g,
  /视频(?:已经|已)?生成(?:完成|成功|好[了啦])/g,
  /生成视频(?:已经|已)?完成/g
];

export function hasNewGenerationCompletion(currentText: string, baselineText: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const countMatches = (value: string, pattern: RegExp) => value.match(new RegExp(pattern.source, "g"))?.length || 0;
  const current = normalize(currentText);
  const baseline = normalize(baselineText);
  return GENERATION_COMPLETE_PATTERNS.some((pattern) => countMatches(current, pattern) > countMatches(baseline, pattern));
}

export function getNewDoubaoVideoUrls(currentUrls: string[], baselineUrls: string[]) {
  const baseline = new Set(baselineUrls);
  return Array.from(new Set(currentUrls.filter((url) => {
    if (!/^https?:\/\//i.test(url) || baseline.has(url)) return false;
    try {
      // 站点自身的地址（会话页、分享页）不算视频源，其余 CDN 才算。
      return !isAppSiteHostname(new URL(url).hostname);
    } catch {
      return false;
    }
  })));
}

export interface GenerationReadyInput {
  completionTextPresent: boolean;
  hasNewVideoSource: boolean;
  newVideoCount: number;
  newPlayableVideoCount?: number;
  newVideoCardCount?: number;
  completionTextSeenAt: number;
  now: number;
  graceMs?: number;
}

/**
 * 完成文案出现后等待视频卡片渲染的宽限期。
 *
 * 正常情况下豆包在文案出现后几秒内就会渲染出新视频卡片；隐藏执行窗口里
 * 偶发不渲染卡片 DOM（SPA 懒加载未触发），此时继续等待没有意义，
 * 超过宽限期后放行，避免任务一直空等到整体超时。
 */
export const DEFAULT_SHARE_GRACE_MS = 120000;

/**
 * Decides whether a finished Doubao video is safe to share. Doubao renders the
 * "视频生成好了" text before the finished video card appears; copying the share
 * link in that window yields a thread URL without the video. A completion
 * message alone is normally not sufficient: the current task must have a new
 * card. When the card never renders (possible in a hidden execution window),
 * the grace period is the escape hatch that keeps the task from hanging.
 */
export function isGenerationReadyForShare(input: GenerationReadyInput) {
  if (!input.completionTextPresent) return false;
  const videoReady = input.hasNewVideoSource
    || input.newVideoCount > 0
    || (input.newPlayableVideoCount || 0) > 0
    || (input.newVideoCardCount || 0) > 0;
  if (videoReady) return true;
  const graceMs = input.graceMs ?? DEFAULT_SHARE_GRACE_MS;
  if (!input.completionTextSeenAt) return false;
  return input.now - input.completionTextSeenAt >= graceMs;
}

export function extractDoubaoFailureMessage(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const failurePatterns = [
    /生成内容中疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /(?:侵权|违规)内容[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /无法返回该内容[^。！？]*(?:[。！？]|$)/,
    /换个主题再试试[^。！？]*(?:[。！？]|$)/,
    /生成额度未扣除[^。！？]*(?:[。！？]|$)/,
    /额度未扣除[^。！？]*(?:[。！？]|$)/,
    /今日(?:的)?(?:视频)?(?:生成)?(?:免费)?(?:生成)?次数(?:已|已经)?用完[^。！？]*(?:[。！？]|$)/,
    /免费(?:生成)?次数(?:已|已经)?用完[^。！？]*(?:[。！？]|$)/,
    /视频生成失败[^。！？]*(?:[。！？]|$)/,
    /生成视频失败[^。！？]*(?:[。！？]|$)/,
    /未能生成视频[^。！？]*(?:[。！？]|$)/
  ];

  for (const pattern of failurePatterns) {
    const matched = text.match(pattern)?.[0]?.trim();
    if (matched) return matched;
  }

  return null;
}

export function countTextOccurrences(text: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

export function hasNewTextOccurrence(currentText: string, baselineText: string, needle: string) {
  const count = (text: string) => {
    if (!needle) return 0;
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(needle, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += needle.length;
    }
  };
  return count(currentText) > count(baselineText);
}

/**
 * 判定“提示词已从输入框移出并进入聊天区”：
 * 输入框（composer）里不再包含提示词签名，但整页文本里仍包含该签名，
 * 说明提示词被真正发送并回显在聊天消息中；若输入框清空后页面里也找不到提示词，
 * 说明内容被丢弃（例如编辑器内部状态没有注册 DOM 文本），属于发送失败。
 */
export function isPromptMovedOutOfComposer(input: {
  pageText: string;
  composerText: string;
  prompt: string;
}) {
  const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const normalizedPrompt = normalize(input.prompt);
  const signature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
  if (!signature) return false;
  const normalizedComposerText = normalize(input.composerText);
  const composerCleared = normalizedComposerText.length === 0 || !normalizedComposerText.includes(signature);
  const promptStillInPage = normalize(input.pageText).includes(signature);
  return composerCleared && promptStillInPage;
}

export function hasNewPromptOccurrence(currentText: string, baselineText: string, prompt: string) {
  const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const normalizedPrompt = normalize(prompt);
  const signature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
  if (!signature) return false;

  const count = (text: string) => {
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(signature, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += signature.length;
    }
  };

  return count(normalize(currentText)) > count(normalize(baselineText));
}

export function isQuotaNotChargedFailure(message: string) {
  return /额度未扣除|生成额度未扣除|未消耗|未扣费|不会扣除/.test(message);
}
