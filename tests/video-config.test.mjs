import assert from 'node:assert/strict'
import test from 'node:test'

import {
  durationToSliderValue,
  durationToSeconds,
  getVideoCompositeLabel,
  isVideoCompositeControlText,
  normalizeVideoAspectRatio,
  normalizeVideoDuration,
  parseCompositeLabel,
  sliderValueToDuration,
} from '../dist-electron/video-config.js'

test('normalizes duration from several shapes', () => {
  assert.equal(normalizeVideoDuration('10s'), '10s')
  assert.equal(normalizeVideoDuration('10'), '10s')
  assert.equal(normalizeVideoDuration(10), '10s')
  assert.equal(normalizeVideoDuration(' 4S '), '4s')
})

test('rejects out-of-range durations', () => {
  assert.equal(normalizeVideoDuration('3s'), null)
  assert.equal(normalizeVideoDuration('16s'), null)
  assert.equal(normalizeVideoDuration(null), null)
  assert.equal(normalizeVideoDuration(''), null)
  assert.equal(normalizeVideoDuration('abc'), null)
})

test('normalizes aspect ratio against the whitelist', () => {
  assert.equal(normalizeVideoAspectRatio('16:9'), '16:9')
  assert.equal(normalizeVideoAspectRatio(' 9:16 '), '9:16')
  assert.equal(normalizeVideoAspectRatio('1:2'), null)
  assert.equal(normalizeVideoAspectRatio(null), null)
})

test('builds the composite readback label', () => {
  assert.equal(getVideoCompositeLabel('16:9', '10s'), '16:9 · 10s')
})

test('maps duration onto the slider value', () => {
  assert.equal(durationToSeconds('4s'), 4)
  assert.equal(durationToSliderValue('4s'), 0)
  assert.equal(durationToSliderValue('10s'), 6)
  assert.equal(durationToSliderValue('15s'), 11)
  assert.equal(sliderValueToDuration(0), '4s')
  assert.equal(sliderValueToDuration(6), '10s')
  assert.equal(sliderValueToDuration(11), '15s')
  assert.equal(sliderValueToDuration(12), null)
})

test('parses the composite control readback', () => {
  assert.deepEqual(parseCompositeLabel('9:16 · 10s'), { aspectRatio: '9:16', duration: '10s' })
  assert.deepEqual(parseCompositeLabel('16:9 · 4s'), { aspectRatio: '16:9', duration: '4s' })
  assert.deepEqual(parseCompositeLabel('自动 · 5s'), { aspectRatio: '自动', duration: '5s' })
})

test('rejects text that is not a composite label', () => {
  assert.equal(parseCompositeLabel('视频生成'), null)
  assert.equal(parseCompositeLabel(''), null)
  assert.equal(parseCompositeLabel('16:9'), null)
})

test('recognises composite control text', () => {
  assert.equal(isVideoCompositeControlText('16:9 · 10s'), true)
  assert.equal(isVideoCompositeControlText('自动 · 5s'), true)
  assert.equal(isVideoCompositeControlText('模型  Seedance 2.0 Mini'), false)
})
