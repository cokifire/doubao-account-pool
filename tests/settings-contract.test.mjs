import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS, normalizeSettings } from '../dist-electron/settings-contract.js'

test('falls back to defaults for missing keys', () => {
  const settings = normalizeSettings({})

  assert.equal(settings.apiPort, DEFAULT_SETTINGS.apiPort)
  assert.equal(settings.executorEnabled, DEFAULT_SETTINGS.executorEnabled)
  assert.equal(settings.defaultModel, 'seedance_2_0_mini')
})

test('clamps out-of-range numbers back into a usable range', () => {
  const settings = normalizeSettings({
    apiPort: 99999,
    generationTimeoutSeconds: 1,
    maxConcurrentAccounts: 0,
    retryCount: -5,
    miniCost: 0,
    fastCost: 0,
    dailyQuotaLimit: -1,
  })

  assert.equal(settings.apiPort, DEFAULT_SETTINGS.apiPort)
  assert.equal(settings.generationTimeoutSeconds, 60)
  assert.equal(settings.maxConcurrentAccounts, 1)
  assert.equal(settings.retryCount, 0)
  assert.equal(settings.miniCost, 1)
  assert.equal(settings.fastCost, 1)
  assert.equal(settings.dailyQuotaLimit, 0)
})

test('keeps valid values untouched', () => {
  const settings = normalizeSettings({ apiPort: 17889, dailyQuotaLimit: 20, generationTimeoutSeconds: 1200 })
  assert.equal(settings.apiPort, 17889)
  assert.equal(settings.dailyQuotaLimit, 20)
  assert.equal(settings.generationTimeoutSeconds, 1200)
})

test('rejects an invalid daily reset time', () => {
  assert.equal(normalizeSettings({ dailyResetTime: '99:99' }).dailyResetTime, DEFAULT_SETTINGS.dailyResetTime)
  assert.equal(normalizeSettings({ dailyResetTime: '08:30' }).dailyResetTime, '08:30')
})

test('rejects an unknown default model', () => {
  assert.equal(normalizeSettings({ defaultModel: 'seedance_9_9' }).defaultModel, DEFAULT_SETTINGS.defaultModel)
  assert.equal(normalizeSettings({ defaultModel: 'seedance_2_0_fast' }).defaultModel, 'seedance_2_0_fast')
})

test('does not flip boolean defaults when the value is absent', () => {
  assert.equal(normalizeSettings({}).executorEnabled, true)
  assert.equal(normalizeSettings({}).showExecutorWindow, false)
  assert.equal(normalizeSettings({ executorEnabled: 0 }).executorEnabled, false)
})

test('normalizes non-string text fields', () => {
  const settings = normalizeSettings({ apiKey: 123, outputDir: null, doubaoChatUrl: '' })
  assert.equal(settings.apiKey, DEFAULT_SETTINGS.apiKey)
  assert.equal(settings.outputDir, DEFAULT_SETTINGS.outputDir)
  assert.equal(settings.doubaoChatUrl, DEFAULT_SETTINGS.doubaoChatUrl)
})
