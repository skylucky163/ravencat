# AI 生图功能实施方案

> 状态：首版与供应商／画布增强已实施，真实服务和 Android 设备验收待完成（2026-11-12）
>
> §21 为当前增量范围；它明确扩展了首版对参数、参考图和制作过程的限制，冲突时以 §21 为准。
>
> 本文是生图功能的实施契约。与旧草案冲突时以本文为准。
> 实施前先阅读 `AGENTS.md`、`REPOSITORY_WORKFLOW.local.md`、`docs/architecture/auxiliary-model-selection.md`、`docs/architecture/ai-message-delivery-invariant.md` 与 `src/features/media/README.md`。

## 1. 产品模型：双轨制

生图有两条互不混用的链路。

| | 用户生图 | AI 生图 |
| --- | --- | --- |
| 发起 | 用户在生图页输入提示词 | AI 调用 `generate_image` 工具 |
| 归属 | **无主**，属于用户本人 | 该角色 |
| 落盘 | **系统相册** | 应用私有 MediaAsset |
| 业务表 | **不写任何表** | `ai_generated_images` |
| 消费方 | 朋友圈、聊天上传、分享到其他应用 | `send_image`、`view_image` |
| 生命周期 | 用户自己在相册管理，与 app 无关 | 媒体引用闭合、角色删除级联、备份 |

两条链路只共享两层：

```text
辅助模型中心的模型资产
+ Platform 的 OpenAI 兼容图片协议客户端
```

再往下立刻分叉：用户生图写相册，AI 生图写私有媒体库。**不要为了让两条链路"复用"而把用户图片塞进 MediaAsset，也不要为了统一而给用户生图建业务记录。**

### 1.1 为什么用户生图存相册

现有所有图片出口都是从系统相册取图：

- 朋友圈发布：`PublishView` 的 `ImagePicker.launchImageLibraryAsync`
- 聊天上传：`selectChatImages`
- 分享到其他应用：系统分享

存相册即可零改动打通全部出口。存进私有媒体库则三者都要改，且用户看不见文件。

## 2. 首版范围

做：

1. 辅助模型中心新增 `image_generation` 模型资产类型（只存资产，不负责选择）。
2. 小程序 Tab「实用工具」新增「AI 生图」页面：选模型、写提示词、生成、自动存相册。
3. AI 工具 `generate_image`：归属角色的私有媒体生成。
4. 聊天图片长按菜单新增「保存图片」。
5. 新表的 SQLite 升级、旧备份恢复兼容、媒体引用闭合。

不做：角色级模型选择、图生图、局部编辑、批量生成、异步任务轮询、独立相册工作台、生成历史。详见 §17。

## 3. 入口与页面

### 3.1 入口

小程序 Tab（`MiniProgramsTab`）「实用工具」分类新增一项，位于「羽库」之后。`MiniProgramId` 增加 `imageGeneration`，路由由 App 映射到 `/image-generation`。

生图页由 Media 拥有（`presentation/`），App 只负责路由。MiniProgramsTab 只加配置项，不持有页面逻辑。

### 3.2 页面职责

一个页面四件事，顺序固定：

```text
选择当前生图模型
→ 输入提示词
→ 生成一张图片
→ 成功即自动保存到系统相册
```

- 顶部：当前模型行（`ModelPickerModal`），未选择时显示「选择一个模型」。该弹窗遵循 `@shared/ui/README.md` 与 `docs/architecture/auxiliary-model-selection.md` 的既有契约，不带管理跳转；「管理模型」入口由生图页在弹窗外单独提供，由 App / Host 把导航意图映射到具体路由。
- 中部：提示词输入（多行，长度上限与其他工具一致）。
- 底部：生成按钮；生成中显示取消。
- 结果：展示生成图片 + 「已保存到相册」状态；生成失败按 §3.4 显示服务端原报错并允许重试，保存失败按 §8.3 显示原因与「重试保存」。

页面不做聊天、不发消息、不展示历史列表。关闭页面后唯一留存是相册里那张图。

### 3.3 生成即保存

首版没有生成历史，因此**生成成功必须立刻自动写入系统相册**，不能等用户点保存：

- 用户误触返回、系统回收进程都会让暂存文件消失；
- 没有业务表，无法事后找回；
- 页面的「保存」不是动作，是状态播报。

### 3.4 并发生成

页面内同一时刻只允许一个生成请求：按钮在请求期间禁用，取消即中止。不排队。

离开页面（返回、切到后台）视同取消：中止在途请求，不继续后台生成，也不事后补存。外部服务已经完成的生成无法撤销。

生成失败显示「生图失败」，并把服务端返回的错误原文展示给用户（外部错误离开 Platform 前仍需脱敏，不回显 Bearer Key）。允许重试，由用户显式点按；「不自动重试」只指不自动重放计费请求。

## 4. 辅助模型中心：只存资产

### 4.1 能力注册

在 `CAPABILITY_KINDS` 与 `CAPABILITY_META` 增加：

```text
image_generation
名称：生图模型
说明：用于 AI 与用户文生图；在「AI 生图」页面选择生效的模型
```

同步更新 `SQLiteAuxiliaryModelRepository.listModelConfigs` 中当前有效能力类型的显式集合。只增加新类型，不恢复历史退休类型。

