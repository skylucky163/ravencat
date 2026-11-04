# Sticker Feature

本 Feature 拥有用户与各 AI 的表情包收藏、用户分组/收藏/最近使用、结构化标注状态、业务级模型配置、语义向量索引与混合搜索，不拥有图片文件生命周期，也不直接写入 Chat 消息。

## 真实链路

```text
本地图片选择
→ 导入边界识别是否为动画
→ MediaAsset 在事务外准备文件与 Hash
→ 同一事务提交 MediaAsset + Sticker 引用
→ 已有手填描述直接 ready；其他静态图进入 pending，动态图或部分手填语义进入 manual_required
→ 开启自动识别或用户显式请求单张后，前台 Host 空闲时单任务 claim
→ Sticker Recognition Model（引用辅助模型中心 ocr 类配置）生成结构化语义
→ complete / fail / 中断 release（semantic 语义字段变化时 semanticRevision +1）
→ embedding pending 信号
→ 前台 embedding worker 按批生成向量并原子 upsert sticker_embeddings
```

发送链路由 Chat 拥有：Sticker 只提供发送时的值快照，用户发送和 AI 的 `select_sticker` 意图都必须经过 Chat canonical commit。删除收藏项会级联删除其向量，但不删除 MediaAsset，也不改写历史消息。

单聊与群聊的表情消息长按可「添加表情包」。是否「已添加」按用户库的 `mediaAssetId` 判断，不按原收藏 ID 或发送者判断。添加直接复用消息中的媒体与语义快照，在事务内判重并沿用收藏库容量限制；原收藏被删除也不影响添加。新收藏直接可发送，提交后唤醒用户向量队列，不重新下载或识图，也不修改 AI 的收藏。

## 模型引用边界

- 辅助模型中心是唯一的模型资产持有者（Base URL / API Key / model name）。
- Sticker System 在 `sticker_system_config` 单例行中保存自动识别开关与 `recognitionModelConfigId` / `embeddingModelConfigId`，连接配置仍由辅助模型中心持有。
- Recognition 只接受连接完整的 `ocr` 类配置，Embedding 只接受连接完整的 `embedding` 类配置；两者都由 Sticker-owned resolver 解析，不读取 capability binding，也不做 legacy adoption。
- 识别 prompt 与 JSON contract 属于 Sticker（Host 的 StickerAnnotationModelGateway 注入），不复用 OCR consumer 的任务 prompt。
- 向量有效性 = 模型 ID + 模型配置 updatedAt 指纹 + semanticRevision + 查询维度，四者同时匹配才参与搜索；embedding 失败不影响 Sticker ready 状态，搜索始终保留 lexical fallback。
- 首页模型配置与处理进度共用 `getStickerProcessingProgress()` 的同一份配置快照，与 picker 的候选列表相互独立：候选列表只在打开 picker 时加载，而展示状态每次进入页面都会按绑定模型重新判定 active / incomplete / deleted / capability_mismatch。
- 识别模型切换仍唤醒标注队列。向量模型切换只撤销旧请求与发布资格，提示原向量不适用于新模型、旧数据保留且尚未重建，不自动为新模型生成全部向量。当前模型已发布，或用户显式补齐时恢复匹配旧索引的维护资格后，前台队列才继续维护新增／编辑的用户表情。
- 「重建全部索引」先在事务中取得发布 ID／revision 与全部用户 ready 表情的语义快照，模型请求在事务外分批生成，新结果暂存内存。全部成功后，同一事务确认模型版本、发布资格和完整语义快照仍一致，再替换用户索引；AI 私有收藏不在替换范围。失败、取消、SQL 错误或进程退出保留旧索引，不暴露半套结果；退出后需手动重新发起。旧的先删向量再唤醒后台重建路径已删除。「补齐索引」可用于已发布或仍有匹配旧向量的当前模型，没有匹配旧索引的新模型必须手动重建。

## 容量与检索范围

- `STICKER_LIBRARY_MAX_COUNT`（500）是每个收藏库的硬上限，在导入的 SQLite 事务内与 insert 一起判定；同一收藏库重复内容复用不占新名额，也不受上限影响。
- `STICKER_LIST_LIMIT`（200）只是 UI / 普通列表查询的分页大小，语义检索候选集不使用它：`listReadyStickersForSemanticSearch` 返回当前过滤条件下的全部 ready Sticker，全量扫描只发生在本地检索内部，AI observation 仍然只拿到约 10 条。

## 公共入口

- `@features/stickers`：查询、用户命令、标注/向量队列命令、模型配置命令、Agent 工具 contract 与小程序页面。
- `@features/stickers/composition`：仅供 Host 装配 SQLite Repository、MediaAsset、辅助模型与 embedding 端口。

分组浏览只消费用户库中 `annotation_status = 'ready'` 的表情包。搜索返回用户可发送表情与自己的收藏；自己的未标注/失败项也可按词面定位，再显式识别或修正语义。AI 只选择 ready 表情发送，缺向量不妨碍词面检索和发送。动画表情只能由用户导入并填写语义，不进入静态识别模型。

## 用户处理进度与显式恢复

