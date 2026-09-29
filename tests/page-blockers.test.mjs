import assert from 'node:assert/strict'
import test from 'node:test'

import { detectPageBlocker } from '../dist-electron/page-blockers.js'

test('detects a membership upsell overlay', () => {
  const result = detectPageBlocker({
    pageText: '正在生成视频',
    overlayTexts: ['该模型为会员专享，升级会员后可继续使用']
  })

  assert.equal(result.blocked, true)
  assert.equal(result.code, 'membership_required')
  assert.equal(result.evidence, 'membership_overlay')
})

test('detects a cross-origin membership iframe by its descriptor', () => {
  const result = detectPageBlocker({
    pageText: '正在生成视频',
    overlayTexts: [],
    frameDescriptors: ['https://www.doubao.com/subscribe?from=video']
  })

  assert.equal(result.blocked, true)
  assert.equal(result.code, 'membership_required')
  assert.equal(result.evidence, 'membership_iframe')
})

test('detects the login wall as a blocker', () => {
  const result = detectPageBlocker({
    pageText: '扫码登录 手机号登录 登录后可用完整功能'
  })

  assert.equal(result.blocked, true)
  assert.equal(result.code, 'login_required')
  assert.equal(result.evidence, 'login_page')
})

test('does not block a normal generating page', () => {
  const result = detectPageBlocker({
    pageText: '你的视频生成好了，正在处理',
    overlayTexts: ['分享链接已复制'],
    frameDescriptors: ['https://www.doubao.com/chat/123']
  })

  assert.equal(result.blocked, false)
  assert.equal(result.code, 'unknown')
  assert.equal(result.evidence, null)
})

test('does not mistake the desktop download prompt for a membership blocker', () => {
  const result = detectPageBlocker({
    pageText: '下载电脑版 使用完整功能 下次提醒我',
    overlayTexts: ['下载豆包电脑版 免费领取 30 天订阅']
  })

  assert.equal(result.blocked, false)
})

test('does not block on empty input', () => {
  const result = detectPageBlocker({ pageText: '' })
  assert.equal(result.blocked, false)
  assert.equal(result.evidence, null)
})

test('prefers an explicit overlay match over the iframe fallback', () => {
  const result = detectPageBlocker({
    pageText: '',
    overlayTexts: ['权益不足，请开通会员'],
    frameDescriptors: ['https://example.com/upgrade']
  })

  assert.equal(result.evidence, 'membership_overlay')
})
