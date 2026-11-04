# AI 文生图功能完整实施方案

> 状态：待实施
>
> 本文是首版文生图功能的实施契约，不描述当前已经存在的能力。实施前先阅读 `AGENTS.md`、`REPOSITORY_WORKFLOW.local.md`、`docs/architecture/auxiliary-model-selection.md`、`docs/architecture/ai-message-delivery-invariant.md` 与 `src/features/media/README.md`。

## 1. 目标与首版决策

首版提供以下真实产品流程：

```text
用户在辅助模型中心配置并选择一个生图模型
→ AI 在单聊、群聊或允许使用聊天工具的自主任务中调用 generate_image
→ 所选服务生成一张图片
→ 图片进入应用私有 MediaAsset 媒体库
→ 工具返回 mediaAssetId
→ AI 可继续调用 send_image，把图片作为真实聊天消息发送
```

首版固定采用这些决策：

1. 生图模型作为辅助模型中心的新用途，类型标识为 `image_generation`。
2. 生图模型选择是 **Media 持有的全局明确选择**，所有角色共用；首版不做角色级选择。
3. 首版只支持一种协议：**OpenAI 兼容的同步图片生成接口**，一次请求生成一张图片。
4. `generate_image` 只负责生成和持有媒体素材，不直接创建聊天消息。
5. `send_image` 继续拥有图片消息 intent，Chat 继续拥有消息提交、时间线和 delivery。
6. 首版工具只接收提示词和可选文件名，尺寸、质量、风格等参数使用服务商默认值，不制造跨提供方统一参数。
7. 首版不提供独立生图页面、生成历史相册、图生图、局部编辑、多图批量生成或异步任务查询。

## 2. 当前基础与缺口

### 2.1 可复用基础

- Assistants 已拥有辅助模型资产、服务连接、自动保存、可用性解析、首次初始化和用途路由。
- `ConfiguredModelPicker` 已支持业务 owner 自己保存明确选择，STT 与 translation 已提供列表内选择范例。
- Platform 已拥有 Base URL 规范化、错误映射、取消和 HTTP 诊断基础。
- Media 已拥有私有文件、图片解码验证、MediaAsset 去重、业务引用、备份、回收和任务 fence。
- Chat 已拥有 `send_image`，可消费 MediaAsset 并在当前回合提交真实图片消息。
- Host 已拥有唯一 Built-in Tool 注册表、工具权限和模型运行提示词装配。

### 2.2 必须新增的缺口

- `image_generation` 能力类型及其列表、表单和连接测试分支。
- Media 的全局模型选择存储、查询、保存和运行时解析。
- OpenAI 兼容图片生成客户端及响应边界校验。
- 生成图片的 Base64 暂存或 URL 下载、MediaAsset 提交及生成业务引用。
- `generate_image` 工具、Host 装配、权限元数据与提示词说明。
- 新表的 SQLite 升级、旧备份恢复兼容和媒体引用闭合。

## 3. 所有权与依赖方向

| 能力 | Owner | 责任 |
| --- | --- | --- |
| 生图模型资产 | Assistants | 名称、用途、模型 ID、服务引用、连接与资产 CRUD |
| 当前生图模型选择 | Media | 全局 `modelConfigId`、选择状态、取消选择与运行解析入口 |
| 图片生成协议 | Platform AI | HTTP 请求、取消、错误边界、响应结构校验 |
| 图片文件与生成记录 | Media | 暂存、下载、解码、MediaAsset、生成引用和生命周期 |
| 工具注册与跨 Feature 装配 | Host | 注入模型解析、仓储、任务 fence，注册工具和权限 |
| 图片消息 | Chat | 消费既有 `send_image` intent，提交消息与时间线 |
| 页面路由 | App / Host | 复用现有动态 auxiliary-models 路由 |

依赖约束：

- Media 不导入 Assistants 的 Repository、SQLite adapter 或内部 runtime。
- Host 将 `getAuxiliaryModelSelection`、`requireAuxiliaryModel`、`resolveAuxiliaryModel` 注入 Media 的选择端口。
- Assistants 的用途导航可以通过 `@features/media` 公共根出口挂载 `ImageGenerationModelPicker`，沿用 STT、translation 的现有组合方式。
- Platform 不依赖 Media、Assistants 或 Chat。
- 不新增 App 页面路径；现有 `[kind]` 与 `[modelId]` 路由继续工作。

