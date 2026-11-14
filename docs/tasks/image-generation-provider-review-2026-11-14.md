# 生图供应商逐模型核对

核对日期：2026-11-14（北京时间）。范围为 RavenCat 当前登记的 5 家供应商、15 个模型，以及用户生图页和 AI `generate_image` 共用的执行链路。

## 验证范围

本记录区分三类证据：官方文档与模型目录、本机模拟 HTTP 的协议行为测试、不带凭据和提示词的空请求路由检查。本次没有进行真实计费出图，不能据此确认特定账号的模型开通、余额、地域权限、内容审核、网络可达性或服务端稳定性。

页面与 AI 工具均进入 `PrepareGeneratedImage`，固定模型快照、检查本次参数与供应商上传限制，再调用 Platform 的供应商适配。返回图片经既有下载与真实图片检查后，页面写相册，AI 工具提交角色私有媒体引用。没有复制业务流程、自动探测其他协议或失败重放。

## 逐模型结果

下表的“通过”指请求映射、响应解析与公开参数组合的本地验证通过，不表示服务端实际生成成功。

| 供应商 | 完整模型 ID | 当前支持的输入／关键契约 | 核对结果 |
| --- | --- | --- | --- |
| 硅基流动 | `Tongyi-MAI/Z-Image` | 仅文生图；`image_size` | 通过 |
| 硅基流动 | `Tongyi-MAI/Z-Image-Turbo` | 仅文生图；`image_size`；不覆盖服务端步数 | 通过 |
| 硅基流动 | `Qwen/Qwen-Image` | 仅文生图；官方推荐尺寸、50 步与 CFG 4 | 通过 |
| 硅基流动 | `Qwen/Qwen-Image-Edit` | 必须一张参考图；不发送 `image_size` | 通过 |
| 硅基流动 | `Qwen/Qwen-Image-Edit-2509` | 当前接入一张参考图；不发送 `image_size` | 通过 |
| 硅基流动 | `Kwai-Kolors/Kolors` | 文生图或参考图；已接入 1:1／3:4／9:16 | 通过 |
| MiniMax | `image-01` | 文生图或人物参考；尺寸在 512–2048 且为 8 的倍数 | 通过 |
| MiniMax | `image-01-live` | 文生图或人物参考；不发送自定义宽高，不开放 21:9 | 通过 |
| Seedream | `doubao-seedream-4-5-251128` | 文生图或参考图；2K／4K；关闭组图 | 协议通过；已停止新购，即将关停 |
| Seedream | `doubao-seedream-5-0-flash-260915` | 文生图或参考图；1K／1.5K／2K；不发送组图参数 | 修正后通过；新建默认模型 |
| 阿里百炼 | `qwen-image-2.1-pro` | 原生 DashScope 同步；文生图或参考图 | 修正后通过 |
| 阿里百炼 | `qwen-image-2.1-turbo` | 原生 DashScope 同步；文生图或参考图 | 修正后通过 |
| OpenAI | `gpt-image-2.5-flare` | JSON 文生图、multipart 编辑；各自的 SSE 事件 | 修正后通过 |
| OpenAI | `gpt-image-2.5-sunburst` | JSON 文生图、multipart 编辑；各自的 SSE 事件 | 修正后通过 |
| OpenAI | `gpt-image-2` | JSON 文生图、multipart 编辑；各自的 SSE 事件 | 修正后通过 |

