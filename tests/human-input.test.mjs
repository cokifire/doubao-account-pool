import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRng,
  seedFromParts,
  typingPlan,
  bezierPath,
  jitterDelay
} from '../dist-electron/human-input.js'

test('createRng 同一 seed 产出同一序列，且值落在 [0,1)', () => {
  const a = createRng(12345)
  const b = createRng(12345)
  const c = createRng(67890)
  for (let i = 0; i < 100; i++) {
    const va = a()
    const vb = b()
    const vc = c()
    assert.equal(va, vb)
    assert.ok(va >= 0 && va < 1)
    assert.ok(vc >= 0 && vc < 1)
  }
})

test('seedFromParts 稳定且对顺序敏感', () => {
  assert.equal(seedFromParts('a', 1), seedFromParts('a', 1))
  assert.notEqual(seedFromParts('a', 1), seedFromParts('a', 2))
  assert.notEqual(seedFromParts('a', 1), seedFromParts(1, 'a'))
})

test('typingPlan 拼接后与原文完全一致', () => {
  const prompt = '生成一段 10 秒女性科普动画，画面明亮、节奏轻快。结尾加上字幕：感谢观看！'
  const plan = typingPlan(prompt, 42)
  const rebuilt = plan.map((chunk) => chunk.text).join('')
  assert.equal(rebuilt, prompt)
})

test('typingPlan 同一 seed 结果可复现', () => {
  const prompt = '把这段文字拆成拟人打字片段，测试确定性。'
  const a = typingPlan(prompt, 7)
  const b = typingPlan(prompt, 7)
  assert.deepEqual(a, b)
})

test('typingPlan 段数不超过 maxChunks', () => {
  const long = '甲乙丙丁戊己庚辛壬癸'.repeat(40)
  const plan = typingPlan(long, 99, { maxChunks: 30 })
  assert.ok(plan.length <= 30)
  assert.equal(plan.map((c) => c.text).join(''), long)
})

test('typingPlan 停顿非负，句末段停顿更大', () => {
  const prompt = '第一句。第二句！第三句？'
  const plan = typingPlan(prompt, 5, { basePauseMs: 80, sentencePauseMs: 300, spread: 0 })
  assert.ok(plan.length >= 3)
  for (const chunk of plan.slice(0, -1)) {
    assert.ok(chunk.pauseMs >= 0)
  }
  // spread=0 时句末段应为 base+sentence，其余为 base；最后一段无论何种结尾都归零。
  const last = plan[plan.length - 1]
  const sentenceChunks = plan.filter((c) => c !== last && /[。！？]$/.test(c.text))
  const plainChunks = plan.filter((c) => c !== last && !/[。！？]$/.test(c.text))
  for (const c of sentenceChunks) assert.equal(c.pauseMs, 80 + 300)
  for (const c of plainChunks) assert.equal(c.pauseMs, 80)
  // 最后一段停顿归零
  assert.equal(last.pauseMs, 0)
})

test('空提示词返回空计划', () => {
  assert.deepEqual(typingPlan('', 1), [])
  assert.deepEqual(typingPlan('   ', 1), [])
})

test('bezierPath 起点接近 from、终点精确等于 to，且确定性', () => {
  const from = { x: 100, y: 200 }
  const to = { x: 640, y: 480 }
  const a = bezierPath(from, to, 11)
  const b = bezierPath(from, to, 11)
  assert.deepEqual(a, b)

  assert.ok(a.length >= 2)
  const first = a[0]
  const last = a[a.length - 1]
  assert.equal(last.x, to.x)
  assert.equal(last.y, to.y)
  // 起点 = from（t=0）
  assert.equal(first.x, from.x)
  assert.equal(first.y, from.y)

  // 所有点都在 from/to 的包围盒内（含抖动余量）
  for (const p of a) {
    assert.ok(p.x >= Math.min(from.x, to.x) - 100 && p.x <= Math.max(from.x, to.x) + 100)
    assert.ok(p.y >= Math.min(from.y, to.y) - 100 && p.y <= Math.max(from.y, to.y) + 100)
  }
})

test('bezierPath 尊重 steps 参数', () => {
  const points = bezierPath({ x: 0, y: 0 }, { x: 100, y: 100 }, 3, { steps: 10 })
  assert.equal(points.length, 11)
})

test('jitterDelay 落在基础值上下限内', () => {
  const rng = createRng(1)
  for (let i = 0; i < 200; i++) {
    const value = jitterDelay(100, rng, 0.4)
    assert.ok(value >= 60 && value <= 140)
    assert.ok(Number.isInteger(value))
  }
})
