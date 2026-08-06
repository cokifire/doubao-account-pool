import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsPromptSignature,
  extractDoubaoFailureMessage,
  extractDoubaoShareUrl,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoGenerationComplete,
  isDoubaoPromptRewritePage,
  isQuotaNotChargedFailure,
  promptSignature,
} from '../dist-electron/doubao-page-state.js'

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

test('matches the current prompt by normalized signature', () => {
  const prompt = '生成视频：口播台词 “但如果经量突然明显增多，应该及时检查。”'
  const composerText = '生成视频 口播台词 但如果经量突然明显增多 应该及时检查'

  assert.equal(promptSignature(prompt).length > 10, true)
  assert.equal(containsPromptSignature(composerText, prompt), true)
  assert.equal(containsPromptSignature('搜索：其他历史对话', prompt), false)
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
  assert.equal(
    extractDoubaoShareUrl('https://doubao.com/chat/chat_123#video'),
    'https://doubao.com/chat/chat_123#video'
  )
  assert.equal(
    extractDoubaoShareUrl('https://www.doubao.com/share/share-123'),
    'https://www.doubao.com/share/share-123'
  )
  assert.equal(extractDoubaoShareUrl('https://example.com/thread/abc'), null)
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