`auxiliary_model_configs.capability_kind` 没有枚举 CHECK，新增用途不重建资产表。

### 4.2 表单

复用 `AuxiliaryModelEditScreen` 的连接、服务选择、模型发现、自动保存与创建流程，不复制整页表单。对 `image_generation`：

- 显示配置名称、API 地址、API Key、服务连接、模型 ID；
- 模型 ID 允许手输或从既有模型列表选择；
- 模型列表不代表接口能力证明，帮助文案明确「请选择支持图片生成的模型」；
- 不显示 Temperature、Top P、Max Tokens，草稿提交写为 `null`。

**表单没有选择器。** 选中哪个模型由生图页决定，辅助模型中心只管理资产列表。

落地约束：`AuxiliaryModelEditScreen` 的 `capabilityKind` 是 `'summary' | 'embedding' | 'ocr'` 窄联合，`auxiliaryModelDraft.ts` 的采样参数跳过条件写死为 `kind === 'embedding'`，`TestAuxiliaryModelConnection.ts` 的 `capabilityKind` 是 `'embedding' | 'ocr'`。新增 `image_generation` 时必须同步扩展这三者与 `AuxiliaryModelNavigator` 的分流，否则会落 default 并渲染出 Temperature 等字段。

### 4.3 连接测试

生图能力不能复用 `/chat/completions` 测试，也不能只凭 `/models` 列表判定可用。

首版表单的测试保持轻量：只校验地址、Key 与模型 ID 字段完整，并说明「能否生图请到『AI 生图』页面试一张」。**不在表单里发起真实生图请求**，不制造二次费用确认流程。

现有 `TestAuxiliaryModelConnection.ts` 除「字段缺失 → skipped」外，对非 embedding 一律真实调用 `testAPIConnection`（`/chat/completions`）。`image_generation` 必须显式进入「只校验字段」分支，否则会发出一次聊天请求。

## 5. 生图页的模型选择

对齐表情包系统（`StickerSystemConfig`）的范式：Media 自己持有选择，只存 `modelConfigId`，地址 / Key / 模型名永远从辅助模型中心现读。

### 5.1 领域对象

```ts
interface ImageGenerationConfig {
  modelConfigId: string | null;
}

type ImageGenerationModelSelectionStatus =
  | 'unconfigured'
  | 'active'
  | 'incomplete'
  | 'deleted'
  | 'capability_mismatch';
```

判定规则与表情包系统一致，且 **UI 与 resolver 共用同一套底层判定**（对齐 `StickerSystemConfig.ts`：UI 走 `evaluateStickerModelSelection`，resolver 走 `evaluateStickerModelConfig`，后者内部复用前者）：

- 没有 ID → `unconfigured`
- 资产不存在 → `deleted`
- 地址、Key 或模型名任一为空 → `incomplete`
- 能力类型不是 `image_generation` → `capability_mismatch`
- 其余 → `active`

### 5.2 显式选择，不自动初始化

用户必须在生图页显式选择一个模型。**删除旧草案的「首次初始化自动填充」**：

- 生图会产生真实费用，自动选中一个模型等于隐式授权花钱；
- 用户取消选择后，后续新建资产不得重新填回；
- 只有一个可用资产时也不自动选中，页面显示「选择一个模型」，一键可选。

### 5.3 与 AI 工具的关系

`generate_image` 读取的就是生图页这一份选择：

- 未选择（`unconfigured`）→ 工具返回 `IMAGE_GENERATION_UNCONFIGURED`；
- 资产失效（`deleted` / `incomplete` / `capability_mismatch`）→ `IMAGE_GENERATION_MODEL_UNAVAILABLE`；
- **不自动换模型，不回退到聊天模型或 OCR 模型。**

是否允许某个角色使用生图工具，继续由既有角色工具权限控制，不新增第二个开关。

### 5.4 运行语义

- 执行时读取一次选择并解析成快照，本次请求使用该快照。
- 修改模型不打断已经开始的请求；下一次调用读取新选择。
- 模型资产变更后复用 `subscribeAuxiliaryModelsChanged`，由 Host 发出 Media 选择投影刷新信号。

选型说明：五态判定照搬 `StickerSystemConfig.ts` 的 domain 函数；投影刷新信号照搬 `ChatImageModels.ts` / `TranslationModels.ts` 的 `createRuntimeSlot` + `subscribe*/notify*` 范式，`configureChatRuntime.ts` 有现成装配写法。表情包自身的 UI 刷新走 `StickerProcessingSignal`，不提供这套 Host 转发，此处不要照搬。

## 6. 图片生成协议

### 6.1 客户端边界

新增独立的 OpenAI 兼容图片生成客户端，不把图片协议塞进聊天消息类型，也不改变现有聊天、流式和向量调用。

客户端复用：

- `normalizeAIBaseURL`
- API Key Bearer 认证
- 现有错误显示与脱敏
- `AbortSignal`
- 现有 HTTP 诊断能力

请求：

```http
POST {normalizedBaseURL}/images/generations
Content-Type: application/json
Authorization: Bearer <apiKey>
```

```json
{
  "model": "<resolved model>",
  "prompt": "<prompt>",
  "n": 1
}
```

不主动附加采样参数、尺寸、质量、响应格式或流式字段。

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