硅基流动模型身份对照[官方模型价格目录](https://siliconflow.cn/pricing)，字段与响应对照[图片生成 API](https://api-docs.siliconflow.cn/docs/api/images-generations-post)；Z-Image-Turbo 的基础调用对照[官方接入示例](https://www.siliconflow.com/blog/z-image-turbo-now-on-siliconflow-photorealistic-bilingual-text-rendering)。MiniMax 使用中国区[文生图契约](https://platform.minimax.cn/docs/api-reference/image-generation-t2i.md)和[图生图契约](https://platform.minimax.cn/docs/api-reference/image-generation-i2i.md)，不把国际区目录误当成中国区可用模型列表。

Seedream 对照[图片生成 API](https://console.volcengine.com/ark/region:cn-beijing/docs/image-generation-api)与[模型列表](https://console.volcengine.com/ark/region:cn-beijing/docs/model-list)；千问对照[原生同步协议](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)。OpenAI 对照[图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[编辑接口](https://developers.openai.com/api/reference/typescript/resources/images/methods/edit)和[编辑流式事件](https://developers.openai.com/api/reference/resources/images/edit-streaming-events)。只使用当前已接入的功能子集，不因官方提供更多能力而自动开放新参数。

## 本次修正

1. 百炼原先把 `/images/generations` 拼到旧域名的兼容路径，真机返回 404。改为同一服务域名下的原生同步路径，并映射 `input.messages`、`parameters.size` 和 `output.choices`；原资产与 Key 保持可用。
2. Seedream 5.0 Flash 不支持 `sequential_image_generation`；该字段只在现有 4.5 请求中发送，Flash 依靠其原生单图契约。
3. OpenAI 编辑流使用 `image_edit.partial_image`／`image_edit.completed`，原解析器只识别生成事件，可能丢弃已生成的编辑结果。现在根据本次请求种类解析对应事件，错误种类的流与缺少最终图片仍明确失败。
4. 参考图沿用入口已经获得的真实尺寸和体积，在计费前检查供应商额外限制；不再次读取或解码同一文件。MiniMax 小于 10 MB，千问不超过 10 MB 且单边不超过 8000、长短边比不超过 10:1，Seedream 不超过 30 MB 且总像素不超过 3600 万、每边大于 14、长短边比不超过 16:1，OpenAI 小于 50 MB。MB 按 1,000,000 字节执行。
5. 新建 Seedream 配置优先 Flash，避免默认选到已经停止新购的 4.5；不自动更换已有配置中的模型。

## 不计费路由检查

使用空 JSON，不携带 API Key、提示词或图片，不跟随重定向。

| 实际请求地址 | 观测结果 |
| --- | --- |
| `https://api.siliconflow.cn/v1/images/generations` | HTTP 401，进入 Token 校验 |
| `https://api.minimax.cn/v1/image_generation` | HTTP 200，`base_resp.status_code=1004`，明确缺少 Key |
| `https://ark.cn-beijing.volces.com/api/v3/images/generations` | HTTP 401，`AuthenticationError` |
| `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` | HTTP 401，`InvalidApiKey` |
| `https://api.openai.com/v1/images/generations` | HTTP 401，缺少鉴权 |
| `https://api.openai.com/v1/images/edits` | HTTP 401，缺少鉴权 |

上述结果只证明路径可达鉴权层，不能证明模型对特定账号开放。

## 自动验证

- `node scripts/verify-image-generation.mjs`：通过，覆盖所有 15 个模型、510 组参数／参考图组合；检查各协议路径、尺寸范围、字段适用性、单次请求、响应解析和诊断脱敏。另覆盖三个 GPT Image 模型在 PNG／JPEG／WebP 下的编辑流、分块事件、取消与缺少最终图片。
- 参考图限制的边界值与超限输入通过；不满足供应商契约时，在读取 Base64 和发起请求前失败。
- 原有生图页面、相册保存重试、私有媒体归属、取消与提交资格回归通过。
- `npm run typecheck`、修改文件 ESLint、`npm run architecture:aliases`、`npm run architecture:check`：通过。
- 未构建 APK，未修改手机数据或保存的凭据。

## 服务端限制与待实测范围

Seedream 4.5 已于 2026-09-24 停止新购，官方计划于 **2026-11-24 14:00（北京时间）**关停，图片模型不会自动迁移。已有使用者需要显式改选可用模型；应用侧不能修复供应商退役。依据：[方舟模型下线公告](https://docs.volcengine.com/docs/ark/model-deprecation-notice?lang=zh)。

OpenAI 的部分高分辨率自定义尺寸被官方标记为实验能力；本次检查其倍数、边长、宽高比和总像素仍在允许区间，不等同于各尺寸的服务端出图验收。GPT Image 还可能要求组织验证。其他供应商也需要账号开通对应模型。实际图片质量、生成耗时、特定账号可用性与真机网络仍需真实出图才能确认。