## 4. 辅助模型中心方案

### 4.1 能力注册

在 `CAPABILITY_KINDS` 与 `CAPABILITY_META` 增加：

```text
image_generation
名称：生图模型
说明：用于 AI 文生图；所有角色共用此处选择的当前生图模型
```

同时更新 `SQLiteAuxiliaryModelRepository.listModelConfigs` 中当前有效能力类型的显式集合。只增加新类型，不恢复任何历史退休类型。

`auxiliary_model_configs.capability_kind` 当前没有枚举 CHECK，因此新增用途不要求重建资产表。模型资产继续使用：

- `service_config_id` 或未收录连接的地址与 Key；
- `model`；
- `metadata_json = null`；
- `temperature`、`top_p`、`max_tokens = null`。

`supportsModelService` 对普通新类型默认复用通用服务，首版无需增加专用提供方分支。

### 4.2 模型池

生图模型池复用 `AuxiliaryModelPoolScreen`，顶部插入：

```tsx
<ImageGenerationModelPicker />
```

选择器复用 `ConfiguredModelPicker`，标题为“当前生图模型”，支持：

- 只列出类型匹配且连接完整的生图资产；
- 显示当前选择；
- 改选后立即影响下一次生成；
- 用户取消后保持空选择；
- 当前引用被删除或变得不完整时保留 ID，并显示不可用原因；
- 不自动改选第二个模型。

### 4.3 新建与编辑表单

复用 `AuxiliaryModelEditScreen` 的连接、服务选择、模型发现、自动保存和创建流程，不复制整页表单。

对 `image_generation`：

- 显示配置名称、API 地址、API Key、服务连接和模型 ID；
- 模型 ID 允许手工输入，也可从既有模型列表中选择；
- 模型列表不代表接口能力证明，帮助文案明确“请选择支持图片生成的模型”；
- 不显示 Temperature、Top P、Max Tokens；
- 草稿提交将这些采样字段写为 `null`；
- 沿用已有资产自动保存、新资产显式创建、字段错误恢复与返回 flush。

只有出现真实且无法用局部能力分支表达的表单差异时，才拆独立页面；首版不预先复制一套编辑表单。

### 4.4 测试生成

生图模型不能复用聊天 `/chat/completions` 测试，也不能只凭 `/models` 列表判定生图可用。

点击生图表单的“测试生成”后：

1. 校验当前合法草稿，不自动保存、不创建资产、不改变选择。
2. 明确提示“将实际调用服务生成一张图片，可能产生费用”，由用户确认后继续。
3. 使用固定、短小的安全测试提示词，请求一张图片。
4. 校验接口确实返回一个可用图片内容对象。
5. 成功结果显示“接口已返回图片”，失败显示现有脱敏错误信息。
6. 测试结果不创建 MediaAsset、不发送消息、不进入生成历史；URL 不额外下载，Base64 不持久化。

测试生成只执行一次请求，不因认证、参数、配额或服务错误自动重试。

## 5. Media 模型选择契约

新增 `ImageGenerationModels` 应用端口，行为对齐现有 translation 选择：

```ts
interface ImageGenerationModelsDependencies {
  repository: ImageGenerationSettingsRepository;
  getSelection(modelConfigId: string | null): Promise<ModelSelectionSettings>;
  requireModel(modelConfigId: string): Promise<void>;
  resolveModel(modelConfigId: string): Promise<ResolvedImageGenerationModel | null>;
}

interface ResolvedImageGenerationModel {
  modelConfigId: string;
  modelConfigUpdatedAt: string;
  baseURL: string;
  apiKey: string;
  model: string;
}
```

公开行为：

```text
getImageGenerationModelSettings()
selectImageGenerationModel(modelConfigId | null)
resolveImageGenerationModel()
subscribeImageGenerationModelsChanged()
notifyImageGenerationModelsChanged()
```

规则：