不解析或持久化 revised prompt、任务 ID、签名 URL、用量字段等没有真实 consumer 的数据。

超时分两类，错误展示与重试判定分开：**本地等待超时**（请求未在等待窗口内返回）与**服务端返回超时**（响应体明确报告生成超时）。两类都作为可重试的明确分类，不合并成笼统的「生成失败」。

响应体不另设一套大小上限：Base64 与 URL 两条路径落到本地文件后，统一交给 `inspectLocalImage` 现有的 50 MiB / 8192px 边界；URL 路径沿用原生下载侧已有的 50 MiB 约束。

## 7. AI 工具 `generate_image`

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

约束：

- `prompt` 去除首尾空白后不能为空，长度上限与其他工具一致。
- `file_name` 可选，只用于媒体与消息显示，不作为文件路径。
- 没有 `size`、`quality`、`style`、`n` 或 `on_success` 参数。

工具说明必须明确：

- 使用「AI 生图」页面当前选择的模型；
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

两条路径只在「如何得到本地暂存文件」上不同，之后共用同一媒体链路。

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

省略文件名时，在真实 MIME 确认后生成带正确扩展名的默认名称。内容去重由 MediaAsset 既有 hash 与复用逻辑负责；即使复用已有 asset，也插入本次角色自己的生成引用。

### 7.4 工具结果与错误

| 场景 | code | retryable |
| --- | --- | --- |
| 未选择生图模型 | `IMAGE_GENERATION_UNCONFIGURED` | false |
| 所选配置失效 | `IMAGE_GENERATION_MODEL_UNAVAILABLE` | false |
| 提示词为空 | `IMAGE_GENERATION_PROMPT_REQUIRED` | false |
| 认证、权限、配额、限流、服务错误 | 沿用明确分类 | 按既有错误契约 |
| 响应没有有效图片 | `IMAGE_GENERATION_INVALID_RESPONSE` | false |
| 返回图片无法解码 | `IMAGE_UNREADABLE` | false |
| URL 下载被网络安全边界拒绝 | 沿用下载错误 | false |

数据库错误、内部不变量失败与任务 fence 冲突继续暴露给 Agent Runtime，不伪装成服务商失败。

`generate_image` 不设置 `fulfillsUserVisibleOutput`，因为它没有产生用户可见消息；一轮只有生成、没有发送时沿用 Agent Runtime 对非可见输出工具调用的既有裁决（与 `DownloadImageTool` 一致），不新增 intent 或重试分支。真正发送仍由 `send_image` 的既有 completion intent 裁决。工具描述需写明 `generate_image` 返回的 `mediaAssetId` 对应 `send_image` 的 `media_asset_id` 入参。

## 8. 用户生图：写入系统相册

### 8.1 新增原生能力

项目当前没有写系统相册的能力：`expo-image-picker` 只读；`web-tools` 的 `downloadImage` 写应用私有 `cacheDir`（`WebPrivateImageStore`），成功或取消后由 TS 侧删除暂存；只有普通文件下载 `download` 写 `MediaStore.Downloads`（`WebDownloadStore`）。两者都不写 `MediaStore.Images`。新增一个只写不读的原生模块：

- 用 `MediaStore.Images` 插入，`RELATIVE_PATH = Pictures/RavenCat`，`IS_PENDING` 两阶段提交；两阶段写入可直接参照 `WebDownloadStore.kt` 的既有实现；
- Android 13+ 写自己创建的媒体**不需要任何权限声明**，不新增 `READ_MEDIA_IMAGES`。`AndroidManifest.xml` 已声明遗留的 `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`（无 `maxSdkVersion`），本次不新增权限；是否清理这两条单独决定，不影响生图能力；
- 不把 `expo-media-library` 作为依赖，避免 manifest 多出读权限。

失败必须可区分：存储空间不足、媒体目录不可写、写入中断。不能向 UI 报告「已保存」而实际没写。

### 8.2 生成与保存流程

```text
生成请求（用户生图不读 AI 工具上下文）
→ 得到 base64 或 URL
→ 写应用暂存文件
→ inspectLocalImage 验证真实格式与尺寸
→ 写入系统相册（MediaStore）
→ 清理暂存文件
→ 页面展示结果与「已保存到相册」
```

文件名使用 `ravencat-<yyyyMMdd-HHmmss>-<hash8>.<ext>`，扩展名来自真实容器检测，不信任服务商声明。

### 8.3 保存失败

生成成功但相册写入失败时：

- **保留暂存文件**，页面显示失败原因与「重试保存」；
- 用户离开页面会清理暂存文件，图片即丢失，因此必须在离开前给出明确提示；
- 不静默重试，不切换到其他目录。

### 8.4 与备份、清除的关系

相册里的图片是用户的系统资产：

- **不进入备份**；
- **恢复出厂不清理**；
- 卸载应用不删除。

这三条要写进媒体与备份文档，避免以后有人「顺手统一清理」。

## 9. 聊天图片保存到相册

聊天图片长按已经走统一的消息长按菜单（`ImageAttachmentCard.onLongPress` → `onMessageLongPress(msg, position)`）。

在该菜单中新增「保存图片」：

- 只在消息包含图片附件时显示；
- 复用 §8.1 的同一个相册写入能力；
- 图片来自 `MediaAsset`，先解析为本地文件 URI 再写入，不经过网络；
- 成功提示「已保存到相册」，失败给出原因；
- 不修改消息、不创建新引用、不影响媒体生命周期。

