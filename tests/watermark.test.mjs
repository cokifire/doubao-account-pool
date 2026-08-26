import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractVideoUrlFromPayload,
  getWatermarkRetryDelays,
  isMp4VideoUrl,
  isRetryableWatermarkError,
  isValidDoubaoShareUrl,
  WATERMARK_RETRY_DELAYS_MS,
} from '../dist-electron/watermark.js'

test('accepts real Doubao share link shapes', () => {
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/thread/xbFzZPi2eseSsvsO8'), true)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/share/abcd1234?x=1'), true)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/thread/xbFzZPi2eseSsvsO8/posts?fid=1'), true)
})

test('rejects chat URLs (login-required, not share links) and garbage', () => {
  assert.equal(isValidDoubaoShareUrl(''), false)
  assert.equal(isValidDoubaoShareUrl('https://example.com/page'), false)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/search?q=video'), false)
  assert.equal(isValidDoubaoShareUrl('不是链接'), false)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/'), false)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/chat/1234abcd'), false)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/chat/local_0000000000000000000000'), false)
  assert.equal(isValidDoubaoShareUrl('https://www.doubao.com/chat/38438949252373250'), false)
})

test('extracts a nested MP4 result', () => {
  const url = 'https://cdn.example.com/video/result.mp4?token=test'
  assert.equal(extractVideoUrlFromPayload({ data: { playUrl: url } }), url)
})

test('accepts common MP4 URL formats', () => {
  assert.equal(isMp4VideoUrl('https://cdn.example.com/video?id=1&format=mp4'), true)
  assert.equal(isMp4VideoUrl('https://example.com/share/page'), false)
})

test('retries eventual-consistency failures from the watermark provider', () => {
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：未找到资源或获取失败')), true)
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：资源处理中，请稍后重试')), true)
  assert.equal(isRetryableWatermarkError(new Error('去水印接口失败：解析失败')), true)
})

test('does not retry unsupported platforms', () => {
  assert.equal(isRetryableWatermarkError(new Error('去水印接口返回：平台暂不支持')), false)
})

test('uses a short first retry and bounded backoff', () => {
  assert.deepEqual([...WATERMARK_RETRY_DELAYS_MS], [0, 5000, 15000, 30000, 60000])
  assert.deepEqual([...getWatermarkRetryDelays(3)], [0, 5000, 15000])
  assert.deepEqual([...getWatermarkRetryDelays(99)], [...WATERMARK_RETRY_DELAYS_MS])
})