- `null` 是明确的未选择状态，不表示跟随聊天模型或 OCR。
- 选择非空资产前先经过 `requireModel(id, 'image_generation')`。
- 执行时读取一次选择并解析成快照，本次请求使用该快照。
- 未选择与引用失效分别报错。
- 模型资产变更后继续复用 `subscribeAuxiliaryModelsChanged`，由 Host 发出 Media 选择投影刷新信号。
- 修改模型不打断已经开始的请求；下一次工具调用读取新选择。

### 5.1 首次初始化

在 Host 的 `configureAuxiliaryModelInitialization` 增加 `image_generation` 分支：

- 首个完整可用的生图资产创建时，在同一事务中只填充 Media 的空选择。
- 复用 `auxiliary_model_initial_defaults` 的唯一 claim 与 initialized 标记。
- 用户后来取消选择，不被后续新建或编辑资产重新填回。
- 后续新增资产不覆盖已有选择。
- 生图是全局选择，不加入新角色初始化，不向既有角色复制配置。

## 6. Platform 图片生成协议

### 6.1 客户端边界

新增独立的 OpenAI 兼容图片生成客户端，不把图片协议塞进聊天消息类型，也不改变现有聊天、流式和向量调用。

客户端复用：

- `normalizeAIBaseURL`；
- API Key Bearer 认证；
- 现有错误显示与脱敏；
- `AbortSignal`；
- 现有 HTTP 诊断能力。

首版请求：

```http
POST {normalizedBaseURL}/images/generations
Content-Type: application/json
Authorization: Bearer <apiKey>
```

```json
{
  "model": "<resolved model>",
  "prompt": "<tool prompt>",
  "n": 1
}
```

不主动附加聊天采样参数、尺寸、质量、响应格式或流式字段。

### 6.2 响应契约

```ts
type GeneratedImageContent =
  | { kind: 'base64'; base64: string }
  | { kind: 'url'; url: string };

type ImageGenerationResult =
  | { success: true; image: GeneratedImageContent }
  | { success: false; error: string; httpStatus: number | null };
```

校验规则：

1. HTTP 非成功状态进入现有外部错误边界，保留状态并脱敏。
2. 成功响应必须是对象，`data` 必须是只含一项的数组。
3. 每项接受非空 `b64_json` 或非空 HTTPS `url`。
4. 两项同时存在时优先 `b64_json`，避免额外网络请求。
5. 空数组、多项结果、空内容、无效 JSON 或两种内容都缺失，按 `invalid_response` 处理。
6. 不根据模型名、错误文本或提供方名称切换其他端点。
7. 取消错误继续抛出，不能包装成可重试的生成失败。

首版不解析或持久化 revised prompt、任务 ID、签名 URL、用量字段等没有真实 consumer 的数据。

## 7. `generate_image` 工具

### 7.1 输入与输出

```ts
interface GenerateImageInput {
  prompt: string;
  file_name?: string;
}

interface GenerateImageData {
  mediaAssetId: string;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}
```

参数约束：

- `prompt` 去除首尾空白后不能为空，设置与其他工具一致的合理长度上限。
- `file_name` 可选，只用于媒体与消息显示，不作为文件路径。
- 首版没有 `size`、`quality`、`style`、`n` 或 `on_success` 参数。

工具说明必须明确：

- 使用辅助模型中心当前选择的生图模型；
- 成功只表示图片已保存到应用私有媒体库；
- 返回的 `mediaAssetId` 可交给 `send_image` 发送，或交给 `view_image` 查看；
- 生成成功不等于已经发送，也不等于主模型已经看过图片；
- 未配置或配置失效时明确失败，不自动换模型。

### 7.2 执行链路

```text
检查 abortSignal
→ resolveImageGenerationModel() 固定本次模型快照
→ Platform 请求 /images/generations
→ 取得 base64 或 URL 内容
→ 准备本地暂存图片
→ inspectLocalImage 验证真实容器、解码、MIME 与尺寸
→ createMediaAssetWithReference
   ├─ 事务外准备持久 backing、hash 与复用裁决
   └─ 同一独占事务
      ├─ selectOrCreate MediaAsset
      ├─ assertImageToolRunCurrent
      └─ 插入 ai_generated_images 业务引用
→ 清理暂存文件
→ 返回 mediaAssetId 与真实图片 metadata
```

### 7.3 Base64 与 URL 两条准备路径