落地约束：`ChatMessageActionMenu` 的菜单项是静态 `actions` 槽位，传 `undefined` 时按钮灰显而非隐藏；「只在含图片附件时显示」需新增条件分支（`getMessageAttachments` 目前没有任何菜单项消费）。单聊 `ChatDetail/index.tsx` 与群聊 `GroupChatDetail.tsx` 两处都要接线。图片解析沿用 `resolveMediaAsset` / `getMediaAsset`；GIF / WebP 等动图能否写入 `MediaStore.Images` 在原生层确认，`isAnimated` 不作为拒绝条件。

## 10. SQLite

以当前 schema 167 为基线，本次迁移为 168。

### 10.1 生图页当前模型

```sql
CREATE TABLE IF NOT EXISTS media_image_generation_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model_config_id TEXT
);

INSERT OR IGNORE INTO media_image_generation_settings(id) VALUES (1);
```

`model_config_id` 故意不建外键：删除资产后仍需保留失效引用 ID，供选择器展示原因；只有用户取消或改选才改写它。

默认记录加入 `DEFAULT_RECORDS_SQL`，保证新安装、升级和快照恢复后单行存在。

### 10.2 生成业务引用

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

该表只服务 AI 生图，持有角色对生成图片的持久引用，不兼任历史展示或审计数据库。只保存当前生命周期需要的字段，不保存提示词、API Key、签名 URL、服务商原始响应或模型参数快照。

表定义加入已存在的 `aiImageSchema.ts`（该文件已承载 `ai_downloaded_images`），不新建重复 schema 文件；`media_image_generation_settings` 同放该文件并注册进 `SCHEMAS`，两个索引注册进 `INDEXES`，默认记录进 `DEFAULT_RECORDS_SQL`。

### 10.3 迁移要求

- 新安装通过 `SCHEMAS` 一次创建两张表与索引。
- 旧库升级到 168 时只新增上述结构，不改写既有模型资产与业务选择。
- 将 167 纳入允许升级的旧版本判断：`migrations.ts` 有 3 处内联长条件（当前 `:64` / `:71` / `:165`，末项都是 `version !== 166`）需同步追加 `version !== 167`，不要只改第一处；不改变其他历史版本策略。
- schema、默认记录与 `PRAGMA user_version` 在同一事务提交。
- 任一步失败整笔回滚。
- 不创建虚拟生图资产，不在升级时自动选择任何已有模型。

## 11. 媒体生命周期与备份

新增引用类型 `'ai_generated_image'`，必须同时接入（现有下载引用字面量是 `'ai_download'`，不是 `'ai_downloaded_image'`）：

1. `MediaAssetLifecycle.ts` 的 `MediaAssetReferenceKind` 联合类型新增该值。
2. 完整引用查询 `MEDIA_ASSET_REFERENCE_QUERY`：加入 `ai_generated_images.media_asset_id`。
3. targeted release 的 `MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY`：增加对应 `NOT EXISTS` 段，生成记录存在时不得回收 asset。
4. `listAssistantMediaAssetIds`（8 段 UNION）：角色删除前，在同一事务收集该角色生成图片候选。
5. 角色删除：生成记录随 `assistant_id` 级联删除，commit 后按全部 live 引用裁决 backing 是否释放。
6. 备份媒体枚举：生成记录持有但尚未发送的图片也必须进入备份。
7. 恢复预检与完整 SQLite 快照：生成记录、媒体和版本标记一起恢复。
8. 恢复出厂与媒体审计：沿用全库和私有媒体根目录清理。

**用户生图的相册文件不进入以上任何一条。**

### 11.1 旧备份查询兼容

`SQLiteMediaAssetRepository.listBackupAssets()` 会在 staging 快照升级前按旧 `user_version` 选择引用查询。不能直接把新表拼进所有 165 及以上备份共用的 `MEDIA_ASSET_REFERENCE_QUERY`——该常量同时被 `auditDatabase` 消费。

- 保留旧查询常量 `MEDIA_ASSET_REFERENCE_QUERY`（不引用 `ai_generated_images`），新增一份包含生成引用的查询常量供当前库审计使用。
- `listBackupAssets` 增加 `version >= 168` 的明确分支选新常量；`>= 165` 分支继续选旧常量。
- 为当前数据库与 168 及以上快照使用包含生成引用的新查询。
- 用当前仍受支持的最近旧版本快照做恢复预检回归，至少覆盖 166、167。
- 不改变 165 及其他历史版本现有的支持或拒绝策略；168 快照必须带回生成图片。

不通过 try/catch、缺表忽略或恢复后补扫掩盖。

## 12. 取消、竞态与事务边界

### 12.1 事务外

允许：模型选择与配置读取、AI HTTP 请求、图片 URL 下载、Base64 暂存、图片检查、hash 与 backing 准备、相册写入。

事务内只允许：MediaAsset 查询或写入、任务 fence 检查、生成业务引用写入、必要的 row mapping 与不变量检查。

禁止在事务内请求网络、写图片文件、等待 UI 或发布跨 Feature 事件。

### 12.2 取消与过期任务

