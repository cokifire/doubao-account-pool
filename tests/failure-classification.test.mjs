import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyDoubaoFailure,
  shouldRefundQuota,
  shouldStopPolling,
} from '../dist-electron/failure-classification.js'

test('classifies membership entitlement failures', () => {
  assert.equal(classifyDoubaoFailure('该模型为会员专享，请升级会员后使用'), 'membership_required')
  assert.equal(classifyDoubaoFailure('当前权益不足，请开通会员'), 'membership_required')
})

test('classifies quota exhaustion without refunding the local points', () => {
  const code = classifyDoubaoFailure('今日视频生成免费次数已用完')
  assert.equal(code, 'quota_exhausted')
  // 既有行为：平台免费次数用完时保留本地扣点，避免立刻复用已无产能的账号。
  assert.equal(shouldRefundQuota(code), false)
  // 但绝不能继续空等到超时。
  assert.equal(shouldStopPolling(code), true)
})

test('refunds when the platform explicitly did not charge', () => {
  const code = classifyDoubaoFailure('生成内容中疑似包含侵权 / 违规内容，无法返回该内容，生成额度未扣除。')
  assert.equal(code, 'content_rejected')
  assert.equal(shouldRefundQuota(code), true)
  assert.equal(shouldStopPolling(code), true)
})

test('classifies face restriction and plain generation failure', () => {
  assert.equal(classifyDoubaoFailure('生成内容涉及真人脸，无法生成'), 'face_restricted')
  assert.equal(classifyDoubaoFailure('视频生成失败，请稍后再试'), 'generation_failed')
  assert.equal(shouldRefundQuota('generation_failed'), false)
  assert.equal(shouldStopPolling('generation_failed'), true)
})

test('classifies login expiry as refundable and terminal', () => {
  const code = classifyDoubaoFailure('登录已失效，请重新登录')
  assert.equal(code, 'login_required')
  assert.equal(shouldRefundQuota(code), true)
  assert.equal(shouldStopPolling(code), true)
})

test('leaves unrecognised text open for retry and keeps the deduction', () => {
  assert.equal(classifyDoubaoFailure('网络似乎有点波动'), 'unknown')
  assert.equal(classifyDoubaoFailure(null), 'unknown')
  assert.equal(classifyDoubaoFailure(''), 'unknown')
  // 未识别的失败保持既有行为：不终止轮询、不退款。
  assert.equal(shouldStopPolling('unknown'), false)
  assert.equal(shouldRefundQuota('unknown'), false)
})

test('membership failure refunds because nothing was generated', () => {
  assert.equal(shouldRefundQuota('membership_required'), true)
  assert.equal(shouldStopPolling('membership_required'), true)
})

test('submission failures refund because the site never created the conversation', () => {
  assert.equal(shouldRefundQuota('submission_failed'), true)
  assert.equal(shouldStopPolling('submission_failed'), true)
})
