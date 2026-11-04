import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsPromptSignature,
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractDoubaoShareUrl,
  getNewDoubaoVideoUrls,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoGenerationComplete,
  isDoubaoPromptRewritePage,
  isConversationResultForCurrentTask,
  DOUBAO_GENERATION_CONFIRM_GRACE_MS,
  DOUBAO_GENERATION_CONFIRM_MAX_REPLIES,
  DOUBAO_GENERATION_CONFIRM_REPLY,
  DOUBAO_GENERATION_CONFIRM_RETRY_MS,
  GENERATION_POLL_INTERVAL_MS,
  isDoubaoGenerationStarted,
  shouldSendGenerationConfirmation,
  isGenerationReadyForShare,
  isLocalDraftDoubaoConversationUrl,
  isPromptMovedOutOfComposer,
  isQuotaNotChargedFailure,
  promptSignature,
} from '../dist-electron/doubao-page-state.js'

test('rejects videos from conversations that do not belong to the current task', () => {
  // 记录会话（本次提交会话）天然归属本次任务，即使提示词没命中也可以取它的视频。
  assert.equal(
    isConversationResultForCurrentTask({ isRecordedConversation: true, promptMatched: false }),
    true
  )
  // 命中提示词的会话归属本次任务。
  assert.equal(
    isConversationResultForCurrentTask({ isRecordedConversation: false, promptMatched: true }),
    true
  )
  // 关键回归：既不归属记录会话、也没命中提示词的旧会话，即便里面有已生成的视频，
  // 也绝不能把它的分享链接当成本次结果（真机：交付了第二个对话的视频）。
  assert.equal(
    isConversationResultForCurrentTask({ isRecordedConversation: false, promptMatched: false }),
    false
  )
})

test('recognizes the quota notice meaning Doubao actually started generating', () => {
  assert.equal(
    isDoubaoGenerationStarted('本次使用 Seedance 2.0 Mini 生成，预计等待 20 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。'),
    true
  )
  // 文案可能被 DOM 拆行，空白不该影响判定。
  assert.equal(isDoubaoGenerationStarted('本次生成将消耗 每日免费额度。'), true)
  // 「视频生成参数确认」面板代表还在等待确认，不是已开始生成。
  assert.equal(isDoubaoGenerationStarted('视频生成参数确认 确认后我再开始生成视频。'), false)
  assert.equal(isDoubaoGenerationStarted(''), false)
})

test('waits for Doubao reply to settle before sending any confirmation', () => {
  const pendingPage = '视频生成参数确认 确认后我再开始生成视频。'
  const decide = (elapsedMs) => shouldSendGenerationConfirmation({
    pageText: pendingPage,
    elapsedMs,
    replyCount: 0,
    msSinceLastReply: null,
    hasFailure: false,
    generated: false
  })

  assert.equal(decide(0), false)
  assert.equal(decide(DOUBAO_GENERATION_CONFIRM_GRACE_MS - 1), false)
  assert.equal(decide(DOUBAO_GENERATION_CONFIRM_GRACE_MS), true)
})

test('confirms on every poll without the quota notice, capped at five replies', () => {
  const decide = (replyCount, pageText = '视频生成参数确认 确认后我再开始生成视频。') =>
    shouldSendGenerationConfirmation({
      pageText,
      elapsedMs: DOUBAO_GENERATION_CONFIRM_GRACE_MS,
      replyCount,
      msSinceLastReply: null,
      hasFailure: false,
      generated: false
    })

  assert.equal(decide(0), true)
  assert.equal(decide(DOUBAO_GENERATION_CONFIRM_MAX_REPLIES - 1), true)
  assert.equal(decide(DOUBAO_GENERATION_CONFIRM_MAX_REPLIES), false)
  // 豆包已经开始生成，就不再补确认。
  assert.equal(decide(0, '本次使用 Seedance 2.0 Mini 生成。本次生成将消耗每日免费额度。'), false)
})

