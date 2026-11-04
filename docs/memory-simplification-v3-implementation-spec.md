# Memory V3 产品与架构契约

> 状态：当前产品契约／唯一实施依据，已接入生产代码；设备与真实模型验收尚未完成。
>
> 日期：2026-10-04（Asia/Shanghai）。
>
> 当前入口与验证范围见 [Memory README](../src/features/memory/README.md)。自动化验证不替代设备界面、真实模型与 Android 原生恢复验收。
>
> 文件定位：[当前实现索引](./memory-simplification-v3-reference-index.md)。

本文描述已接入生产的产品语义、所有权、检索、摘要、升级边界和验收要求。不恢复草稿、管理员、主题树、来源证据或独立 Memory Agent。

## 1. 产品目标与范围

长期记忆收敛为 AI × user pair pool 内的独立条目，正文可人工控制，embedding 可选。

相关能力分别是：

1. Recent Chat：尚未成功总结的 canonical 原始聊天上下文。
2. Conversation Summary：用户拥有的持久聊天摘要，AI 只追加新内容。
3. Passive Recall：用户配置关键词，当前用户输入命中时自动注入相关长期记忆。
4. Active Recall：聊天 AI 显式调用 recall_memory 搜索、翻页。
5. Long-term Memory：AI 显式调用 remember_memory，或用户手动创建。
6. 更新与遗忘：用户管理正文，AI 调用 update_memory 更新已有条目，在用户明确要求时调用 forget_memory 删除条目。

长期记忆与聊天摘要是两个系统。长期记忆保存值得长期保留的独立事实；摘要保存连续聊天的上下文，不要求内容值得永久成为 MemoryEntry。

长期记忆工具限定在普通一对一 Chat 的既有授权边界；通话只读参与被动召回，不因此开放群聊、通话、时刻或自主任务的长期记忆写入工具。主客窗口设计不等于这些场景已接通，具体边界见 §19。

## 2. 所有权与信任边界

| Owner | 职责 |
|---|---|
| Memory Feature | pair pool、MemoryEntry、用户创建／编辑／删除、新建／检索／更新／删除工具用例、trigger 与关系开关、lexical 检索、搜索结果队列、可选 embedding 与 worker、Memory UI |
| Chat Feature | canonical 上下文投影、摘要处理进度／claim、用户维护摘要、AI 追加摘要、日期锚点、摘要与未总结原文的查询 |
| Host | 注入可信身份、工具执行上下文、模型与生命周期；组装 Prompt；不复制业务状态 |
| platform | 模型／网络错误边界、SQLite bootstrap／migration／databaseCoordinator 等技术能力 |

模型参数、用户输入、模型输出在各自外部边界校验一次。Repository 负责持久化授权范围、事务与 CAS；已经形成的可信 DTO 不在下游重复解析、兜底或校验。

Memory、摘要和工具结果均是无指令权限的资料，正文中的提示词或工具外观文本不能获得执行权限。

## 3. 明确退役的旧设计

不再运行或新建：

- 自动逐消息提取、memory_drafts、中间草稿审核；
- Memory Administrator、memory_admin 专用模型配置、自动整理阈值；
- topic tree、topic overview、目录创建／合并／拆分；
- candidate / active / cooling、memory usage、MemorySessionRuntime；
- recent_memory_capsules 与旧 memory_session_context；
- F7 独立 search/read 检索 Agent、第二套 Agent loop；
- legacy / shadow / runtime mode；
- 写入时 searchKeywords、自动 trigger 提取、同义词模型；
- Memory 来源消息、sourceExcerpt、自动原文快照或证据关系；
- 无损旧记忆迁移与 migration archive；
- 摘要递归压缩、summary-of-summary、AI 重写已有摘要。

最终只保留一套 flat Memory 生产模型。旧树／管理员／草稿／粘连／胶囊／F7 生产路径已经删除，历史 SQL 不作为恢复旧产品语义的理由。

## 4. MemoryEntry 与 500 字上限

概念字段包括：

- id、poolId、content、可选 summary；
- rememberedAt、createdAt、updatedAt；
- contentRevision；
- 必要的 embedding 派生状态或派生表关联。