表情包系统首页在模型配置下展示处理摘要，聊天表情面板展示轻量摘要；两处均分别展示「识别」与「语义索引」，由 App / Host 导航到同一个处理进度页。识别按整个用户收藏库统计，索引按已完成识别的表情统计有效数量与待建立状态，识别完成不代表索引齐全；首页不再另设重复的索引统计卡片。模型切换、自动识别和索引维护的常驻说明集中到顶部帮助，页面保留实时状态与操作。统计不受图库 200 条分页限制；明细只显示待处理、处理中、失败、待手填和待手动重建索引项，成功项留在图库。识别逐张在前台空闲期执行，退后台暂停；排队与真实 processing 分别展示，processing 耗时来自持久 claim 的开始时间，单张不伪造百分比。状态提交后通知可见页面重读，显示计时不轮询数据库或调度任务。

「自动识别新表情」默认关闭，选择模型、导入和重新前台均不能绕过开关。Repository 在领取事务中区分自动任务与持久 `annotation_requested` 单张请求；关闭开关的同一事务释放自动 claim，Host 取消在途自动调用，旧结果不能提交。用户显式请求单张不受开关影响，失败后清除请求标记并等待再次操作。手动编辑语义同时退出自动队列并撤销旧 claim；有描述直接 ready，信息不完整保留 manual_required，后续自动识别不能覆盖。163 升级也保护旧库中已有人工语义却仍处于 pending／processing 的用户表情。AI 私有收藏的显式工具操作独立于此用户自动开关。

关闭自动识别时，总览与未请求的单张只显示「自动识别已关闭」，不把保留的 pending 记录展示成自动排队，也不显示剩余数量或自动进度条。开启后再显示剩余张数；聊天表情格子、图库与详情共用单张状态展示，实时预览排队、识别中、失败或待手填。用户显式请求的单张任务独立标记，关闭自动识别时仍可查看其真实状态。

详情提供图片、失败原因、静态图的单张识别／重新识别和手动填写含义。单张请求在 Repository 原子地放回 pending，继续使用原有 worker 和 claim，不创建第二条请求路径；重复点击不能重复入队。人工完成仍由现有标注命令校验并提交。

编辑表单在输入前标明必填与选填：保存名称必填，手动完成标注时含义／描述也必填，标签、情绪与分组选填。普通信息编辑仍允许保存部分信息，未标注表情会说明留空含义后仍待手填；保存前先显示字段错误并阻止提交，不新增业务必填规则。各入口复用公共 InputField，表单窗口由单一公共容器负责键盘避让。

识别结果与向量索引分别展示，向量失败不修改 ready 或阻止发送、关键词搜索。向量请求活动只反映当前进程真正持有的批次；模型未配置、不可用、待手动重建、待向量化与请求失败分别展示。`sticker_embedding_failures` 保存按模型指纹与语义版本归属的错误，自动队列跳过当前版本失败项，重新前台或重启不会自动重试；显式补齐可放行单张或全部缺失项。语义内容变化属于新的索引任务，不沿用旧内容的错误。错误写入也检查索引发布 revision、重建身份及语义版本，取消不记作失败。

索引补齐与整库重建集中在进度页。切回原模型时按配置 ID、配置版本及每张语义版本识别有效旧向量；新增一张只增加该张的缺失项，不使已有索引失效。显式补齐可在维护边界内恢复匹配旧索引的维护资格，Repository 原子核对选择版本与已有有效用户索引后只补缺失项；没有匹配索引的新模型仍须显式整库重建。切换提示不再无条件宣称旧向量失效。重建保持原有整批原子发布契约，失败／取消保留旧索引，离开进度页取消本页发起的重建。AI 私有收藏不进入此用户队列与进度页。

## AI 收藏与维护

群成员回复沿用相同授权工具及用户库／自身库边界。发送意图由 Chat 共享 timeline 交付到当前群；收藏维护的提交资格由 Host 接入群任务 owner，终止后拒绝继续写入，不复制表情工具或发送流程。

`owner_assistant_id IS NULL` 表示用户库；每个 AI ID 表示其独立收藏库。同一素材在各库有独立的语义及向量。用户界面和用户命令只访问用户库；AI 读取用户与自己，编辑/删除只能作用于自己的记录。共享图片本身仍可供所有 AI 查看。

`add_own_sticker` 从已有媒体 ID 收藏静态图，可直接使用聊天图片说明中的 `mediaAssetId`；联网图片先由 `download_image` 下载取得 ID。复用全局表情识图模型，再自动尝试一次向量化。失败保留记录、阶段和原因，不进入用户前台 worker，也不自动重试。重复收藏返回现有状态。`maintain_own_sticker` 支持 inspect / recognize / embed / edit / delete；编辑使旧向量按语义版本失效，重新向量化必须显式调用。搜索、选择与维护结果都会提醒缺向量状态。

AI 模型调用在 Agent 工具内等待并共享取消信号。`ai_sticker_tasks` 的持久 claim 与语义版本挡住重复和迟到结果；Chat 副作用提交还在同一事务里检查回合 fence。新消息已撤销旧回合时，即使 JS 取消尚未抵达，也不能保存旧结果。旧执行实例遗留的 processing 项只在显式调用时接管，不启动后台重试。

搜索与分组浏览的结果状态按批整理：整批共用一次模型配置解析，向量和 AI 私有处理状态分别批量读取，空结果不读配置。单张选择与维护复用相同的状态判定，不缓存跨调用的模型或向量状态。

验证：`npm run verify:ai-image-tools`、`node scripts/verify-stickers-v2.mjs`、`node scripts/verify-sticker-processing-ui.mjs`。进度验证覆盖完整收藏库、逐张重试、向量失败持久化与显式恢复、取消及迟到结果；设备上的真实模型请求、前后台切换和新消息打断需另行验收。
