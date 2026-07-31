import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractVideoUrlFromPayload,
  isMp4VideoUrl,
  isRetryableWatermarkError,
} from '../dist-electron/watermark.js'

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