test('does not send a confirmation into a failed or already-generated task', () => {
  const base = {
    pageText: '视频生成参数确认 确认后我再开始生成视频。',
    elapsedMs: DOUBAO_GENERATION_CONFIRM_GRACE_MS,
    replyCount: 0,
    msSinceLastReply: null,
    hasFailure: false,
    generated: false
  }

  assert.equal(shouldSendGenerationConfirmation({ ...base, hasFailure: true }), false)
  assert.equal(shouldSendGenerationConfirmation({ ...base, generated: true }), false)
})

test('the confirmation reply text is 生成视频', () => {
  assert.equal(DOUBAO_GENERATION_CONFIRM_REPLY, '生成视频')
})

test('the main loop polls every 5 seconds', () => {
  assert.equal(GENERATION_POLL_INTERVAL_MS, 5000)
})

test('blocks a second confirmation until 30s after the previous reply', () => {
  const base = {
    pageText: '视频生成参数确认 确认后我再开始生成视频。',
    elapsedMs: DOUBAO_GENERATION_CONFIRM_GRACE_MS + 60000,
    replyCount: 1,
    hasFailure: false,
    generated: false
  }

  assert.equal(DOUBAO_GENERATION_CONFIRM_RETRY_MS, 30000)
  // 还没有上一条回复（首次）不受间隔限制。
  assert.equal(shouldSendGenerationConfirmation({ ...base, msSinceLastReply: null }), true)
  assert.equal(shouldSendGenerationConfirmation({ ...base, msSinceLastReply: DOUBAO_GENERATION_CONFIRM_RETRY_MS - 1 }), false)
  assert.equal(shouldSendGenerationConfirmation({ ...base, msSinceLastReply: DOUBAO_GENERATION_CONFIRM_RETRY_MS }), true)
})

test('spaces five confirmations 30s apart on a 5-second main loop', () => {
  const replyTimes = []
  let lastReplyAt = null
  for (let elapsedMs = 0; elapsedMs <= 180000; elapsedMs += GENERATION_POLL_INTERVAL_MS) {
    const shouldReply = shouldSendGenerationConfirmation({
      pageText: '视频生成参数确认 确认后我再开始生成视频。',
      elapsedMs,
      replyCount: replyTimes.length,
      msSinceLastReply: lastReplyAt === null ? null : elapsedMs - lastReplyAt,
      hasFailure: false,
      generated: false
    })
    if (shouldReply) {
      replyTimes.push(elapsedMs)
      lastReplyAt = elapsedMs
    }
  }

  // 宽限期 12s 后第一个 5s 轮询点是 15s，之后每次都要再等满 30s。
  assert.deepEqual(replyTimes, [15000, 45000, 75000, 105000, 135000])
  assert.equal(replyTimes.length, DOUBAO_GENERATION_CONFIRM_MAX_REPLIES)
})

test('detects Doubao infringement and violation failures', () => {
  const text = '生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。'
  const message = extractDoubaoFailureMessage(text)

  assert.equal(message, text)
  assert.equal(isQuotaNotChargedFailure(message), true)
})

test('detects common generation failure text', () => {
  assert.equal(extractDoubaoFailureMessage('视频生成失败，请稍后再试。'), '视频生成失败，请稍后再试。')
  assert.equal(extractDoubaoFailureMessage('你的视频免费额度还有 2 次。'), null)
})

test('detects the exhausted daily free generation quota message', () => {
  assert.equal(extractDoubaoFailureMessage('今日视频生成免费次数已用完。'), '今日视频生成免费次数已用完。')
  assert.equal(extractDoubaoFailureMessage('今日免费生成次数已用完，明天再来吧。'), '今日免费生成次数已用完，明天再来吧。')
  assert.equal(extractDoubaoFailureMessage('今日生成次数已用完。'), '今日生成次数已用完。')
  assert.equal(extractDoubaoFailureMessage('免费生成次数已用完，请明天再试。'), '免费生成次数已用完，请明天再试。')
  assert.equal(isQuotaNotChargedFailure('今日视频生成免费次数已用完'), false)
})

