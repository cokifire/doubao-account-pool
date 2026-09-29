import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeGenerateInput } from '../dist-electron/input-contract.js'

const defaults = { defaultModel: 'seedance_2_0_mini', maxReferenceImages: 10 }

test('fills defaults for a minimal payload', () => {
  const result = normalizeGenerateInput({ prompt: '生成一段视频' }, defaults)

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    model: 'seedance_2_0_mini',
    prompt: '生成一段视频',
    referenceImagePaths: [],
    callbackUrl: null,
    source: '',
  })
})

test('rejects an empty prompt', () => {
  const result = normalizeGenerateInput({ prompt: '   ' }, defaults)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'prompt is required')
})

test('rejects an over-long prompt', () => {
  const result = normalizeGenerateInput({ prompt: 'a'.repeat(4001) }, defaults)
  assert.equal(result.ok, false)
  assert.match(result.error, /prompt/)
})

test('rejects an unsupported model instead of silently falling back', () => {
  const result = normalizeGenerateInput({ prompt: 'x', model: 'seedance_9_9' }, defaults)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unsupported model')
})

test('accepts fast model', () => {
  const result = normalizeGenerateInput({ prompt: 'x', model: 'seedance_2_0_fast' }, defaults)
  assert.equal(result.ok, true)
  assert.equal(result.value.model, 'seedance_2_0_fast')
})

test('accepts http and https callback urls only', () => {
  assert.equal(normalizeGenerateInput({ prompt: 'x', callbackUrl: 'http://127.0.0.1:3000/cb' }, defaults).ok, true)
  assert.equal(normalizeGenerateInput({ prompt: 'x', callbackUrl: 'https://example.com/cb' }, defaults).ok, true)
  assert.equal(normalizeGenerateInput({ prompt: 'x', callbackUrl: 'ftp://example.com/cb' }, defaults).ok, false)
})

test('rejects callback urls carrying credentials', () => {
  const result = normalizeGenerateInput({ prompt: 'x', callbackUrl: 'https://user:pass@example.com/cb' }, defaults)
  assert.equal(result.ok, false)
  assert.match(result.error, /callbackUrl/)
})

test('parses comma separated reference image paths', () => {
  const result = normalizeGenerateInput({ prompt: 'x', referenceImagePaths: 'a.png,b.png' }, defaults)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.referenceImagePaths, ['a.png', 'b.png'])
})

test('parses a json array of reference image paths', () => {
  const result = normalizeGenerateInput({ prompt: 'x', referenceImagePaths: '["a.png","b.png"]' }, defaults)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.referenceImagePaths, ['a.png', 'b.png'])
})

test('rejects too many reference images', () => {
  const result = normalizeGenerateInput(
    { prompt: 'x', referenceImagePaths: Array.from({ length: 11 }, (_, i) => `${i}.png`) },
    defaults,
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /参考图/)
})

test('truncates the source label', () => {
  const result = normalizeGenerateInput({ prompt: 'x', source: 's'.repeat(200) }, defaults)
  assert.equal(result.ok, true)
  assert.equal(result.value.source.length, 64)
})