两条路径只在“如何得到本地暂存文件”上不同，之后共用同一媒体链路。

**Base64：**

- 在事务外写入应用暂存文件；
- 不信任服务商声明的扩展名或 MIME；
- 由 `inspectLocalImage` 识别真实格式并验证解码；
- 无论成功或失败都尝试清理暂存文件。

**URL：**

- 复用 `downloadWebImage` 的公开 HTTPS、DNS、重定向和取消边界；
- 立即下载，避免签名 URL 过期；
- 不把 URL 写入生成记录或聊天正文；
- 沿用现有下载暂存清理方式。

若省略文件名，在真实 MIME 确认后生成带正确扩展名的默认名称。内容去重由 MediaAsset 既有 hash 与复用逻辑负责；即使复用已有 asset，也插入本次角色自己的生成引用。

### 7.4 工具结果与错误

预期的外部或文件失败转换为模型可理解的 tool error，例如：

| 场景 | 建议 code | retryable |
| --- | --- | --- |
| 未选择生图模型 | `IMAGE_GENERATION_UNCONFIGURED` | false |
| 所选配置失效 | `IMAGE_GENERATION_MODEL_UNAVAILABLE` | false |
| 提示词为空 | `IMAGE_GENERATION_PROMPT_REQUIRED` | false |
| 认证、权限、配额、限流、服务错误 | 沿用明确分类 | 按既有错误契约 |
| 响应没有有效图片 | `IMAGE_GENERATION_INVALID_RESPONSE` | false |
| 返回图片无法解码 | `IMAGE_UNREADABLE` | false |
| URL 下载被网络安全边界拒绝 | 沿用下载错误 | false |

数据库错误、内部不变量失败与任务 fence 冲突继续暴露给 Agent Runtime，不伪装成服务商失败。

`generate_image` 不设置 `fulfillsUserVisibleOutput`，因为它没有产生用户可见消息。真正发送仍由 `send_image` 的既有 completion intent 裁决。

## 8. SQLite 设计

以当前 schema 167 为基线，实施时若版本已经前进则顺延编号；以下以 168 表示本次迁移。

### 8.1 全局模型选择

```sql
CREATE TABLE IF NOT EXISTS media_image_generation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model_config_id TEXT
);

INSERT OR IGNORE INTO media_image_generation_settings(id) VALUES (1);
```

`model_config_id` 故意不建外键：删除资产后仍需保留失效引用 ID，供选择器展示原因；只有用户取消或改选才改写它。

默认记录加入 `DEFAULT_RECORDS_SQL`，保证新安装、升级和快照恢复后单行存在。

### 8.2 生成业务引用

```sql
CREATE TABLE IF NOT EXISTS ai_generated_images (
  id TEXT PRIMARY KEY NOT NULL,
  assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_generated_images_assistant_created
  ON ai_generated_images(assistant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_generated_images_media_asset
  ON ai_generated_images(media_asset_id);
```

首版该表的真实职责是持有角色对生成图片的持久引用，不兼任历史展示或审计数据库。因此只保存当前生命周期需要的字段，不预先保存提示词、API Key、签名 URL、服务商原始响应或模型参数快照。

### 8.3 迁移要求

- 新安装通过 `SCHEMAS` 一次创建两张表与索引。
- 旧库升级到 168 时只新增上述结构，不改写既有模型资产和业务选择。
- 将 167 纳入允许升级的旧版本判断，不改变其他历史版本策略。
- schema、默认记录与 `PRAGMA user_version` 在同一事务提交。
- 任一步失败整笔回滚，不留下半张表或错误版本标记。
- 不创建虚拟生图资产，不在升级时自动选择已有 OCR 或聊天模型。

## 9. 媒体生命周期、备份与删除

新增引用类型：

```ts
'ai_generated_image'
```

必须同时接入以下位置，不能只插入生成记录：

1. 当前数据库完整引用查询：加入 `ai_generated_images.media_asset_id`。
2. targeted release 的无引用裁决：生成记录存在时不得回收 asset。
3. `listAssistantMediaAssetIds`：角色删除前，在同一事务收集该角色生成图片候选。
4. 角色删除：生成记录随 `assistant_id` 级联删除，commit 后按全部 live 引用裁决 backing 是否释放。
5. 备份媒体枚举：生成记录持有但尚未发送的图片也必须进入备份。
6. 恢复预检与完整 SQLite 快照：选择、生成记录、媒体和版本标记一起恢复。
7. 恢复出厂与媒体审计：沿用全库和私有媒体根目录清理，不建立额外清理路径。