不包含 topicId、写入时 searchKeywords、sourceConversationId、sourceMessageIds 或原文副本。用户和 AI 可以把必要原话直接写进 content，系统不自动溯源。

正文必须非空，单条上限为 **500 个 Unicode 码点**。保存时只去除正文首尾空白，不为检索改写 canonical 正文；去除首尾空白后的中英文、数字、标点、内部空格和换行均计入字符数。不是 500 个英文单词，也不是 500 token。

新建和编辑使用同一规则。UI 显示字符数，工具 schema／输入边界明确长度规则；超限返回可修正错误，不静默截断、不调用第二个模型压缩、不自动切成多条。用户或聊天 AI 自行缩句或按独立事实拆分。

summary 是独立的可选检索摘要，最多 50 个 Unicode 码点，不占正文的 500 字额度；去首尾空白后为空则保存为 NULL。迁移107给旧条目增加空摘要及空规范化投影，不改正文、时间、contentRevision 或有效向量，不自动调用模型补摘要。contentRevision 同时覆盖正文与摘要；任意一个编辑都推进 revision 并更新向量。

rememberedAt 表示记住该条目的时间，不是正文中事件发生的日期。用户编辑只更新 updatedAt／contentRevision，不自动把 rememberedAt 改成最新召回时间。

## 5. 显式写入与用户管理

AI 调用 remember_memory 时控制自然语言正文和可选摘要。工具成功即形成正式 MemoryEntry，不经过草稿、管理员或第二个提取模型。

pool、当前 AI 身份、系统时间以及执行幂等键由可信上下文提供，模型不能选择另一个 AI 的空间。用户在管理 UI 中也可以创建、编辑、删除所选空间的条目。

AI 调用 update_memory 时提供 memoryId 与更新后的完整 content，复用用户编辑命令；不能指定 pool 或其他 AI。目标 ID 来自已保存或检索结果，更新替换该条正文、保留条目 ID／rememberedAt，推进 contentRevision／updatedAt 并标记向量待更新。500 字规则与用户编辑相同；不存在或不属于当前空间的目标返回错误，不自动新建替代条目。聊天摘要没有此更新入口，AI 仍只能追加摘要。

更新工具可同时提供 summary；省略时保留已有摘要，空字符串清除摘要。记忆编辑页面同时维护摘要与正文。

协议空间支持单向转为当前 AI 的记忆。摘要与正文分别保存，不拼接前缀；编辑详情可以使用当前未保存的输入。Host 解析授权空间后，以同一短事务检查协议快照、调用两边 Repository 创建记忆并删除原协议；失败回滚，协议已被其他入口修改则拒绝转换，重复并发请求只有一个成功。commit 后发布记忆刷新与向量任务唤醒。成功后原协议退出常驻注入，记忆独立维护与按需召回，没有来源关系、同步或反向转换。

同一 run／tool-call 重投只提交一次，幂等约束由 Memory Repository 的原子写入保证；正文相同不是幂等键，不能压掉后来一次独立记录。

成功的工具提交独立于后续聊天最终回复提交。后续聊天失败或取消不回滚已经成功保存的记忆；取消阻止未提交工作，不能伪称已保存。

正文 commit 与派生任务分离：短事务写正文及其派生待处理状态，commit 后通知 UI／唤醒 embedding worker。事务内不请求模型或发布 subscriber。

## 6. 用户配置的被动关键词

Passive Trigger Group 是独立配置，不是每条 MemoryEntry 的标签，由用户手动维护，限定在对应 Memory pool 内。每组包含一条或多条触发词及其关联记忆，支持 1:1、1:n、n:1、n:n。

例如 RavenCat、香蕉糖果、考研、Kimi、10月10日。当前用户输入包含 trigger 时，允许补入自动或手动关联的记忆。用户配置后的同名联想可接受，不增加语义分类器消除误触发。

输入、trigger、Memory 正文与摘要的匹配投影采用相同的 NFKC／大小写归一化与首尾空白处理；匹配是不区分大小写、兼容全半角的字面包含，不自动扩展同义词或英文词边界。canonical 正文与摘要本身不被 normalization 改写。

