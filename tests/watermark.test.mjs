import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractVideoUrlFromPayload,
  getWatermarkRetryDelays,
  hasDoubaoShareVideoResource,
  isMp4VideoUrl,
  isRetryableWatermarkError,
  WATERMARK_RETRY_DELAYS_MS,
} from '../dist-electron/watermark.js'

test('requires a real video resource in a copied Doubao share page', () => {
  const valid = `
    你的视频生成好了。
    {\\"creation_block\\":{\\"video\\":{\\"cover\\":\\"video_dsz_watermark_1_6.png\\",
    \\"video_type\\":\\"mp4\\",\\"download_url\\":\\"https:\\u002F\\u002Fcdn.example.com\\u002Fvideo?mime_type=video_mp4\\"}}}
  `
  assert.equal(hasDoubaoShareVideoResource(valid), true)
  assert.equal(hasDoubaoShareVideoResource('你的视频生成好了，但只有普通对话内容'), false)
  assert.equal(hasDoubaoShareVideoResource('download_url mime_type=video_mp4'), false)
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