### 9.1 旧备份查询兼容

`listReferencedAssetsForBackup` 会在 staging 快照升级前按旧 `user_version` 选择引用查询。不能直接把新表拼进所有 165 及以上备份共用的 SQL。

实施时：

- 保留旧版本使用的既有引用查询，不引用 `ai_generated_images`。
- 为当前数据库与 168 及以上快照使用包含生成引用的新查询。
- 增加 `version >= 168` 的明确分支，再继续落到既有版本分支。
- 使用当前仍受支持的最近旧版本快照做恢复预检回归，至少覆盖 166、167；这些快照没有生图表时不能因新查询失败。
- 不改变 165 及其他历史版本现有的支持或拒绝策略；168 快照必须带回生成图片。

这是本次媒体引用扩展的必需兼容，不通过 try/catch、缺表忽略或恢复后补扫掩盖。

## 10. 取消、竞态与事务边界

### 10.1 事务外

允许执行：

- 模型选择与配置读取；
- AI HTTP 请求；
- 图片 URL 下载；
- Base64 暂存；
- 图片检查、hash 和 backing 准备。

事务内只允许：

- MediaAsset 查询或写入；
- 当前任务持久 fence 检查；
- 生成业务引用写入；
- 必要的 row mapping 与不变量检查。

禁止在事务内请求网络、写图片文件、等待 UI 或发布跨 Feature 事件。

### 10.2 取消与过期任务

- HTTP、URL 下载及提交前均检查 `abortSignal`。
- 在 MediaAsset 与生成引用提交的同一事务调用 `assertImageToolRunCurrent`。
- 单聊沿用 Chat reply run fence，群聊沿用群任务 fence，自主任务继续服从自身取消信号。
- 若任务在生成途中被取消或被取代，不提交生成业务事实；MediaAsset 准备流程按既有补偿删除未提交 backing。
- 外部服务已经完成的生成无法撤销，取消后不自动重试、不自动发送。

### 10.3 模型切换与重复执行

- 每次工具调用固定一次模型快照，不在请求中途重新解析。
- 模型切换只影响下一次调用，不增加运行中请求撤销系统。
- 工具标记为非幂等，运行时不自动重放计费生成。
- 不使用调用点 sleep、随机延迟、重试或备用模型解决冲突。
- 若提交失败，按真实错误结束；不重新发起第二次外部生成来“补偿”。

## 11. Host 工具注册与提示词

在唯一 Built-in Tool 注册表加入：

```text
name: generate_image
owner: media
execution: agent_native
risk: external_side_effect
idempotency: not_idempotent
directChatOnly: true
groupChatAllowed: true
callForbidden: false（通话已由 directChatOnly 排除）
defaultEnabled: true
```

工具继续受以下既有策略约束：

- AI 总工具开关；
- 角色工具权限；
- 单聊、群聊和自主任务场景；
- Host 的唯一注册与 schema 派生。

首版采用静态注册，不增加按模型选择动态增删 schema 的第二套暴露机制。未配置时工具返回明确错误。

更新 `buildToolsDescription`：

- `generate_image` 用于通过当前生图模型创建一张新图片；
- 返回 `mediaAssetId`；
- 生成后可使用 `send_image` 发送，使用 `view_image` 查看；
- 正文中的 Markdown 图片链接不等于已经生成或发送；
- 不重复描述既有 `send_image` 的消息提交规则。

Chat 不新增生成消息 intent、时间线项目、持久化函数或 delivery 分支。

## 12. 错误、隐私与外部边界