trigger 不得为空，规范化后的重复词只在同一组内合并，跨组允许同名词。用户可用逗号、顿号、分号或换行批量输入，空项忽略，全部为空则拒绝；每次添加保存为独立组，不按同名词合并组。主动 keywords 也使用同一规范化规则，去除空项、去重后计算不同关键词命中数。

## 7. Trigger 关系与开关

新组默认手动选择同一 pool 内至少一条记忆，无需正文或摘要包含 trigger；也可开启组自身的自动文本关联规则，此时允许尚无关联记忆。开启规则后，正文或摘要包含组内任一词的记忆与手动关系取并集。输入命中组内任一词时即可召回该组全部开启的关联记忆，不要求命中的词与关联记忆文本相同。关键词 UI 将完整词集合展示为一行，显示关联总数、开启自动召回的数量；添加页批量输入词并多选记忆，详情可编辑词集合、组规则和关联记忆。记忆编辑页为当前记忆创建多词组。

“是否自动召回”属于 group ID × Memory ID 关系，不是 MemoryEntry 的全局字段，也不属于单个词。新匹配关系默认开启；关闭一个组的关联不影响其他组，即使两组包含同名词。

组和词集合分别存入 `memory_trigger_groups`、`memory_trigger_keywords`。自动匹配关系无需物化，只保存用户显式关闭的 override；手动关系存入 `memory_passive_associations`。正文或摘要编辑后按组规则重新计算 lexical 关联，手动关系与稳定 ID 对应的关闭 override 保留；组或 Memory 删除时由外键清理对应关系和 override，删除组不删除 Memory。关闭手动关系保留关联，便于重新开启；创建组、词集合及全部手动关系在同一事务提交，失败全部回滚。编辑词集合和自动关联规则同样原子提交，保留手动关系与开关。

数据库 117 升级将旧触发词各自转为保留原 ID 的单词组，自动文本关联继续开启，旧手动关系和关闭事实原样保留。不按当前关联集合猜测用户意图或自动合并旧组；旧组仍按原规则随记忆文本变化。升级与版本标记同一事务提交，失败回滚；108／116 数据库及对应备份均走这一入口，新版启动不重复迁移。

## 8. Passive Recall

每轮普通单聊 Prompt 组装前：

1. 读取当前用户输入，只使用本轮输入触发，不拼前 N 条历史。
2. 用统一规则匹配用户配置的全部组，组内任一词命中即视为组命中。
3. 查询各命中组的关联 Memory，排除该组关系的关闭 override。
4. 按 Memory ID 去重。
5. rememberedAt 新到旧、ID 固定顺序排序。
6. 取用户配置的“被动自动召回最大条数”，完整注入正文与摘要。

没有结果则省略整个 block。Passive Recall 不调用 embedding／LLM、不分页、不裁剪正文。

局部指代由未总结原文解决，较早连续性由聊天摘要解决，深入长期搜索由 recall_memory 解决。

## 9. Active Recall 输入

工具输入：

- query：可选的自然语言搜索句子，可直接是用户原话或 AI 想查找的描述；
- keywords：可选字面关键词数组；
- offset：可选非负整数，默认 0。

query 与有效 keywords 至少提供一个。不传 keywords 时允许纯向量搜索；只传 keywords 时可独立执行 lexical。不会额外请求 LLM 从 query 提取关键词，也不会自动把整句 query 当作 lexical 关键词。

模型不能传 limit、confidence、similarityThreshold、searchSessionId 或 durable cursor。

用户设置“AI 主动召回每页条数”，默认 10。AI 只能翻页或换查询，不能扩大单页条数。

## 10. Lexical 与 vector 路径

Lexical 直接匹配 MemoryEntry.content 或 summary 的规范化投影，至少包含一个关键词即入选。重复出现同一关键词、同时命中摘要与正文都不增加覆盖数。无 embedding 时仍可独立运行。

记忆向量的输入为非空摘要＋换行＋完整正文；没有摘要则仅用正文。摘要提供主题，正文保留细节，不能只向量化摘要。

有非空 query 且配置了可用 embedding 时：