test('matches the current prompt by normalized signature', () => {
  const prompt = '生成视频：口播台词 “但如果经量突然明显增多，应该及时检查。”'
  const composerText = '生成视频 口播台词 但如果经量突然明显增多 应该及时检查'

  assert.equal(promptSignature(prompt).length > 10, true)
  assert.equal(containsPromptSignature(composerText, prompt), true)
  assert.equal(containsPromptSignature('搜索：其他历史对话', prompt), false)
})

test('accepts only new HTTP video links for the current generation', () => {
  assert.deepEqual(
    getNewDoubaoVideoUrls(
      ['https://cdn.example.com/old.mp4', 'https://cdn.example.com/current.mp4', 'blob:current'],
      ['https://cdn.example.com/old.mp4']
    ),
    ['https://cdn.example.com/current.mp4']
  )
  assert.deepEqual(
    getNewDoubaoVideoUrls(['https://www.doubao.com/thread/xbsMtOGRraAcehDc8'], []),
    []
  )
  // Dola 与豆包共用同一套前端，站点自身的地址同样不算视频源。
  assert.deepEqual(
    getNewDoubaoVideoUrls(['https://www.dola.com/thread/xbsMtOGRraAcehDc8'], []),
    []
  )
  assert.deepEqual(
    getNewDoubaoVideoUrls(['https://cdn.example.com/current.mp4'], []),
    ['https://cdn.example.com/current.mp4']
  )
})

test('treats Dola and Doubao share/conversation URLs the same way', () => {
  // Dola 是豆包的海外版，两者前端一致，仅域名不同。
  assert.equal(
    extractDoubaoShareUrl('复制链接：https://www.dola.com/thread/abc_123?from=share。'),
    'https://www.dola.com/thread/abc_123?from=share'
  )
  assert.equal(
    extractDoubaoShareUrl('https://dola.com/share/share-123'),
    'https://dola.com/share/share-123'
  )
  assert.equal(extractDoubaoShareUrl('https://www.dola.com/chat/chat_123'), null)

  assert.equal(
    extractDoubaoConversationUrl('https://www.dola.com/chat/38437129678594562'),
    'https://www.dola.com/chat/38437129678594562'
  )
  assert.equal(
    extractDoubaoConversationUrl('https://www.dola.com/chat/local_2452181702532277'),
    'https://www.dola.com/chat/local_2452181702532277'
  )
  assert.equal(extractDoubaoConversationUrl('https://www.dola.com/thread/xZR7KqTbeRvEAjlB8'), null)
  assert.equal(
    isLocalDraftDoubaoConversationUrl('https://www.dola.com/chat/local_3921336934625024'),
    true
  )
})

test('recognizes only newly added page messages', () => {
  const message = '生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。'
  const baseline = `历史任务 ${message}`

  assert.equal(hasNewTextOccurrence(baseline, baseline, message), false)
  assert.equal(hasNewTextOccurrence(`${baseline} 新任务 ${message}`, baseline, message), true)
})

test('detects a newly submitted prompt in the conversation page', () => {
  const prompt = '生成一段 12 秒女性养生科普视频，画面比例 16:9。'
  const baseline = '历史对话 输入框'
  const current = `${baseline} 用户 ${prompt} 助手 本次使用 Seedance 2.0 Mini 生成`

  assert.equal(hasNewPromptOccurrence(current, baseline, prompt), true)
  assert.equal(hasNewPromptOccurrence(baseline, baseline, prompt), false)
})

test('extracts current Doubao share URL formats', () => {
  assert.equal(
    extractDoubaoShareUrl('复制链接：https://www.doubao.com/thread/abc_123?from=share。'),
    'https://www.doubao.com/thread/abc_123?from=share'
  )
  assert.equal(extractDoubaoShareUrl('https://doubao.com/chat/chat_123#video'), null)
  assert.equal(
    extractDoubaoShareUrl('https://www.doubao.com/share/share-123'),
    'https://www.doubao.com/share/share-123'
  )
  assert.equal(extractDoubaoShareUrl('https://example.com/thread/abc'), null)
})