- HTTP、URL 下载及提交前均检查 `abortSignal`。
- 在 MediaAsset 与生成引用提交的同一事务调用 `assertImageToolRunCurrent`。
- 单聊沿用 Chat reply run fence，群聊沿用群任务 fence，自主任务继续服从自身取消信号。
- 任务被取消或被取代时不提交生成业务事实；MediaAsset 准备流程按既有补偿删除未提交 backing。
- 外部服务已经完成的生成无法撤销，取消后不自动重试、不自动发送。

### 12.3 模型切换与重复执行

- 每次工具调用固定一次模型快照，不在请求中途重新解析。
- 模型切换只影响下一次调用。
- 工具标记为非幂等，运行时不自动重放计费生成。
- 不使用调用点 sleep、随机延迟、重试或备用模型解决冲突。
- 提交失败按真实错误结束，不重新发起第二次外部生成来「补偿」。

## 13. Host 工具注册与提示词

在唯一 Built-in Tool 注册表（`createAgentToolRegistry.ts`）加入一条，形状与 `send_image` 一致：

```ts
agentNativeBuiltInTool(GenerateImageTool, 'media', EXTERNAL_SIDE_EFFECT,
  { directChatOnly: true, groupChatAllowed: true, callForbidden: false, defaultEnabled: true });
```

`name` 由 `GenerateImageTool.name`（`generate_image`）派生，注册表对象没有独立的 `name` 字段；`risk` / `idempotency` 属于第 3 个 `policy` 参数，不是 `options` 成员。`toolPackageId` 是否设为 `'media'` 需与 `getPolicyAllowedToolEntriesForAI` 的工具包开关一起确认，避免工具被总开关意外隐藏。

工具继续受既有策略约束：AI 总工具开关、角色工具权限、单聊 / 群聊 / 自主任务场景、Host 唯一注册与 schema 派生。

采用静态注册：未配置时工具仍在工具表里，调用返回明确错误。**不增加按模型选择动态增删 schema 的第二套暴露机制。**

更新 `buildToolsDescription`：

- `generate_image` 用于通过当前生图模型创建一张新图片；
- 返回 `mediaAssetId`；
- 生成后可使用 `send_image` 发送，使用 `view_image` 查看；
- 正文中的 Markdown 图片链接不等于已经生成或发送；
- 不重复描述既有 `send_image` 的消息提交规则。

Chat 不新增生成消息 intent、时间线项目、持久化函数或 delivery 分支。

## 14. 错误与隐私

- API Key 只存在于模型服务或资产凭据边界，不进入工具输入输出、生成记录或普通日志。
- 外部错误离开 Platform 前脱敏，不能回显 Bearer Key。
- 签名图片 URL 只作为瞬时响应和下载输入，不写入业务数据库或聊天正文。
- 提示词会发送给用户选择的第三方服务；生图页与模型池应说明费用与网络调用性质。
- 生成图片不写入系统相册的私有目录之外的位置；AI 生图继续留在应用私有媒体库，用户生图直接进相册。
- 不用 OCR 模型、聊天模型名或模型列表能力声明猜测生图支持。
- 不为认证、权限、配额、内容拒绝或服务错误自动切换模型、改写提示词或重复生成。
- 首版内容审核完全由所选服务与现有产品边界负责，不新增本地隐式二次生成或审核流程。

## 15. 预计修改位置

### Assistants

```text
src/features/assistants/domain/AuxiliaryModel.ts
src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts
src/features/assistants/presentation/auxiliaryModels/constants.ts
src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelEditScreen.tsx
src/features/assistants/presentation/auxiliaryModels/auxiliaryModelDraft.ts
src/features/assistants/TestAuxiliaryModelConnection.ts
src/features/assistants/README.md
```

### Media

```text
src/features/media/domain/ImageGenerationConfig.ts
src/features/media/domain/ImageGenerationSettingsRepository.ts
src/features/media/domain/AIGeneratedImageRepository.ts
src/features/media/application/ImageGenerationModels.ts
src/features/media/application/GenerateImageTool.ts
src/features/media/application/GenerateImageForUser.ts
src/features/media/application/AIImageRuntime.ts
src/features/media/infrastructure/SQLiteImageGenerationSettingsRepository.ts
src/features/media/infrastructure/SQLiteAIGeneratedImageRepository.ts
src/features/media/domain/MediaAssetLifecycle.ts   （MediaAssetReferenceKind 联合类型）
src/features/media/infrastructure/SQLiteMediaAssetRepository.ts
src/features/media/presentation/ImageGenerationScreen.tsx
src/features/media/index.ts
src/features/media/composition.ts
src/features/media/README.md
```

如生成工具与现有 `AIImageTools.ts` 仍保持清晰，也可将工具放入该文件，不为单一工具机械增加层次。

### Platform 与持久化

```text
src/platform/ai/ImageGenerationClient.ts
src/platform/ai/types.ts
src/platform/ai/index.ts
src/platform/persistence/sqlite/aiImageSchema.ts   （已存在，扩展）
src/platform/persistence/sqlite/schema.ts
src/platform/persistence/sqlite/defaultRecords.ts
src/platform/persistence/sqlite/migrations.ts
```

### 原生模块

```text
modules/gallery-writer/                            （新增，只写不读）
```

### 小程序入口与路由