1. 对 query 生成向量；
2. 取得当前 pool 的全部有效 Memory vectors；
3. 计算同一次搜索中的相似度；
4. 参与 §11 的补充分组。

有效向量必须匹配本次解析的模型指纹、正文 revision 和维度，不能混用新旧模型或旧正文向量。

query embedding 失败、模型不可用或没有有效 vectors 时，有 keywords 就返回 lexical 结果，并说明语义路径不可用。纯向量请求没有可用向量路径时明确返回不可用原因，提示改传关键词；不能伪装成成功执行搜索后没有记忆。

调用取消继续传播 cancellation，不把取消吞成成功的 lexical fallback。

不设置可信度或 cosine 阈值。相似度仅作本次搜索内的相对排序，不向 AI 描述为相关概率；最终相关性由聊天 AI 阅读判断。

## 11. 两组召回排序

全量候选按 Memory ID 去重后，分成两个组：

| 分组 | 条件 | 组内固定排序 |
|---|---|---|
| 第一组：Lexical | 至少命中一个 keywords，无论是否有向量 | 不同关键词命中数降序 → rememberedAt 新到旧 → ID 固定顺序 |
| 第二组：Vector-only | 没有 lexical 命中，但有本次搜索的有效向量 | 相似度降序 → rememberedAt 新到旧 → ID 固定顺序 |

第一组全部在第二组之前。向量不改变第一组的顺序，不存在“已向量化即双命中优先”的第三层规则。

例：A 命中 3 词无向量，B 命中 1 词且语义接近，C 无字面命中但语义最接近，顺序为 A → B → C。纯向量请求只有第二组。

lexical SQL 和 vector 路径不得先用最终 page size 截断。先完成全量候选、去重、两组排序，再分页。本地个人数据规模先使用简单完整检索，不为假设规模引入 ANN／外部向量库。

## 12. 本次搜索队列与分页

首次搜索固定完整排序结果及用于返回的内容，保存在当前 Agent run 内。相同 pool、query 和规范化 keywords 的连续翻页读取同一队列，不逐页重新 embedding、查库排序或按最新正文重组结果。该队列属于 Memory，用可信 run ID 隔离，不由模型选择另一个 run。

首次创建队列时同时固定用户 page size。后续设置变化、后台向量完成、条目编辑等不改变已开始搜索的队列；新的搜索才读取最新状态。

offset = 0 开始新搜索；更换 query／keywords 开始新搜索。同一 run 的当前搜索后续用 nextOffset 翻页，返回 hasMore；有后页时 nextOffset = 当前 offset + 本次固定 page size。

没有匹配的当前搜索队列时，非零 offset 返回可修正错误，提示从 0 开始，不悄悄建立另一份结果。run 终止、取消或换搜索时释放旧队列，不写数据库、不跨 run 恢复、不建立持久搜索会话。

分页不裁剪正文，不用 token budget 静默减少条目。

## 13. 召回设置与 token

Memory 设置提供两个独立值：

- 被动自动召回最大条数：固定本轮自动注入条数上限，不翻页；
- AI 主动召回每页条数：默认 10，控制单次工具结果条数，可翻页。

两者不能合并成一个 Memory limit。当前默认值与 UI 档位见§27，不在工具内部另设隐含额度。

摘要、被动 Memory、主动 recall **不新增强制 token 裁剪或自动缩句**。保留现有 token 统计与超量提醒；用户通过正文维护和条数设置控制成本。

当前 Prompt Compiler 的预算只报告超量，不自动删内容，不能宣称已有裁剪保证。历史摘要按 §22 全部注入，不静默丢较早段，也不递归压缩。

## 14. Embedding 状态与有效性

向量模型资产由辅助模型中心管理，Memory 自己保存所有空间共用的开关与模型选择，不新增每 AI provider binding。记忆设置使用通用「记忆向量化」开关和独立模型选择，关闭时仍能配置模型；关闭保留引用，选择模型不自动开启。新安装默认关闭，创建或完善辅助向量模型不自动启用 Memory；152 升级按旧实际选择保留启用状态与引用。关闭或没有可用模型时记忆创建、编辑、lexical、passive、UI 都正常，不发出向量请求；AI 使用 keywords 检索，query 仅用于语义查询。

