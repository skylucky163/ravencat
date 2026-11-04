# 表情包 V2 模型、索引与发送契约

当前入口、目录与容量见 [Sticker README](../src/features/stickers/README.md)。Sticker 拥有收藏库、分组、识别与语义检索；Assistants 拥有模型资产，Media 拥有文件，Chat 拥有发送提交，Host 装配模型和前台 worker。

## 1. 当前范围

用户导入、收藏/最近使用、分组、静态识别、动态手工语义、向量索引、AI 搜索/浏览/选择均属于 Sticker。不存在第二套 AI Sticker metadata、communication profile 或私有 HTTP/向量平台。

## 2. 导入与容量

导入边界辨别静态与动画，Media 在事务外准备最终文件与 Hash，同一事务创建/复用资产并提交 Sticker 引用。收藏库500张硬上限在该事务与 insert 一起裁决；重复内容复用不占新名额。普通列表200的分页大小不限制检索全量候选。

静态图进入 pending；GIF/动态 WebP/APNG 为 manual_required，不自动抽帧。静态 WebP 必要时转临时 PNG 供识别；原资产身份不由临时转换替代。

## 3. Canonical 语义

name、description、tags、emotion 是唯一 canonical 语义，group/favorite/useCount 是业务事实。动画正常保存和发送，用户填写非空含义并手工完成后进入 ready，才可被 AI 使用。

## 4. 两条派生链

```text
导入 → pending → Host 前台单任务 claim
→ Sticker 识别模型 → metadata + ready
→ embedding pending → 前台 worker → 向量原子 upsert
```

识别成功不等于向量成功。embedding 失败不改变 ready，不阻止发送或 lexical 搜索。启动不 drain 全库任务；App 后台/取消按现有 worker 边界收口，不写半条向量。

## 5. 业务模型选择

单例 `sticker_system_config` 保存 recognitionModelConfigId 与 embeddingModelConfigId；不会写入其他 Feature 的模型 binding。

- Recognition 只接受连接完整的 ocr 类资产，任务 Prompt 与严格 JSON name/description/tags/emotion 归 Sticker，不复用普通 OCR 的纯文本任务。
- Embedding 只接受连接完整的 embedding 类资产，复用 platform AI 客户端。
- Sticker-owned resolver 按已选 ID 解析 active/incomplete/deleted/capability_mismatch；不读取 legacy sticker_annotation 或另做自动 adoption。
- 未配置识别模型不领取并刷失败；未配置向量模型不影响已有 Sticker。
- 当前选择展示与弹窗候选查询分开，配置 commit 后唤醒对应 pending 队列。

## 6. Semantic revision

模型识别或手动修改 name/description/tags/emotion 推进 semanticRevision；favorite、useCount 和分组移动不推进。向量输入由完整 canonical 语义构造，不建立模型生成的第二份语义真值。

## 7. 索引有效性

sticker_embeddings 保存模型 ID、模型 updatedAt 指纹、semantic revision、dimension 与 vector。有效性四项必须同时匹配当前查询；旧模型或旧正文向量保留，但不能与新模型混用。模型更换／编辑不自动重建，界面明确提示原向量不适用于当前模型、旧数据保留且尚未重建。

用户手动确认后，新向量在事务外分批生成并暂存内存，全部成功才在同一事务替换用户索引。发布比较模型版本、任务 ID、持久 revision 和完整语义快照；失败、取消、内容变更或 SQL 错误不发布半套结果。退出应用丢弃未发布的新向量，需手动重新发起。AI 私有收藏不在用户整批替换范围。

Sticker 删除由 FK 级联删除向量，不删除其他事实共享的媒体。没有 SQLite vector extension、HNSW 或额外 ANN 依赖。

## 8. Worker 与网络边界

短事务领取／提交，模型与向量请求在事务外；claim、模型指纹、semanticRevision 与发布 revision 拒绝晚到结果。版本必须先于异步模型读取捕获，避免旧配置在等待后重新获得新资格。模型资产与用途选择在自己的提交事务中撤销旧资格。新 ready 或语义编辑发 pending 信号，Host 只维护已经明确发布过的当前模型索引；模型切换、冷启动和回前台都不授权为新模型全量重建。显式重建与自动维护由同一 Host 边界暂停、取消和等待，reset 前统一收口。

## 9. 搜索

search_stickers 是自然语言快速路径，可按 group 过滤。有有效 embedding 时 cosine 为主要相关性，lexical 和少量 favorite/usage 信号辅助；具体权重不是永久契约，使用历史不能绕过相关性。

未配置模型、模型连接不完整或已删除、query embedding 失败或无有效向量时，按 name/description/tags/emotion 进行 lexical 搜索。embedding 是增强，不是 Sticker 可用性的单点依赖。所有 ready 候选完成搜索排序后才取结果，不能先套 UI 列表200上限。

## 10. AI 工具

- search_stickers：返回有限轻量语义和稳定 Sticker ID。
- list_sticker_groups：只统计 ready 数量。
- list_stickers_in_group：按稳定分页返回 ready 项。
- select_sticker：接受搜索/浏览得到的 ID，只产生 send intent。

结果不返回本机 URI、base64、向量或 backing 细节。默认先搜索，确有需要再浏览，不让每次表达都必须多步 discovery。

## 11. Chat 发送

用户发送与 AI select intent 都由 Chat canonical commit 提交，Sticker 不直接写 timeline。Sticker 使用值快照保留历史表达语义；删除收藏不改写历史消息。已标注 Sticker 不再走普通图片 OCR/direct-vision 预处理。

## 12. 文件与替换

媒体文件复制、压缩、Hash 与解析属于 Media/backing 外部边界。导入失败补偿本次 prepared 文件；删除或替换只撤销所属引用，再由 Media targeted release 全引用裁决，不能直接删除共享 backing。

## 13. 设置与用户反馈

识别与向量两项选择独立；索引 stale/pending/失败如实显示，可显式重建或重试。模型缺失不伪造配置或向量成功，不恢复旧 sticker_annotation capability。界面主题、图标和导航遵循共享 UI 与 App/Host 所有权。

## 14. 验证要求

`verify:stickers-v2` 保护当前以下行为，定向媒体、模型选择与 Chat 检查按实际改动补充：

- ocr/embedding 类型、incomplete/deleted 和选择 commit；没有 legacy adoption。
- 语义编辑推进 revision，favorite/useCount/group 不推进；旧 revision/模型/维度不参与 cosine。
- 模型切换、query 失败、无有效向量可 lexical；全量候选和 group filter，AI 只读 ready。
- ready count、稳定分页、不返回 URI、select 仅生成 intent，Chat 正式提交。
- 模型缺失时不循环刷错误，向量失败不改变 ready；取消/后台/失败不提交半条 vector。
- 导入事务容量、去重、共享文件、删除级联、prepare 回滚与晚到结果隔离。

Android 动画/手工标注 UI、模型切换、队列中断、真实模型与发送展示仍需设备验收。新增测试验证真实行为与长期约束，不冻结权重、helper、循环写法或源码形状。
