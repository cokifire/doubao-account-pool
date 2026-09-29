# 执行可靠性加固 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 doubao-studio 的 5 个页面控制流程移植到豆包账号池，让失败可被分类、可被快速终止、额度不被误扣，并把易碎的文本判定收敛为「稳定选择器优先 + 文本回退」。

**Architecture:** 新增 5 个**不依赖 Electron/DOM 的纯函数模块**（`electron/failure-classification.ts`、`page-blockers.ts`、`readiness.ts`、`page-selectors.ts`、`input-contract.ts`、`settings-contract.ts`），判定逻辑全部可在 `tests/*.test.mjs` 中单测；DOM 采集与点击仍留在 `executor.ts`。对外接口入参与 SQLite 读出的设置走同一套白名单归一化。

**Tech Stack:** Electron 36 / TypeScript strict (NodeNext) / better-sqlite3 / node:test

**落地顺序:** 2（错误码+fail-closed）→ 3（会员拦截）→ 1（就绪门禁）→ 4（选择器优先）→ 7（契约层）

---

## 关键约定（先读，后面所有任务依赖）

- 测试跑编译产物：`npm run test:unit` = `npm run build && node --test tests/*.test.mjs`
- 快速迭代（跳过 vue-tsc/vite）：
  ```bash
  npx tsc -p tsconfig.electron.json && node --test tests/<file>.test.mjs
  ```
- `tsconfig.electron.json` 的 `include` 是 `electron/**/*.ts`，新模块放 `electron/` 下即可自动编译到 `dist-electron/`
- 测试文件用 `.test.mjs`，从 `../dist-electron/<module>.js` 导入（与 `tests/doubao-page-state.test.mjs` 一致）
- 每个任务结束单独 commit，中文 commit message

---

### Task 1: 失败码分类纯函数

**Files:**
- Create: `electron/failure-classification.ts`
- Create: `tests/failure-classification.test.mjs`

**Step 1: 写失败测试**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyDoubaoFailure, shouldRefundQuota, shouldStopPolling } from '../dist-electron/failure-classification.js'

test('classifies membership failures', () => {
  assert.equal(classifyDoubaoFailure('该模型为会员专享，请升级会员后使用'), 'membership_required')
})

test('classifies quota exhaustion without treating it as refundable', () => {
  const code = classifyDoubaoFailure('今日视频生成免费次数已用完')
  assert.equal(code, 'quota_exhausted')
  // 既有行为：平台免费次数用完时保留扣点，避免立刻复用已无产能的账号
  assert.equal(shouldRefundQuota(code), false)
  assert.equal(shouldStopPolling(code), true)
})

test('refunds when the platform did not charge', () => {
  const code = classifyDoubaoFailure('生成内容中疑似包含侵权内容，无法返回该内容，生成额度未扣除')
  assert.equal(code, 'content_rejected')
  assert.equal(shouldRefundQuota(code), true)
})

test('unknown text is not terminal', () => {
  assert.equal(classifyDoubaoFailure('网络似乎有点波动'), 'unknown')
  assert.equal(shouldStopPolling('unknown'), false)
})
```

**Step 2:** 运行 `npx tsc -p tsconfig.electron.json && node --test tests/failure-classification.test.mjs` → 期望 FAIL（模块不存在）

**Step 3: 实现** `electron/failure-classification.ts`

```ts
export type DoubaoFailureCode =
  | "membership_required"
  | "quota_exhausted"
  | "content_rejected"
  | "face_restricted"
  | "generation_failed"
  | "login_required"
  | "submission_failed"
  | "unknown";

const MEMBERSHIP = [/升级会员/, /开通会员/, /会员专享/, /权益不足/, /购买会员/, /订阅后可/];
const QUOTA_EXHAUSTED = [/今日[^。]{0,12}次数[^。]{0,6}用完/, /免费次数[^。]{0,6}用完/, /额度[^。]{0,6}用完/, /(?:视频)?生成次数不够/];
const CONTENT_REJECTED = [/疑似包含[^。]{0,20}(?:侵权|违规)/, /(?:侵权|违规)内容/, /无法返回该内容/, /换个主题再试试/, /内容安全|审核不通过/];
const FACE_RESTRICTED = [/真人脸|人脸[^。]{0,8}限制|涉及人物肖像/];
const GENERATION_FAILED = [/视频生成失败/, /生成视频失败/, /未能生成视频/, /生成失败/];
const LOGIN_REQUIRED = [/扫码登录/, /请(?:先)?登录/, /登录(?:已)?(?:失效|过期)/];