test('accepts only chat pages as recoverable source conversations', () => {
  assert.equal(
    extractDoubaoConversationUrl('https://www.doubao.com/chat/local_2452181702532277'),
    'https://www.doubao.com/chat/local_2452181702532277'
  )
  assert.equal(
    extractDoubaoConversationUrl('https://www.doubao.com/chat/38437129678594562'),
    'https://www.doubao.com/chat/38437129678594562'
  )
  assert.equal(extractDoubaoConversationUrl('https://www.doubao.com/thread/xZR7KqTbeRvEAjlB8'), null)
})

test('distinguishes local draft URLs from official Doubao conversations', () => {
  assert.equal(
    isLocalDraftDoubaoConversationUrl('https://www.doubao.com/chat/local_3921336934625024'),
    true
  )
  assert.equal(
    isLocalDraftDoubaoConversationUrl('https://www.doubao.com/chat/local_2452181702532277?from=home'),
    true
  )
  assert.equal(
    isLocalDraftDoubaoConversationUrl('https://www.doubao.com/chat/38437129678594562'),
    false
  )
  assert.equal(isLocalDraftDoubaoConversationUrl(null), false)
  assert.equal(isLocalDraftDoubaoConversationUrl('https://www.doubao.com/chat'), false)
})

test('detects when the prompt moved from composer into the chat', () => {
  const prompt = '生成视频：一只异兽在月下的森林中一闪而过。'
  // 输入框已清空，提示词回显在聊天区 → 真正发送
  assert.equal(
    isPromptMovedOutOfComposer({
      pageText: '本次使用 Seedance 2.0 Mini 生成 生成视频：一只异兽在月下的森林中一闪而过。 视频生成好后',
      composerText: '',
      prompt,
    }),
    true
  )
  // 输入框被清空但页面里也找不到提示词 → 内容被丢弃，并未发送
  assert.equal(
    isPromptMovedOutOfComposer({
      pageText: '本次使用 Seedance 2.0 Mini 生成 视频生成好后',
      composerText: '',
      prompt,
    }),
    false
  )
  // 输入框里仍保留提示词（尚未清空）→ 不算已移入聊天区
  assert.equal(
    isPromptMovedOutOfComposer({
      pageText: '生成视频：一只异兽在月下的森林中一闪而过。',
      composerText: '生成视频：一只异兽在月下的森林中一闪而过。',
      prompt,
    }),
    false
  )
  // 输入框被换成其它内容，但页面仍含提示词 → 已移出
  assert.equal(
    isPromptMovedOutOfComposer({
      pageText: '生成视频：一只异兽在月下的森林中一闪而过。',
      composerText: '正在重新输入...',
      prompt,
    }),
    true
  )
})

test('does not treat prompt rewrite pages as generated videos', () => {
  assert.equal(
    isDoubaoPromptRewritePage('完整 12 秒视频生成指令（可直接用于视频生成工具）'),
    true
  )
  assert.equal(
    isDoubaoPromptRewritePage('你的视频生成好了，点击分享即可复制链接。'),
    false
  )
})

test('detects the Doubao desktop-download prompt that can block sharing', () => {
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 使用完整功能 随时帮忙的 AI 桌面助手 下载电脑版 下次提醒我'),
    true
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 使用完整功能 下载电脑版'),
    false
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 免费领取 30 天订阅 工作模式升级 PPT Excel 文档 代码 立即下载'),
    true
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载豆包电脑版 免费领取 30 天订阅 立即下载'),
    true
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('天天领额度 免费用豆包 额度越多 可免费用豆包工作越多 立即下载电脑版'),
    true
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 免费领取'),
    false
  )
})

test('recognizes the completion text shown by Doubao video cards', () => {
  assert.equal(isDoubaoGenerationComplete('你的视频生成好了。'), true)
  assert.equal(isDoubaoGenerationComplete('视频生成已提交，预计等待 5 分钟。'), false)
})