每条 Memory 的派生状态可表达：

- not_requested：没有请求条件；
- pending：等待生成；
- retry_wait：等待有界重试；
- ready：模型指纹／正文 revision／维度全部有效；
- stale：保留的向量已过期；
- failed：终态失败，用户可手动重试。

除 failed 外主列表静默，不显示成功徽标。状态是同一派生任务的表达，不为六个名字创建多套状态机。

开启时正文编辑成功后自动重新向量化。旧向量可以保留，但已不匹配新 contentRevision，不能继续参与当前搜索；新向量成功后替换，失败不回滚正文。关闭时不把正文编辑当失败，重新开启不自动补建历史记忆。关闭沿用模型切换的取消与 claim fence，晚到结果不能提交。

模型变化使不匹配的旧向量暂时不可用，保留原向量及其来源版本，不自动重建。切回相同模型指纹且正文／摘要 revision 未变时，直接恢复仍保存的匹配向量与索引维度；已覆盖、已清除或内容已变化的条目不恢复。检索有效性以保存向量的来源为准，单条任务排队或失败不能篡改这份来源。

每条记忆在列表和详情均可显式请求向量化，不要求整批重建；请求只读取该条已保存的正文／摘要，不提交草稿。应用复用模型同步、Host 维护边界与持久发布 revision，选择变化拒绝旧请求；中断的整批重建不妨碍用户改为逐条请求。关闭向量化或无可用模型时拒绝发起。

界面如实显示当前可用条目与尚未生成的状态，正文、lexical 与 passive 照常可用。用户确认整批重建后，新向量暂存内存，完整成功才通过同一 SQLite 事务替换全部索引；模型、持久发布 revision、任务 ID 或正文快照变化时拒绝发布。网络失败、取消、SQL 错误或进程退出均不覆盖旧索引；退出后需重新手动发起。

普通关闭保留模型选择与已有向量，但不再用于语义检索。「清除已有记忆向量」为独立红色操作，经确认后，在同一事务中清空向量与维度、撤销 claim 并重置派生任务状态；开关、模型、记忆正文、摘要、触发词和关系、召回设置不变。Host 先取消并等待当前任务再提交清除。清除保留当前有效模型指纹，将条目标记为 not_requested，因此不会立即重建；开启时新增、编辑记忆生成对应向量，历史记忆仅在用户明确确认重建后生成新向量，清除前的旧 claim 始终无效。

## 15. Worker 与三次上限

Memory 自己拥有 worker／持久任务状态，可参考 Sticker 的装配模式，不依赖 Sticker Repository、业务状态或 worker。

worker 短事务领取任务，事务外请求模型，短事务提交。Repository 原子比较条目存在性、contentRevision、捕获的模型指纹与任务 claim；不匹配就丢弃晚到结果，不能写回旧正文向量或复活已删除条目。

同一正文 revision × 模型指纹的自动任务 **最多尝试 3 次，包含首次请求**。第三次失败后进入 failed，停止自动请求并向用户显示失败／“重新向量化”。明确认证、模型不存在、输入过长或响应契约错误可以更早进入 failed。

取消、reset、restore、worker shutdown 不计入失败次数。重启／回前台不能重置已经失败的次数；手动重试或新的正文／模型版本才开始新一轮尝试。backoff 数值属于实现参数，不改变三次总上限。

冷启动、前台、正文 commit 和模型配置变化提供真实唤醒入口；不永久 silent retry。后台任务可取消，reset／destructive restore 前 abort＋await quiesce，晚到请求还受 generation fence 约束。

Host 在前台通过 InteractionManager 等待交互空闲后启动一条任务，条目结束后重新等待下一次空闲。选择或刷新模型撤销旧请求和持久发布资格，只使历史任务停止，不排入全量重建。手动重建由同一 Host 维护边界暂停自动队列，Repository 发布事务之外完成全部模型请求。离开前台取消待启动任务与当前请求，不让整批重建阻塞用户操作。

## 16. Embedding 错误与 UI