```text
src/features/miniPrograms/presentation/MiniProgramsTab.tsx
src/app/(tabs)/mini-programs.tsx   （MINI_PROGRAM_ROUTES 是穷尽映射，必须补项）
src/app/image-generation.tsx
```

### Host

```text
src/host/composition/configureAIRuntime.ts
src/host/composition/configureAIImageTools.ts   （扩展 AIImageRuntimeDependencies，两个宿主都经此处装配）
src/host/composition/configureHostRuntime.ts
src/host/composition/configureBackgroundExecutionRuntime.ts
src/host/composition/agent/createAgentToolRegistry.ts
```

### Chat

```text
src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx
src/features/chat/presentation/messages/ChatDetail/index.tsx
src/features/chat/presentation/group/GroupChatDetail.tsx
（长按菜单新增「保存图片」）
```

只加菜单项与相册写入调用，不改消息提交、delivery 或时间线。

### 文档与验证

```text
docs/architecture/auxiliary-model-selection.md
docs/tasks/ai-image-generation-plan.md
scripts/verify-ai-image-tools.mjs        （已存在，扩展，不要新建覆盖）
scripts/verify-gallery-writer.mjs        （新增，并在 package.json 注册 verify:gallery-writer）
scripts/verify-media-asset-*.mjs（只改真实涉及项）
相关备份恢复验证脚本
```

## 16. 实施顺序

### 阶段一：模型资产与选择

1. 增加 `image_generation` 类型、列表元数据、仓储过滤与表单能力分支。
2. 增加 Media 的 `ImageGenerationConfig`、Repository、五态判定与候选查询。
3. 完成 Host 的选择解析与变更信号装配。
4. 验证新装、升级、取消、改选、失效引用；不自动初始化。

### 阶段二：协议与两条落盘链路

1. 实现 OpenAI 兼容图片生成客户端与响应校验。
2. 实现 Base64／URL 到本地暂存的两条准备路径。
3. 新增 `gallery-writer` 原生模块并验证零权限写入。
4. 实现生图页：选择、提示词、生成、自动存相册、失败重试。
5. 实现 `generate_image` 的模型快照、取消、事务 fence 与引用写入。

### 阶段三：工具与聊天整合

1. 注册工具、权限元数据与提示词。
2. 接入 Host 图片 runtime 与模型解析。
3. 聊天图片长按菜单新增「保存图片」。
4. 验证生成后复用 `send_image`，不修改 Chat 消息提交所有权。

### 阶段四：备份、文档与验收

1. 完成版本化备份引用查询与旧快照恢复验证。
2. 把稳定契约同步到辅助模型与 Media 的架构文档。
3. 运行与改动范围匹配的检查与专项验证。
4. 使用真实服务与 Android 设备验收；未经明确要求不构建完整 APK。

## 17. 待定与明确不做

### 17.1 待定（首版不做，结构上留好位置）

- **生图页内临时切换模型**：当前是生图页一份选择，同时决定 AI 能否生图。首版只支持持久改选与独立的管理入口；不提供仅当前图片生效、不影响 AI 的临时覆盖。
- **聊天侧「发送给当前 AI」快捷发送**：从生图页生成后直接落到聊天输入框。技术上可行（生成结果可产出 `SelectedChatImage` 形状，经 Host 的待发送通道交给聊天，不需要 Media 依赖 Chat），但产品形态未定，首版不做。
- 用户生成历史：不建表、不做列表。

实施结论：`generate_image` 归入既有 `media` 工具包，包归属不读取手机工具包总开关；仍由既有 AI 总开关、角色权限与场景策略裁决。GIF / WebP 原字节写入 `MediaStore.Images`，不以动画为由拒绝，也不转码。两条遗留存储权限保持原样，本次只写模块的 manifest 不新增任何权限。

### 17.2 明确不做

- 角色级生图模型选择与自动继承。
- 图生图、参考图、局部重绘、遮罩与图片编辑。
- 自定义尺寸、质量、风格、负面提示词的跨提供方统一抽象。
- 异步任务提交与轮询、进度消息、后台生成队列。
- 一次多张、批量生成与自动多图发送。
- 独立生图工作台、历史管理页、相册导出或生成记录检索工具。
- 自动重试、自动换模型、自动改写提示词或内容拒绝后的二次生成。
- 为假设中的第二套图片协议预先建立复杂 Provider 框架。
- 把用户生成的图片写入私有媒体库、备份或业务表。

## 18. 验证方案

测试真实行为、外部协议边界与长期所有权，不断言源码字符串、函数体或内部调用顺序。

### 18.1 模型与选择

- 创建、自动保存、列表展示与服务复用。
- 生图资产不保存聊天采样参数。
- 首个可用资产**不**自动填充选择。
- 用户取消后不被后续资产重填。
- 改选影响下一次调用；进行中的请求保留原快照。
- 删除、类型不匹配、连接不完整分别落到对应状态并显示原因。
- 未选择或失效时 `generate_image` 返回明确错误，不换模型。

### 18.2 图片协议

- 正确构造 `/images/generations` 请求与 Bearer 认证。
- Base64、URL、两者同时存在、空数组、多项、缺字段和无效 JSON。
- HTTP 认证、权限、配额、限流、服务和参数错误脱敏。
- 请求取消不转成普通失败，不自动重试。