export function classifyDoubaoFailure(message: string | null | undefined): DoubaoFailureCode

/** 平台明确未生成/未扣费 → 退还本地预扣额度。 */
export function shouldRefundQuota(code: DoubaoFailureCode): boolean
//   membership_required, content_rejected, face_restricted, login_required, submission_failed, unknown → true
//   quota_exhausted, generation_failed → false（账号确有消耗或已无产能，保留扣点）

/** 继续等待不会有结果 → 立即终止轮询，不再空等 generationTimeoutSeconds。 */
export function shouldStopPolling(code: DoubaoFailureCode): boolean
//   membership_required, quota_exhausted, content_rejected, face_restricted, generation_failed, login_required → true
```

**Step 4:** 运行测试 → PASS

**Step 5:** `git add electron/failure-classification.ts tests/failure-classification.test.mjs && git commit -m "feat: 新增豆包页面失败码分类与退款/终止决策纯函数"`

---

### Task 2: 把失败码接入执行主循环

**Files:**
- Modify: `electron/executor.ts:1499-1509`（失败抛出）、`:462-466`（catch 退款）、`:54-59`（`DoubaoPageFailureError`）

**Step 1:** 给 `DoubaoPageFailureError` 增加 `code: DoubaoFailureCode` 字段，构造函数签名改为 `(message, code, refundQuota?)`；`refundQuota` 缺省由 `shouldRefundQuota(code)` 推导。

**Step 2:** `waitForGenerationResult` 中的失败分支改走分类：

```ts
if (newFailureMessage) {
  const code = classifyDoubaoFailure(newFailureMessage);
  throw new DoubaoPageFailureError(
    `${siteLabel}已返回视频生成失败：${newFailureMessage}`,
    code
  );
}
```

**Step 3:** `execute()` 的 catch 改为 `const code = error instanceof DoubaoPageFailureError ? error.code : "unknown";`，退款条件 `!submittedToDoubao || shouldRefundQuota(code)`。

**Step 4:** `npx tsc -p tsconfig.electron.json --noEmit` 通过；`node --test tests/*.test.mjs` 全绿（**必须**保证 `tests/doubao-page-state.test.mjs:41` 的既有断言不被破坏）

**Step 5:** commit `-m "refactor: 执行主循环失败处理改用结构化失败码决定退款"`

---

### Task 3: 会员 / 风控弹层检测（fail-closed，立即换号）

**Files:**
- Create: `electron/page-blockers.ts`
- Create: `tests/page-blockers.test.mjs`
- Modify: `electron/executor.ts:1614`（新增 `inspectPageBlockers`）、`:1489`（主轮询循环开头）

**Step 1: 写失败测试**（覆盖：弹层文本命中、跨源 iframe descriptor 命中、正常页面不命中、无内 TextBlock 不误判）

**Step 2:** 运行 → FAIL

**Step 3: 实现** `electron/page-blockers.ts`

```ts
export interface BlockerScanInput {
  pageText: string;
  /** [role=dialog]/[role=alert]/modal/toast/popover 的可见文本 */
  overlayTexts?: string[];
  /** iframe 的 title/name/aria-label/src 拼接（父文档读不到跨源 innerText，只能看这些） */
  frameDescriptors?: string[];
}
export interface BlockerScanResult {
  blocked: boolean;
  code: DoubaoFailureCode;   // membership_required | login_required | unknown
  evidence: string | null;   // 仅保留脱敏后的命中类型，不落库原文
}
export function detectPageBlocker(input: BlockerScanInput): BlockerScanResult
```

规则：
- `pageText` / `overlayTexts` 命中会员正则 → `membership_required`
- `pageText` / `overlayTexts` 命中登录正则 → `login_required`
- 仅当上面都没命中时，才检查 `frameDescriptors` 的 `/订阅|会员|升级|subscribe|membership|upgrade/i`（避免普通页面里的「升级」误判）

**Step 4:** executor 新增 DOM 采集 `inspectPageBlockers(win)`，在 `waitForGenerationResult` 每轮循环开头调用；命中即抛 `DoubaoPageFailureError(..., code)`（Task 2 已保证其退款/终止语义）。同步在 `activateVideoMode` 之后也检测一次（选模型就可能触发会员弹层）。

**Step 5:** 测试通过 → commit `-m "feat: 检测豆包会员/登录拦截弹层并立即 fail-closed"`

---

### Task 4: 有界等待 + 稳定采样就绪门禁

**Files:**
- Create: `electron/readiness.ts`
- Create: `tests/readiness.test.mjs`
- Modify: `electron/executor.ts:1020-1028`（`activateVideoMode`）

**Step 1: 写失败测试**（超时抛 `ReadinessError` 且 code 为 `<stage>_not_ready`；连续 3 次稳定才 ready；诊断含 attempts/elapsedMs）

**Step 2:** 运行 → FAIL

**Step 3: 实现** `electron/readiness.ts`

```ts
export interface ReadinessOptions {
  stage: string;
  probe: () => boolean | Promise<boolean>;
  timeoutMs?: number;      // 默认 15000
  stableSamples?: number;  // 默认 3
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
export interface ReadinessDiagnostics {
  ready: boolean; stage: string; attempts: number; elapsedMs: number; stableSamples: number;
}
export class ReadinessError extends Error { readonly code: string; readonly diagnostic: ReadinessDiagnostics }
export async function waitForReadiness(options: ReadinessOptions): Promise<ReadinessDiagnostics>
```

退避：`Math.min(2000, 250 * 2 ** min(attempts-1, 3))`，与 doubao-studio `videoControlReadiness.ts:152` 一致。

**Step 4:** `activateVideoMode` 改为：先用 `waitForReadiness({stage:"video_mode"})` 等创作栏就绪，再用 `{stage:"model_control"}` 等模型控件就绪，替换现在的 `await wait(800/500/500)`；失败时抛出带 stage 的错误（不再静默继续）。

**Step 5:** 测试通过 → commit `-m "feat: 引入有界等待与稳定采样的页面就绪门禁"`

---

### Task 5: 权威结构选择器优先、文本只做回退

**Files:**
- Create: `electron/page-selectors.ts`
- Modify: `electron/executor.ts:93`（`COMPOSER_EDITABLE_SELECTOR` 迁入）、`:1020`（`activateVideoMode`）

**Step 1:** 新建 `electron/page-selectors.ts`，集中常量：

```ts
/** 豆包创作栏稳定结构属性；文本定位仅作为受限回退。 */
export const VIDEO_MODEL_CONTROL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"]';
export const VIDEO_COMPOSITE_CONTROL_SELECTOR = '[data-creation-params-panel-id]';
export const COMPOSER_EDITABLE_SELECTOR = 'textarea, [contenteditable], [role="textbox"], input[type="text"]';
```

**Step 2:** `executor.ts` 从该模块导入 `COMPOSER_EDITABLE_SELECTOR`（删除本地常量，避免两处漂移）。

**Step 3:** `activateVideoMode` 的选模型改为两段式：先在页面内查 `VIDEO_MODEL_CONTROL_SELECTOR` 并点其中心点；查不到才回退到现有 `clickByKeywords(["Seedance","模型","model"])`。回退路径行为保持**完全不变**，保证改动可逆。

**Step 4:** `npx tsc -p tsconfig.electron.json --noEmit` + 全量测试通过 → commit `-m "refactor: 集中页面选择器常量并让模型控件走结构属性优先定位"`

---

### Task 6: 对外入参契约 `/api/generate`

**Files:**
- Create: `electron/input-contract.ts`
- Create: `tests/input-contract.test.mjs`
- Modify: `electron/main.ts:184-197`（校验入口）、`electron/types.ts`（导出 `NormalizedGenerateInput`）

**Step 1: 写失败测试**（未知 model 拒绝；prompt 为空/超长拒绝；callbackUrl 非 http(s) 或带凭据拒绝；参考图超上限拒绝；正常入参补默认值）

**Step 2:** 运行 → FAIL

**Step 3: 实现** `electron/input-contract.ts`

```ts
export interface NormalizedGenerateInput {
  model: DoubaoModel; prompt: string; referenceImagePaths: string[];
  removeWatermark: boolean; callbackUrl: string | null; source: string;
}
export type NormalizeResult =
  | { ok: true; value: NormalizedGenerateInput }
  | { ok: false; error: string };

export function normalizeGenerateInput(
  raw: unknown,
  defaults: { defaultModel: DoubaoModel; maxReferenceImages: number }
): NormalizeResult
```

规则（保持现有可观测行为不变：缺 model 回落 default，未知 model 返回 400）：
- `prompt` 去空白后非空、`length <= 4000`
- `model` 不在白名单 → `{ok:false, error:"unsupported model"}`
- `removeWatermark` 缺省 `true`
- `callbackUrl` 必须是 `http:`/`https:` 且不含 `user:pass@`
- `referenceImagePaths` 只接受字符串数组，长度 `<= maxReferenceImages`
- `source` 截断到 64 字符

**Step 4:** `main.ts` 的 `/api/generate` 用 `normalizeGenerateInput(body, {defaultModel: settings.defaultModel, maxReferenceImages: MAX_REFERENCE_IMAGES})` 替换现有的 `prompt` / `normalizeModel` 两段校验；失败返回 400 + `error`。

**Step 5:** 测试通过 → commit `-m "feat: 为生成接口入参加白名单契约校验"`

---

### Task 7: 设置读写共用一套归一化

**Files:**
- Create: `electron/settings-contract.ts`
- Create: `tests/settings-contract.test.mjs`
- Modify: `electron/database.ts:498-507`（`getSettings`）、`:509-541`（`updateSettings`）

**Step 1:** 现状：`updateSettings` 已对 apiPort/布尔/URL 做了 clamp，但 `getSettings()` 只是「DEFAULT_SETTINGS + parseSettingValue」直接断言类型，**DB 里被外部改脏的值会原样流出**。新增测试验证脏值被夹回合法范围。

**Step 2:** 运行 → FAIL

**Step 3: 实现** `electron/settings-contract.ts`

```ts
export function normalizeSettings(raw: Record<string, unknown>): AppSettings
```
逐字段归一化（缺失取 `DEFAULT_SETTINGS`）：
- `apiPort` → `clampPort`；`generationTimeoutSeconds` → clamp `[60, 3600]`
- `miniCost` / `fastCost` / `dailyQuotaLimit` → clamp `[0, 1000]` 整数
- `maxConcurrentAccounts` → clamp `[1, 20]`；`retryCount` → clamp `[0, 10]`
- `dailyResetTime` → 匹配 `/^\d{2}:\d{2}$/` 否则回落默认
- 布尔字段 → `Boolean()`；URL 字段 → 非空字符串否则回落默认
- `defaultModel` → 白名单，非法回落 `DEFAULT_SETTINGS.defaultModel`

**Step 4:** `getSettings()` 改为 `return normalizeSettings(data)`；`updateSettings()` 落库前也过一遍 `normalizeSettings(next)`（幂等），删除与 `normalizeSettings` 重复的逐字段 clamp（DRY）。

**Step 5:** 全量测试 + `npm run typecheck` 通过 → commit `-m "feat: 设置读写共用一套白名单归一化"`

---

## 验收

```bash
npm run typecheck
npm run test:unit
```

- 新增测试全绿，既有 4 个测试文件不被破坏
- `git --no-pager log --oneline` 应有 7 个新 commit
- `docs/CHANGELOG.md` 追加 0.1.31 条目（行为级：会员/风控拦截即时失败、失败分类决定退款、控件就绪门禁、接口入参校验、设置脏值归一化）