test('only treats a newly added completion message as the current result', () => {
  const oldMessages = '历史任务：你的视频生成好了。'
  const currentMessages = `${oldMessages} 新任务：你的视频生成好了。`

  assert.equal(hasNewGenerationCompletion(oldMessages, oldMessages), false)
  assert.equal(hasNewGenerationCompletion(currentMessages, oldMessages), true)
})

test('share-page readiness rejects a snapshot copied before video finalization', () => {
  // 取自真实分享页 innerText：分享链接复制太早时，快照里只有提交文案没有视频卡。
  const snapshotWithoutVideo = [
    '生成10秒视频',
    '2026 年 8 月 26 日•AI 生成可能有误 注意核实',
    '生成视频：没有提示词，发挥你的想象力，10s',
    '我将为您把这四张图片制作成一个 10 秒的梦幻故事视频。',
    '视频生成已提交',
    '本次使用 Seedance 2.0 Mini 生成，预计等待 20 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。',
  ].join('\n')
  const snapshotWithVideo = [
    snapshotWithoutVideo,
    '生成视频：没有提示词，发挥你的想象力，10s',
    '你的视频生成好了。',
    '打开豆包',
  ].join('\n')

  // 提交文案里的"视频生成好后"不应被误判为完成。
  assert.equal(hasNewGenerationCompletion(snapshotWithoutVideo, ''), false)
  assert.equal(hasNewGenerationCompletion(snapshotWithVideo, ''), true)

  const readiness = (completionTextPresent, newVideoCardCount) =>
    isGenerationReadyForShare({
      completionTextPresent,
      hasNewVideoSource: false,
      newVideoCount: 0,
      newPlayableVideoCount: 0,
      newVideoCardCount,
      completionTextSeenAt: Date.now(),
      now: Date.now(),
    })
  assert.equal(readiness(false, 1), false)
  assert.equal(readiness(true, 0), false)
  assert.equal(readiness(true, 1), true)
})

test('waits for a video element before treating the result as share-ready', () => {
  const base = {
    completionTextPresent: true,
    hasNewVideoSource: false,
    newVideoCount: 0,
    completionTextSeenAt: 1000,
    graceMs: 15000
  }
  // Text alone is not enough: still waiting for the video card.
  assert.equal(isGenerationReadyForShare({ ...base, now: 5000 }), false)
  // A new video source makes it ready immediately.
  assert.equal(isGenerationReadyForShare({ ...base, hasNewVideoSource: true, now: 2000 }), true)
  // A newly rendered video element also makes it ready.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCount: 1, now: 3000 }), true)
  // A playable blob/object URL video is also ready even without an HTTP source.
  assert.equal(isGenerationReadyForShare({ ...base, newPlayableVideoCount: 1, now: 3000 }), true)
  // The current Doubao build renders a video poster as an image before the
  // playable video element exists; the new card is sufficient to share.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCardCount: 1, now: 3000 }), true)
  // Stale videos from earlier tasks do not count.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCount: 0, now: 3000 }), false)
  // Completion text alone is not accepted before the grace period elapses.
  assert.equal(isGenerationReadyForShare({ ...base, now: 5000 }), false)
  // Once the card never renders past the grace period, stop waiting for it;
  // otherwise a hidden execution window hangs the task until the global timeout.
  assert.equal(isGenerationReadyForShare({ ...base, now: 17000 }), true)
  // No completion text means never ready, even with videos on the page.
  assert.equal(isGenerationReadyForShare({ ...base, completionTextPresent: false, newVideoCount: 1, now: 17000 }), false)
  // Completion text seen but grace not yet elapsed still waits.
  assert.equal(isGenerationReadyForShare({ ...base, completionTextSeenAt: 0, now: 17000 }), false)
  // The default grace period is long enough that a normal card render wins.
  assert.equal(isGenerationReadyForShare({ ...base, graceMs: undefined, now: 10000 }), false)
})
