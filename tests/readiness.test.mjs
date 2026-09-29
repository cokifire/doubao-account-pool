import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadinessError, waitForReadiness } from '../dist-electron/readiness.js'

function fakeClock() {
  let value = 0
  return {
    now: () => value,
    wait: async (ms) => {
      value += ms
    },
  }
}

test('throws a stage-coded error when the control never becomes ready', async () => {
  const { now, wait } = fakeClock()

  await assert.rejects(
    () => waitForReadiness({ stage: 'model_control', probe: () => false, timeoutMs: 1000, now, wait }),
    (error) => {
      assert.ok(error instanceof ReadinessError)
      assert.equal(error.code, 'model_control_not_ready')
      assert.equal(error.diagnostic.ready, false)
      assert.equal(error.diagnostic.stage, 'model_control')
      assert.equal(error.diagnostic.attempts > 1, true)
      return true
    },
  )
})

test('returns diagnostics as soon as the probe is stable', async () => {
  const { now, wait } = fakeClock()
  const result = await waitForReadiness({
    stage: 'composer',
    probe: () => true,
    stableSamples: 2,
    timeoutMs: 5000,
    now,
    wait,
  })

  assert.equal(result.ready, true)
  assert.equal(result.attempts, 2)
  assert.equal(result.stableSamples, 2)
})

test('resets stability when the probe flaps', async () => {
  const { now, wait } = fakeClock()
  const sequence = [true, false, true, true, true]
  let index = 0
  const result = await waitForReadiness({
    stage: 'video_mode',
    probe: () => sequence[Math.min(index++, sequence.length - 1)],
    stableSamples: 3,
    timeoutMs: 30000,
    now,
    wait,
  })

  assert.equal(result.ready, true)
  assert.equal(result.attempts, 5)
  assert.equal(result.stableSamples, 3)
})

test('does not hang on a zero timeout', async () => {
  const { now, wait } = fakeClock()
  await assert.rejects(() => waitForReadiness({ stage: 'x', probe: () => false, timeoutMs: 0, now, wait }))
})