### 18.3 相册写入

- MediaStore 写入成功，文件出现在系统相册的 `Pictures/RavenCat`。
- 不申请任何相册读权限，manifest 无新增权限。
- 存储不足、目录不可写、写入中断分别返回可区分错误。
- 生成成功即保存；保存失败保留暂存并允许重试。
- 恢复出厂、备份、卸载均不触碰相册文件。

### 18.4 媒体与工具

- Base64 暂存、真实格式识别、解码失败与清理。
- URL 下载复用公共网络安全边界，不保存签名 URL。
- MediaAsset 与生成引用同事务提交。
- 内容复用时仍创建当前角色的生成引用。
- 取消、单聊 supersede、群任务 supersede 不提交生成事实。
- 生成结果不自动发消息；同一 `mediaAssetId` 可由既有 `send_image` 消费。
- 聊天图片长按「保存图片」只在含图片附件时出现，且不改变消息与引用。

### 18.5 生命周期与迁移

- 167 → 168 升级、事务回滚、重复启动和新安装。
- 生成引用参与完整审计与 targeted release。
- 角色删除后，未被其他引用持有的生成图片可回收；仍被消息等引用的文件保留。
- 当前仍受支持的 166、167 旧快照预检不查询生图表。
- 168 快照恢复生成记录与私有文件。
- 恢复出厂清理不遗留生成引用或私有文件。