- API Key 只存在于现有模型服务或资产凭据边界，不进入工具输入输出、生成记录或普通日志。
- 外部错误离开 Platform 前脱敏，不能回显 Bearer Key。
- 签名图片 URL 只作为瞬时响应和下载输入，不写入业务数据库或聊天正文。
- 提示词会发送给用户选择的第三方服务；模型池帮助与测试确认应说明费用和网络调用性质。
- 生成图片不写入系统相册，继续使用应用私有媒体库。
- 不用 OCR 模型、聊天模型名或模型列表能力声明猜测生图支持。
- 不为认证、权限、配额、内容拒绝或服务错误自动切换模型、改写提示词或重复生成。
- 首版内容审核完全由所选服务与现有产品边界负责，不新增本地隐式二次生成或审核流程。

## 13. 预计修改位置

### Assistants

```text
src/features/assistants/domain/AuxiliaryModel.ts
src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts
src/features/assistants/presentation/auxiliaryModels/constants.ts
src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelNavigator.tsx
src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelEditScreen.tsx
src/features/assistants/presentation/auxiliaryModels/auxiliaryModelDraft.ts
src/features/assistants/TestAuxiliaryModelConnection.ts
src/features/assistants/README.md
```

### Media

```text
src/features/media/domain/ImageGenerationSettingsRepository.ts
src/features/media/domain/AIGeneratedImageRepository.ts
src/features/media/application/ImageGenerationModels.ts
src/features/media/application/GenerateImageTool.ts
src/features/media/application/AIImageRuntime.ts
src/features/media/infrastructure/SQLiteImageGenerationSettingsRepository.ts
src/features/media/infrastructure/SQLiteAIGeneratedImageRepository.ts
src/features/media/infrastructure/SQLiteMediaAssetRepository.ts
src/features/media/presentation/ImageGenerationModelPicker.tsx
src/features/media/index.ts
src/features/media/composition.ts
src/features/media/README.md
```

如生成工具与现有 `AIImageTools.ts` 仍保持清晰，也可将工具放入该文件，而不是为单一工具机械增加层次。

### Platform 与持久化

```text
src/platform/ai/OpenAIImageGenerationClient.ts
src/platform/ai/types.ts
src/platform/ai/index.ts
src/platform/persistence/sqlite/aiImageSchema.ts
src/platform/persistence/sqlite/schema.ts
src/platform/persistence/sqlite/defaultRecords.ts
src/platform/persistence/sqlite/migrations.ts
```

### Host

```text
src/host/composition/configureAIRuntime.ts
src/host/composition/configureAIImageTools.ts
src/host/composition/configureAuxiliaryModelInitialization.ts
src/host/composition/agent/createAgentToolRegistry.ts
```

### 文档与验证

```text
docs/architecture/auxiliary-model-selection.md
docs/tasks/ai-image-generation-plan.md
scripts/verify-auxiliary-model-runtime.mjs
scripts/verify-ai-image-tools.mjs
scripts/verify-media-asset-*.mjs（只改真实涉及项）
相关备份恢复验证脚本
```

App 动态路由无需修改。若实际实施发现必须增加公共出口或依赖方向，应先按所有权调整装配，不通过跨 Feature 私有导入绕过。

## 14. 实施顺序

### 阶段一：能力资产与业务选择

1. 增加 `image_generation` 类型、列表元数据、仓储过滤与表单能力分支。
2. 增加 Media 全局选择表、Repository、应用端口和选择器。
3. 完成 Host 选择解析、变更信号与首次初始化装配。
4. 完成新装、升级、取消、改选、失效引用与首次初始化验证。

### 阶段二：生成协议与媒体提交

1. 实现 OpenAI 兼容图片生成客户端与响应校验。
2. 实现 Base64／URL 到本地暂存的两条准备路径。
3. 增加生成业务引用表及 MediaAsset 引用闭合。
4. 实现 `generate_image` 的模型快照、取消、事务 fence 和暂存清理。
5. 完成真实 SQLite 与文件生命周期验证。

### 阶段三：工具与产品整合

1. 注册工具、权限元数据与提示词。
2. 接入 Host 图片 runtime 和模型解析。
3. 完成测试生成流程与费用确认。
4. 验证生成后复用 `send_image`，不修改 Chat 消息提交所有权。

### 阶段四：备份、文档与验收

1. 完成版本化备份引用查询和旧快照恢复验证。
2. 更新辅助模型与 Media 当前架构文档，把本计划中的稳定契约同步到对应 owner 文档。
3. 运行与改动范围匹配的检查和专项验证。
4. 使用真实服务与 Android 设备验收；未经明确要求不构建完整 APK。

