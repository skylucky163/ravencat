# 应用设置工具

AI 可以自主布置自己；当前主理 AI 可以管理其他 AI 及全局图片。工具统一归入 `applicationSettings`（应用设置工具）包，仍使用已有单项调用权限、星标特批和拆包流程，不增加确认窗口。

## 工具与参数

| 工具 | 必要参数 | 权限 |
| --- | --- | --- |
| `get_user_avatar` | 无 | 全部 AI |
| `get_ai_avatar` | 无，`agent_id` 可选 | 全部 AI，可看其他 AI 的公开头像 |
| `get_group_avatar` | `group_id`；当前群聊中可省略 | 普通 AI 可看当前启用的成员关系所在群；主理可看所有群 |
| `get_chat_background` | 无，`agent_id` 可选 | 自己；主理可看其他 AI |
| `get_call_background` | 无，`agent_id` 可选 | 自己；主理可看其他 AI |
| `get_global_background` | 无 | 当前主理 AI |
| `get_moments_cover` | 无 | 全部 AI |
| `get_own_space_cover` | 无 | 仅调用者自己的个人空间封面（主页与朋友圈共用） |
| `set_ai_avatar` | `action`，`agent_id` 可选 | 自己；主理可改其他 AI |
| `set_own_space_cover` | `media_asset_id` | 仅调用者自己，主理也不能指定其他 AI |
| `set_chat_background` | `action`，`agent_id` 可选 | 自己；主理可改其他 AI |
| `set_call_background` | `action`，`agent_id` 可选 | 自己；主理可改其他 AI |
| `set_user_avatar` | `action` | 当前主理 AI |
| `set_moments_cover` | `action` | 当前主理 AI |
| `set_global_background` | `action` | 当前主理 AI |
| `set_ai_name` | `name`，`agent_id` 可选 | 自己；主理可改其他 AI |

`set_own_space_cover` 只接受 `media_asset_id`，修改 AI 的个人空间封面，个人主页与该 AI 朋友圈顶部共用这一份图片，默认图为 `assets/stars.jpg`。目标直接取可信运行上下文的 Assistant ID，不接受目标参数，不改变用户自己的朋友圈封面。图片自动居中裁剪为 2:1，提交后两处页面通过同一助手资料事实刷新。

`get_own_space_cover` 无需参数，同样以可信调用者为唯一目标。已设置封面时返回当前裁剪后图片的 `mediaAssetId` 和视觉结果；未设置时读取两处页面共用的打包星空图，`mediaAssetId` 为 `null`。已选图片不可用或视觉失败时返回明确错误，不切换为默认图，不新增媒体或聊天消息。

其余图片写工具的 `action=set` 必须带 `media_asset_id`，`action=reset` 不接受图片 ID。目标仅使用身份目录中的不可变 `agentId`，省略表示自己；内部 Assistant 主键、名称和调用者身份不由模型选择。

群头像按 `group_id` 精确读取；仅群聊回复中省略参数时使用当前群 ID，单聊、通话和自主运行必须明确指定。当前群的「群聊身份背景」注入 `group_id`；已注入的跨会话背景中，`kind=group` 的 `conversationId` 就是该群 ID，仅用于工具定位。群成员被移除或停用后失去读取资格。群头像修改、群名称及成员管理留给独立的群聊管理工具包。

设置引用独立于聊天消息提交，单聊、群聊、通话及自主运行均沿用正常授权和宿主取消契约。群聊工具仍受群发言任务资格约束；主理身份、拆包和星标都不能绕过关闭的单项工具权限。

## 图片与默认显示

读取复用 Media 的视觉路由与 Agent 工具附图，不生成用户聊天消息。图片 ID 与视觉结果一起返回；视觉失败不声称已看见图片。默认头像和朋友圈封面读取实际打包图片，没有媒体 ID；默认绘制背景明确返回无图片。

单聊背景先读取该会话独立选择；没有独立选择且当前为玻璃主题时，返回实际继承的全局背景并标记 `source=global_glass`。其他主题返回默认绘制状态。玻璃全局图在其他主题下也可保存，工具不切换主题，也不覆盖独立单聊背景。

图片更换在事务外解析素材、解码并自动居中裁剪：头像 1:1，朋友圈封面 16:9，背景使用当前屏幕比例。处理不拉伸、不改写原图，动态图片只取单帧并报告。裁剪结果进入既有 MediaAsset catalog，资产与业务引用同事务提交；暂存由媒体处理入口清理，原图和共享图片继续按真实引用回收、备份。

## 所有权与提交

- Assistants：AI 头像、个人空间封面、公开名称与当前主理关系。
- Profile：用户头像、朋友圈封面、全局与单聊壁纸选择。
- Calls：按 AI 独立保存的通话背景。
- Chat：群头像选择及当前成员关系，在同一次查询中裁决读取资格，不加载管理员凭据或成员资料；主理资格由可信 Host 提供。
- Media：图片身份、自动裁剪后的资产准备、视觉交付和文件生命周期。
- Host：目标解析、工具定义与分包、各 owner 的权限和回合资格装配。

调用者来自可信运行上下文。工具入口的角色快照用于早期拒绝；图片准备后，提交事务内通过 Assistants 再裁决当前主理关系，并检查 Chat／群任务的持久执行资格。owner 自己的 CAS 保护处理期间的用户编辑，不自动重试或覆盖新值。

改公开名称不修改用户私有昵称、人设、身份键或历史正文。工具结果不泄露私有昵称。提交后通过已有资料事件，以及壁纸、通话背景的更新事实刷新已挂载消费者；初次读取不能覆盖期间收到的更新。原生通话小窗与持续通知沿用该次通话启动时的身份快照。

数据库版本 128 将旧 `change_own_avatar` 的单项权限、默认开关和星标迁到 `set_ai_avatar`，保留明确的新配置，删除旧工具入口；127 的已展开工具包保持原状。

数据库版本 166 将 `get_own_profile_cover` / `set_own_profile_cover` 的单项权限、默认开关和星标迁到 `get_own_space_cover` / `set_own_space_cover`，保留已有封面图片和明确的新配置，删除旧运行入口。

## 验证

`npm run verify:application-settings` 检查真实 SQLite 权限、目标身份、引用原子性、用户编辑冲突、主理撤销、取消、恢复默认、默认图片与视觉附图，以及设置消费者的刷新行为。群头像覆盖当前群默认参数、显式跨群读取、成员移除或停用、主理撤销、同名群、默认群头像、视觉转述和取消。工具目录、拆包和授权复用 `verify-agent-runtime-contracts.mjs`。自动裁剪几何与文件行为由 `verify-image-auto-crop.mjs` 独立验证；实际 Android 图片效果与原生窗口仍需设备验收，不以本地测试代替。