平台 embedding 外部边界提供能可靠识别的稳定错误 DTO，涵盖认证、模型不可用、速率限制、网络、超时、服务错误、输入过长、非法响应、维度不匹配或 UNKNOWN。

不根据字符串猜造原因，不把 query 请求失败批量标成条目 failed。可恢复请求按三次上限重试；原因不明保留安全诊断。

终态失败时告知用户，在条目列表／详情显示“重新向量化”；详情可显示模型、失败时间、可读原因与诊断摘要，不堆 HTTP 原始错误或 provider 栈。无法可靠识别时显示“向量化请求失败，未能取得更详细原因”。

## 17. Forget 与空间授权

forget_memory 仅在用户明确要求时删除当前可信 pool 的 MemoryEntry。Repository DELETE 必须同时带 pool 条件，不能只按 targetId 删除。用户管理入口同样带所选空间授权范围。

delete_topic 和草稿忽略语义退出，不给 V3 新建草稿抑制流程。删除正文同时清理其派生向量／任务与关系 override；在途 worker 不能重新插回已删条目。

## 18. 聊天摘要的产品契约

Conversation Summary 归 Chat，是用户拥有的持久记录，不是随原始消息失效的缓存，也不是长期 MemoryEntry。当前两级契约以[对话两级摘要](architecture/chat-summary.md)为准。

用户可以新增一级、编辑或删除任一级、清空两级正文。两级独立维护：编辑／删除一级不重建或改写已经形成的二级，用户需要同步时分别修改。删除消息、清除聊天历史不删除摘要；删除已处理摘要不因原文仍在而补回。二级删除也不回退一级归纳标记，不恢复注入对应原摘要。

普通聊天与通话共用 Chat 时间线、计数、前台队列、模型与持久 claim。Calls 提供原始转写、系统事件及通话状态，不复制通话正文，不建立逐消息溯源档案。

## 19. N 与主客窗口

单聊与通话的一级生成门槛 N 复用当前 AI 的“单聊·主”，在对话设置页编辑。开启摘要时 N 不是原文硬截断；关闭摘要时 N 决定最近逻辑对话窗口，两级旧摘要都不注入。用户与 AI 的消息分别计数，同一 logicalMessageId 的分段只算一条，没有身份的历史不推测合并。Current Input 单独保护。

主客表示来源与当前场景的关系，不代表一级、二级。客配置不改变摘要内容与处理进度；未接通的群聊／跨场景能力不因字段存在而自动开放。详见[主客配置](prompt/context-window-primary-secondary-design.md)。

二级独立使用 token 阈值：待归纳一级达到阈值，领取当时全部这些摘要，包含刚新增的最后一批；领取之后到达的摘要进入下一轮。token 是正文估算，不是整个请求预算，也不包含已有二级。二级不递归改写旧二级。

## 20. 摘要生成与原文交接

一级按统一时间线领取 N 条 eligible 对话；进行中的通话等终态，范围跨入已结束的通话时延伸到挂断。一次领取的全部原文在一次调用中整理，不分片；提示词要求正文控制在 500 字以内，实际有效正文允许超出，不因字数拒绝或重试。单聊 N 默认跟随该 AI 的单聊主视角条数，可手动固定。原文超出模型上下文时归类为上下文溢出，任务彻底失败并提醒调小「每次整理条数」或换用更大上下文模型。成功后原子追加段、推进 canonical 游标与标记已处理通话；失败／取消保留整批原文，不静默裁剪。

二级只读取领取的一级摘要，保留重要事件、实体与关系，不记互动细节。事务外生成、验证模型输出后，事务同时保存二级正文和全部来源归纳标记。成功之前仍注入一级；失败不替换。同一会话共用 claim／generation／租期，设置变更与清空撤销在途任务，来源编辑删除拒绝旧二级结果，新增第七批不使旧六批失效。已经形成的二级不再自动联动来源。

两级模型只负责生成正文，提交由 Chat 拥有；输出硬边界失败时不截断、不提交。用户编辑不受自动生成的输出上限限制。

## 21. Canonical 口径与最小持久状态

