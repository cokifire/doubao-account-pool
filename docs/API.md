# 本地 API

## 基础信息

- 默认地址：`http://127.0.0.1:17888`
- 当前接口版本：`0.1.30`
- 默认认证：`Authorization: Bearer local-doubao-key`
- 除 `/health` 外，其余接口均需要 Bearer Token。
- 建议在“配置管理”中修改默认 API Key。

## 健康检查

```http
GET /health
```

## 查询账号

```http
GET /api/accounts
Authorization: Bearer <api-key>
```

## 提交视频生成

```http
POST /api/generate
Authorization: Bearer <api-key>
Content-Type: multipart/form-data
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 视频提示词 |
| `model` | 否 | `seedance_2_0_mini` 或 `seedance_2_0_fast` |
| `referenceImage` | 否 | 上传的参考图片文件，可重复提交多个（作为多参考图传给豆包生成） |
| `referenceImagePath` | 否 | 本机参考图片绝对路径，可填写多个（JSON 数组或逗号分隔） |
| `referenceImageUrl` | 否 | 可下载的参考图片 URL |
| `callbackUrl` | 否 | 状态变化时接收 JSON 的回调地址 |
| `source` | 否 | 请求来源名称 |
| `duration` | 否 | 视频时长，`4s`–`15s`，如 `10s`。与 `aspectRatio` 必须成对传入，都不传时沿用豆包默认参数 |
| `aspectRatio` | 否 | 视频比例，`1:1` / `3:4` / `4:3` / `9:16` / `16:9` / `21:9`。与 `duration` 必须成对传入 |

多参考图限制：最多 `10` 张，单张大小不超过 `5MB`。超出任一限制时接口返回 HTTP 400 并提示具体原因。重复提交 `referenceImage` 字段或 `referenceImagePath` 数组（最多 10 项）均会被收集为参考图列表，依次上传至豆包。

时长与比例是**成对的可选参数**：要么两个都不传（沿用豆包默认参数，行为与此前完全一致），要么两个都传。只传其中一个时接口返回 HTTP 400 `duration and aspectRatio must be provided together` —— 只传一个会让调用方以为另一个也按预期配置了，实际拿到的是豆包自己的默认值。传入但不在白名单内（如 `30s`、`1:2`）时返回 400（`unsupported duration` / `unsupported aspectRatio`），同样不会静默忽略。

配置过程遵循「只点击页面可见控件 + 每次点击后回读校验」：比例通过创作栏「比例 · 时长」组合控件选择精确选项，时长通过滑杆用真实键盘事件驱动（`Home` 回到 4s，每次右移加 1 秒）。任一步回读不到目标值、或出现会员 / 登录拦截，任务立即失败并退回预扣额度，不会带着不受控的参数提交。

`GET /api/requests/:requestId` 与回调报文会回显 `duration`、`aspectRatio`（未指定时为 `null`）。

生成请求固定执行最终 MP4 结果验证。去水印失败、平台不支持或没有取得可播放 MP4 时，任务状态为 `failed`。

## 查询任务状态

```http
GET /api/requests/:requestId
Authorization: Bearer <api-key>
```

状态：

| 状态 | 说明 |
| --- | --- |
| `accepted` | 已接收并进入队列 |
| `running` | 正在操作豆包或等待生成 |
| `success` | 已取得经过验证的 MP4 地址或本地 MP4 文件 |
| `failed` | 提交、生成、解析或 MP4 验证失败 |
| `stopped` | 任务已停止 |

## 恢复历史结果

```http
POST /api/requests/:requestId/retry-result
Authorization: Bearer <api-key>
```

该接口只重新查找并解析历史生成结果，不会再次提交视频生成，也不会重复扣除额度。

## 单独解析视频结果

```http
POST /api/watermark/parse
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "url": "<supported-source-url>"
}
```

成功时返回经过验证的 `cleanVideoUrl`；失败时返回 HTTP 422 和 `status: "failed"`。

去水印服务存在短暂的资源准备延迟。程序会先验证返回地址确实是可播放 MP4，未就绪时使用短间隔重试；重试状态会按任务顺序异步通知回调，不会阻塞视频结果解析。

## 成功语义

外部接口不会把豆包分享页、聊天页或 thread 页面地址当作视频结果。只有满足以下任一条件才返回 `status: "success"`：

- `cleanVideoUrl` 是经过验证、可访问的 MP4 视频地址。
- `outputVideoPath` 是已经保存成功的本地 `.mp4` 文件路径。
