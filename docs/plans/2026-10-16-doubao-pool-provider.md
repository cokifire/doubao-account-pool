# doubao-pool Provider 接入设计

日期：2026-10-16
范围：`doubao-account-pool`（本仓库，本地 HTTP 服务）与 `waoo-video`（`../waoo-video`，新增 Provider）

## 背景

`video-model-interface-contract.json` 描述的是 waoo-video 内部视频模型层的类型契约：模型以 `provider::modelId` 注册，由 Task 引擎调用 Provider adapter 执行，本身没有对外 REST。本仓库则是「本地 REST + 豆包页面自动化」的服务，两者的参数面并不一致（详见前文对比）。

目标：让 waoo-video 把本仓库当成普通 Provider 使用，调用方不需要知道背后是浏览器自动化。

## 决策

1. **两侧都改**：waoo-video 新增 Provider，本仓库只补接入文档，不动对外契约。
2. **固定模型目录**：注册 `seedance_2_0_mini` / `seedance_2_0_fast`，带 `VideoCapabilities` 与定价，UI 中直接可选；不做 BYOM。
3. **只支持单张参考图**：沿用现有 `referenceImageUrl`，不暴露多图、尾帧、音频 / 视频参考。

本仓库的 `/api/generate` 与 `/api/requests/:id` 已经满足 Provider 所需的全部语义（异步提交、状态查询、严格成功判定），因此本侧没有功能性改动。

## 架构

```
waoo-video Task 引擎
  → adapter.video.execute()          src/lib/ai-providers/doubao-pool/video.ts
      POST {baseUrl}/api/generate    multipart: model/prompt/duration/aspectRatio/source + 参考图
      返回 { success, async: true, externalId: DOUBAO_POOL:VIDEO:<providerId>:<requestId> }
  → async-task.poll()                src/lib/ai-providers/doubao-pool/async-task.ts
      GET {baseUrl}/api/requests/:requestId
      accepted|running → pending；success → completed(cleanVideoUrl||outputVideoPath)
      failed|stopped   → failed(FailureRecord)
```

新增文件（waoo-video）：`src/lib/ai-providers/doubao-pool/{config,models,pricing,external-id,video,async-task,option-schema,adapter,failure,manifest}.ts`。
改动文件：`core-manifests.ts`（注册）、`editions/self-hosted/ai.ts`（featured）、`ai-registry/api-config-catalog.ts`（中文名）。

## 关键取舍

- **时长 / 比例成对**：本接口要求成对传入，而 waoo-video 的任务信封只带 `durationSeconds`。Provider 在只收到一个时用常量补齐另一个（10 秒 / 16:9），而不是丢弃已指定的参数；两者都不传时不下发，沿用豆包默认。
- **分辨率**：豆包自行决定输出档位，Provider 不转发。但可用性投影要求每个可选模型至少有一个有报价的分辨率，故声明单一占位档位 `default`，并在注释里写明它不参与下发。
- **音频**：豆包输出固定带音轨且本服务没有开关，因此 `generateAudioOptions: [true]`，传 `false` 会得到明确的 `unsupported_value` 而不是被静默忽略。
- **generationMode**：waoo-video 的视频流水线会强制把 `generationMode` 作为能力选择项注入，能力校验要求模型必须显式声明该字段，因此能力行里必须写 `generationModeOptions: ['normal']`（只支持普通模式，不支持首尾帧）。缺少它会让提交前置检查直接失败，报 `generationMode` 不受支持。
- **固定参数**：视频模型的 `*Options` 能力字段在生成时是必填项，doubao-pool 需要在项目的模型配置里设置 `resolution=default`、`generateAudio=true`（ark 等内置视频模型同样如此）。
- **参考图**：不声明 `maxReferenceImages` 等字段（目录校验要求正整数），用「不出现 + `supportedInputModes` 不含 `reference`」表达「不支持参考」。单张首帧由执行上下文的 `imageUrl` 承载：公网 URL 交给本服务下载，`data:` URL 由 Provider 解码后 multipart 上传。
- **取消**：本服务没有取消接口，因此 Provider 不报告 `pendingPhase: 'queued'`，也就不需要实现 `cancel`；队列超时由生成超时兜底。
- **定价**：消耗的是使用者自己的豆包额度，无第三方计费，成本记 0；零售由成本按秒推导（下限 1 积分），用于计量。

## 验证

- `npm run typecheck`（waoo-video）：通过。
- `npx eslint` 新目录与改动文件：通过。
- 运行时清单校验脚本：清单通过 `validateProviderManifests`、能力目录校验、`assertEverySelectableModelIsPriced`；可用性投影保留 `text_to_video` 与 `first_frame`，`pricingLimited=false`。
- 本地假服务端联调：提交得到 `DOUBAO_POOL:VIDEO:doubao-pool:doubao-abc123`；只传时长时会补出 `aspectRatio`；`data:` URL 以文件 part 上传；两次轮询分别得到 `pending` 与 `completed`。
- 验证脚本为一次性脚本，已删除。

## 待确认

- `generateAudioOptions: [true]` 依赖「豆包输出始终带音轨」这一假设，若实际存在无声档位需改为 `[true, false]`。
- 若 waoo-video 与账号池不在同一台机器，`outputVideoPath`（本地文件路径）不可作为结果，届时应关闭本地落盘或只取 `cleanVideoUrl`。