摘要与 raw 使用 Chat 同一 canonical 投影，排除 reasoning、transient 与撤销输出。回复错误与工具终态是 application 历史资料，不冒充用户发言或模型高权限 system 指令。应用事实不占 N，但随所属范围交接；游标不能越过未交付用户输入、仍在增长的输出或未终结 Agent run。

游标遵循 run 锚点／turnItemIndex／稳定顺序，不使用每次变化的 row_number。Current Input 与批量输入的 canonical 来源保护，不能在历史位置重复出现。

持久状态包括会话处理 generation、游标、revision、claim，摘要稳定 ID、追加序号、级别、归纳标记、二级上下文位置、正文和时间范围，以及会话设置。归纳标记是消费进度，不是二级正文外键，不因用户删除二级回退。清空两级在当前消息边界建立新起点，旧 claim 失效；reset／restore 继续遵循全应用生命周期。

## 22. 日期与稳定 Prompt 前缀

两级请求复用普通聊天的稳定基础规则、人设、用户身份、协议空间、长期静态片段与工具用途目录。任务规则放在稳定前缀之后；一级只读取本批新原文及已有摘要背景，二级只读取待归纳摘要。两级都不装载普通聊天历史、社交、被动记忆、电量、当前时间或工具展开状态，不执行工具。

讨论时间与事件时间分开；消息 timestamp／localDateTime／timeZone 是解释原文相对日期的锚点，不是事件日期。没有明确事件日期就保留不确定性，不根据当前请求日期重写旧内容。

普通聊天依次提供稳定前缀、按注入开关选择的二级与未归纳一级摘要、历史、本轮动态上下文及 Current Input。生成开启时历史来自未总结原文；暂停且无固定时按 N 读取，固定时从选中消息到最新全部读取并暂停生成，不回退原摘要进度。设置按 AI 的单聊独立保存。通话同样读取这份摘要事实，当前转写单独保护，通话状态和被动记忆继续由其现有 owner 管理。

稳定前缀不随归纳任务变化，摘要交接和用户编辑只改变其后的历史资料；服务商是否命中缓存取决于实际请求与模型，不保证每次命中。

## 23. UI

Memory 保留小程序入口／AI 空间选择，提供扁平列表、详情、手动新建、编辑、删除、500 字计数、trigger 管理／关系开关、两个召回条数设置和 terminal embedding 失败重试。

删除主题目录、topic overview editor、草稿状态、管理员手动整理、自动阈值、memory_admin binding、candidate／active／cooling 展示。

Chat 提供用户维护摘要的入口，明确摘要不会随清消息删除；AI 的自动能力只追加，用户可管理已有内容。摘要不套用 MemoryEntry 的 500 字上限。

## 24. 定向数据库升级与旧链退出

用户已确认没有需保全的旧 Memory 数据。施工时可定向清除／覆盖旧 Memory 数据与旧结构，不迁移 entries、overview、drafts、sources、tags、旧 vectors，不建立 archive。

保留仍有意义的 pair pool／AI 身份和其他 Feature 数据。禁止把此授权扩大成 clearDB、全应用 reset、删除聊天、模型资产、Sticker／媒体／Calls 数据。

使用独立 V3 canonical 物理表名。历史 migrations 会重放建表／topic_id SQL，不能原地把旧 memory_entries 改成 flat 表。在 bootstrap 尾部收口旧 Memory 结构与退休配置，配合明确版本标记；既不重新导入旧记忆，也不在每次启动清空新数据。不得改写已发布历史 SQL 或新增双运行模式绕过。

memory_admin 配置只清退休 capability 的绑定／入口，不能删除通用模型资产或其他能力的 binding。旧 Prompt 引用只清退休 Memory definition／scenario，不删除其他用户自定义提示词。

升级失败必须暴露并停止新运行时，不能捕获错误后假称完成。验证新装、旧结构升级、第二次 bootstrap、新数据保留、FK 完整与故障回滚。更老结构／备份也按定向清旧政策处理，不承诺旧记忆无损恢复。

## 25. Backup、reset 与恢复门

V3 正文、派生向量／任务、trigger、override 和 Chat 摘要／处理状态进入现有完整 DB backup，不为此添加原文档案。