## 15. 验证方案

测试真实行为、外部协议边界和长期所有权，不断言源码字符串、函数体或内部调用顺序。

### 15.1 模型资产与选择

- 创建、自动保存、列表展示和服务复用。
- 生图资产不保存聊天采样参数。
- 首个可用资产只初始化一次空选择。
- 用户取消后不被后续资产重填。
- 改选影响下一次调用；进行中的请求保留原快照。
- 删除、类型不匹配和连接不完整显示失效原因。
- 新角色创建不改写全局选择。

### 15.2 图片协议

- 正确构造 `/images/generations` 请求与 Bearer 认证。
- Base64、URL、两者同时存在、空数组、多项、缺字段和无效 JSON。
- HTTP 认证、权限、配额、限流、服务和参数错误脱敏。
- 请求取消不转成普通失败，不自动重试。
- 测试生成不写资产、不改选择、不创建 MediaAsset。

### 15.3 媒体与工具

- Base64 暂存、真实格式识别、解码失败与清理。
- URL 下载复用公共网络安全边界，不保存签名 URL。
- MediaAsset 与生成引用同事务提交。
- 内容复用时仍创建当前角色的生成引用。
- 未配置、失效模型和空提示词返回明确工具错误。
- 取消、单聊 supersede、群任务 supersede 不提交生成事实。
- 生成结果不自动发消息；同一 `mediaAssetId` 可由既有 `send_image` 消费。

### 15.4 生命周期与迁移

- 167 → 168 升级、事务回滚、重复启动和新安装。
- 生成引用参与完整审计与 targeted release。
- 角色删除后，未被其他引用持有的生成图片可回收；仍被消息等引用的文件保留。
- 当前仍受支持的 166、167 旧快照预检不查询生图表，历史版本支持策略保持不变。
- 168 快照恢复选择、生成记录与私有文件。
- 恢复出厂清理不遗留生成引用或私有文件。

### 15.5 建议执行的检查

按最终实际改动文件选择，不机械运行全库验证：

```bash
npm run typecheck
npx eslint <本次修改文件>
npm run architecture:aliases
npm run architecture:check
npm run architecture:sqlite
npm run architecture:cycles
npm run verify:auxiliary-model-runtime
npm run verify:ai-image-tools
npm run verify:media-assets
npm run verify:backup-artifact
npm run verify:backup-restore
npm run verify:application-data-reset
npm run verify:database-baseline
```

真实服务生成质量、费用、签名 URL 下载和 Android 私有文件行为单独验收，不用模拟结果冒充真机通过。

## 16. 首版完成标准

只有同时满足以下条件才算完成：

1. 用户能在辅助模型中心创建、编辑、删除和选择生图模型。
2. 测试生成使用真实图片协议，且有费用确认。
3. AI 能通过 `generate_image` 得到可持久解析的 `mediaAssetId`。
4. 未选择或配置失效时明确失败，不静默使用其他模型。
5. 生成图片能通过现有 `send_image` 成为真实单聊或群聊图片消息。
6. 取消和过期任务不能提交生成业务事实。
7. 生成图片被引用闭合、角色删除、备份与恢复正确覆盖。
8. 当前支持的旧备份恢复不受新表影响，历史版本支持策略没有被扩大或收窄。
9. 没有新增第二套聊天提交、消息 delivery、媒体 catalog 或模型资产体系。
10. 相关验证按真实结果通过，独立问题如实报告。

## 17. 明确不在首版范围内

- 角色级生图模型选择与自动继承。
- 图生图、参考图、局部重绘、遮罩和图片编辑。
- 自定义尺寸、质量、风格、负面提示词的跨提供方统一抽象。
- 异步任务提交与轮询、进度消息、后台生成队列。
- 一次多张、批量生成与自动多图发送。
- 独立生图工作台、历史管理页、相册导出或生成记录检索工具。
- 自动重试、自动换模型、自动改写提示词或内容拒绝后的二次生成。
- 为假设中的第二套图片协议预先建立复杂 Provider 框架。

这些能力只有在出现真实产品需求与 consumer 后，才基于首版稳定边界单独设计。