### 18.6 建议执行的检查

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
npm run verify:gallery-writer
npm run verify:media-assets
npm run verify:backup-artifact
npm run verify:backup-restore
npm run verify:application-data-reset
npm run verify:database-baseline
```

`verify:ai-image-tools` 与 `scripts/verify-ai-image-tools.mjs` 已存在，本次是扩展既有脚本（现有内容覆盖 `download_image` / `view_image` / OCR 与 HTTP 图片降级），不要新建覆盖。`verify:gallery-writer` 尚未注册，需一并新增。§11.1 要求的 166 / 167 旧快照恢复回归在 `scripts/` 中目前没有用例，需新建；`scripts/helpers/sqlite-bootstrap-fixture.mjs` 可用于构造指定 `user_version` 的快照。

真实服务生成质量、费用、签名 URL 下载和 Android 私有文件与相册行为单独验收，不用模拟结果冒充真机通过。

## 19. 首版完成标准

源码与本地验证已覆盖下述行为，设备上的真实生成、相册显示与跨应用选图仍需实际验收；不以模拟结果代替设备通过，也未构建完整 APK。

只有同时满足以下条件才算完成：

1. 用户能在辅助模型中心创建、编辑、删除生图模型资产。
2. 生图页能选择模型、输入提示词、生成一张图片。
3. 生成成功即自动保存到系统相册，失败可重试且原因明确。
4. 聊天图片长按可保存到系统相册。
5. AI 能通过 `generate_image` 得到可持久解析的 `mediaAssetId`。
6. 未选择或配置失效时明确失败，不静默使用其他模型。
7. 生成图片能通过现有 `send_image` 成为真实单聊或群聊图片消息。
8. 取消和过期任务不能提交生成业务事实。
9. 生成图片被引用闭合、角色删除、备份与恢复正确覆盖。
10. 用户相册图片不进入备份、不被恢复出厂清理。
11. 当前支持的旧备份恢复不受新表影响。
12. 没有新增第二套聊天提交、消息 delivery、媒体 catalog 或模型资产体系。
13. 相关验证按真实结果通过，独立问题如实报告。

## 20. 本次实施与验证记录

- 新增 `image_generation` 资产与 Media 持久选择，UI／resolver 共用五态判定；新建和取消后均不自动选模型。表单只检查字段，不请求模型。
- 新增独立 `/images/generations` 客户端，一次一图，不添加尺寸、质量或聊天采样字段。提示词上限 2000 字，本地等待 180 秒，区分本地与服务端超时。错误离开 Platform 前脱敏；诊断不保存提示词、图片内容或签名图片 URL。
- 用户生图自动写相册，保存失败仅重试保存；离开与后台取消、清理暂存。AI 工具复用既有 backing／catalog／事务 fence，生成不发送，已有 `send_image` 消费同一 ID。单聊和群聊图片菜单均接入相册写入。
- 数据库版本 168；角色生成引用参与审计、targeted release、角色级联候选与备份。166／167 未升级快照使用旧查询，168 快照保留生成引用，升级失败全事务回滚。
- 已通过：TypeScript、修改文件 ESLint、别名／分层／SQLite／循环依赖／样式／架构快照检查；辅助模型、AI 图片工具、媒体资产、备份产物与恢复、恢复出厂、数据库基线专项。相册模块 `:gallery-writer:testDebugUnitTest` 编译与 5 个单测通过，不组装 APK。
- 待实际验收：第三方服务生图质量与费用、签名 URL 下载、设备相册中的 GIF／WebP 显示、真实前后台切换与系统中断、相册图片从聊天和朋友圈选择。未调用真实付费生图服务。

## 21. 供应商、图片参数与制作画布（2026-11-12）

本轮扩展首版文生图能力，不改变用户相册与 AI 私有媒体的双轨所有权，也不新增历史表、后台任务或第二套消息交付。

### 21.1 资产与协议

- 模型中心复用原有表单，提供硅基流动、MiniMax、豆包 Seedream、阿里千问与 OpenAI GPT Image；官方地址只读，模型从已适配列表选择，用户提供 Key。供应商与 STT／TTS／翻译统一为创建后固定，编辑只改本供应商模型、Key 和参数；更新事务拒绝改变供应商，不引入恢复原供应商流程。只有新建阶段切换供应商会清空旧凭据和服务绑定，不从通用服务填入任意地址。「使用已有 Key」暂不实施，等待公共界面统一设计。
- 协议选择存入既有 `metadata_json`；自定义 OpenAI 兼容入口和高级能力开关已移除。无 metadata 或旧 `openaiCompatible` 资产保留原 ID、连接、选择与内容，但明确不可用，需要新建供应商明确的配置，不迁移猜测、不自动降级，不再发请求。读取配置时确认供应商、官方地址与模型匹配。
- 硅基流动接入 Z-Image、Z-Image-Turbo、Qwen-Image、Qwen-Image-Edit、Qwen-Image-Edit-2509 与 Kolors，由完整模型 ID 映射参考图要求和推荐尺寸。两个 Qwen 编辑模型必须参考图且不发送 `image_size`；Kolors 参考图可选，仅提供已适配的 1:1、3:4、9:16；其余三款仅文字生图。Qwen-Image 使用推荐 50 步与 CFG 4；所有模型走原生 `/images/generations` 与 `images[].url`，不走 multipart edits，不提供流式预览或未经适配的清晰度参数。提示词原样保留，文字比例不改写尺寸字段。
- MiniMax 使用 `/image_generation` 和人物 `subject_reference`；Seedream 使用 Images API、关闭组图并按所选模型映射分辨率；千问使用官方 OpenAI 兼容 Images 扩展 `image`；GPT Image 的参考图上传走 multipart `/images/edits`。
- 统一 HTTP 边界保留单次计费、180 秒等待、错误脱敏、取消和诊断契约。禁止带凭据跟随重定向。诊断不保存提示词、参考图、中间图或结果签名 URL。

### 21.2 本次生成与展示

- 比例、清晰度、渲染画质、格式和压缩质量属于本次请求，按已配置供应商能力展示，不保存到连接或全局选择。不支持的参数在计费前明确拒绝，不自动丢弃字段、换模型或改写提示词。
- 用户可选择一张人物／主体参考图，复用系统相册选择器的缓存副本。原生选图 Activity 的正常前后台切换不撤销选图；页面失焦或过期选图结果要清理副本。参考图只作为本次服务输入，不写业务表或相册。
- 必需参考图的编辑模型在选图前禁用生成，应用边界也在计费前拒绝缺图请求；比例由服务根据参考图决定。固定尺寸模型在选项中显示推荐像素，画布按请求像素预留，厂商近似比例不伪装为精确比例。切换模型清空本次参数；切到不支持参考图的模型时撤销未完成选图，缓存等待在途请求结束后再释放。
- 始终显示所选比例的占位画布；生成期间使用呼吸动效、真实阶段与等待秒数，没有按时间伪造的百分比。GPT Image 在原请求中接收最多两张中间预览，流中断或只有预览时不得提交最终图片；其他供应商显示同步制作阶段。
- 操作按钮为「生成」「取消」「重试保存」。成功仍自动保存，相册状态、实际宽高和文件体积显示在结果下方，点击成图使用已有全屏看图组件。
- `generate_image` 增加可选 `aspect_ratio`、`resolution` 与 `reference_media_asset_id`；省略时使用模型默认，生成引用和 Chat／群任务 fence 原样保留。

### 21.3 验证边界

`verify-image-generation.mjs` 覆盖供应商请求／响应映射、MiniMax 业务错误与单图数量、原生尺寸约束、停用自定义配置、地址／模型不匹配、multipart File、SSE 分块／预览／最终事件／错误／取消，以及参数拒绝发生在计费前。硅基流动回归包含 3:4 参数与 16:9 提示词共存、原生响应与单图校验、六款模型的尺寸与参考图映射、两个编辑模型缺图时计费前拒绝，以及真实文件读取后映射 JSON 参考图。页面回归覆盖模型切换后重置参数、必需选图才启用生成、推荐尺寸、在途参考图延迟释放、过期选图清理，保留原有取消与保存重试验证。未调用真实付费服务，未构建完整 APK；真实模型表现、原生上传和绘制动效需设备验收。

当前组合专项 `verify:ai-image-tools` 的旧版本快照夹具被工作区服务分组迁移阻断：`no such column: base_url`。生图增量没有数据库结构变化，该问题保留给对应改动处理，不为通过测试增加产品兼容或吞错。

协议依据：[硅基流动图片 API](https://api-docs.siliconflow.cn/docs/api/images-generations-post)、[硅基流动模型列表](https://www.siliconflow.cn/models)、[Z-Image 官方模型与尺寸说明](https://huggingface.co/Tongyi-MAI/Z-Image)、[MiniMax 人物参考](https://platform.minimax.cn/docs/api-reference/image-generation-i2i)、[Seedream 图片 API](https://console.volcengine.com/ark/region:cn-beijing/docs/image-generation-api)、[千问图片兼容接口](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[OpenAI Images 与流式预览](https://developers.openai.com/api/docs/guides/image-generation)。
