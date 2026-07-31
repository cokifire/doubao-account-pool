import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsPromptSignature,
  extractDoubaoFailureMessage,
  hasNewTextOccurrence,
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