旧备份的 Memory 数据走 §24 清旧升级，新备份的 V3 记忆和摘要应真实恢复；不能每次 restore 都清掉 V3。恢复后向量依模型指纹、contentRevision、维度判断 ready／stale，lexical 立即可用。

Memory embedding 与 Chat summary worker 都在 reset／destructive restore 前 quiesce，旧请求受 generation／claim fence 约束；恢复门和 bootstrap 完成后再启动。原生备份契约保持既有严格验证，不为 V3 随意放宽或随意 bump 版本。



## 26. 验收不变量

- 用户和 AI 新建／编辑 Memory 正文统一上限 500 字，不自动截断、不自动溯源。
- 不配置 embedding，用户 CRUD／remember／lexical／passive／forget 都可独立工作。
- 同一 tool-call 重投不重复写入，已成功记忆不因后续聊天失败撤销。
- trigger 由用户按组配置，按当前输入触发；同名词可跨组出现，关系开关不跨组生效。
- 主动 keywords 可省略；纯向量不可用不能伪称无结果。
- lexical 组优先且按覆盖数排序；有效向量只补充 vector-only，不优待已向量化的弱 lexical。
- 全量候选排序后分页，同一次搜索的后页复用固定队列；AI 没有 limit。
- 不强制 token 裁剪，不静默删历史摘要；条数设置与单条上限仍生效。
- 正文编辑自动重建，旧向量失效；晚到请求不能覆盖新 revision 或复活已删条目。
- 自动最多 3 次，取消不算失败，终态告知用户，成功默认静默。
- 摘要属于 Chat，用户可维护；AI 只追加，不修改／删除已有记录。
- 清消息、删消息不影响已有摘要；用户删除摘要不会自动补回。
- 摘要提交与处理进度原子交接，没有摘要等待造成的原文空洞。
- 摘要与 raw 使用同一 canonical 顺序／口径，Current Input 不重复。
- 讨论日期与事件日期区分，旧摘要日期／格式保持稳定。
- 定向清旧不触碰其他 Feature，新数据经第二次启动／V3 backup restore 保留。
- reset／restore 后没有旧 worker 回写；旧树／管理员／草稿／F7 不再参与生产。

验证保护真实行为、并发和边界，不锁定源码字符串、文档标题、用例数量或 helper 形状。只运行相关检查，未经要求不构建完整 APK。

## 27. 当前参数

| 参数 | 当前实现 |
|---|---|
| 被动自动带入 | 默认 5，档位 0／3／5／10／20 |
| 主动每页条数 | 默认 10，档位 5／10／20／50；队列首次创建时固定 |
| Memory retry | 首次失败后 30 秒，第二次失败后 120 秒；第三次或可靠永久错误终止 |
| Memory 模型请求／claim | 60 秒请求时限，120 秒 claim lease；取消不计失败 |
| 摘要模型 | 复用该 AI 的聊天模型、温度／topP／maxTokens；单聊·主为 N |
| 摘要请求／claim | 默认 300 秒请求时限，lease 为请求时限加 60 秒；两级最多自动重试一次（含首次共两次），间隔 120 秒；旧任务耗尽预算后暂停，正文与进度只在成功时交接，任务和诊断持久保存 |
| 向量序列化 | 有限非零数值数组 JSON；指纹＋正文 revision＋维度有效 |
| Chat canonical 锚点 | Chat 保存最小 run 排序锚点，删除首项不会移动摘要处理游标；无正文副本 |
| SQLite／helper 归属 | Memory／Chat 各自 Repository port 与 adapter；schema／尾部升级在 platform/persistence |
| Prompt 接入 | 普通单聊固定摘要／被动位置由 Host 补入旧预设，摘要追加保留稳定字节前缀 |

500 字上限、三次自动尝试、两组排序、无强制 token 裁剪、无自动来源、摘要只追加／清消息保留、run 内搜索队列和清旧政策均为已定产品契约。

按修改范围选择 npm run verify:memory、verify:prompt、verify:agent-runtime，以及相关 Chat／Calls／备份／reset 检查；各命令属于独立验证入口，不代表整套设备验收已完成。
