# 测试目录

RavenCat 的验证脚本都在 `tests/`。`scripts/` 只保留构建与工具（`patch-*.cjs`、`app-version.cjs`、文档生成器、外网探针、`android-tests/`）。

结构规则一句话：**`tests/` 与 `src/` 同构**。找某个模块的测试，就去同名目录。

```text
tests/
├── helpers/            13  共享装载器、SQLite/聊天夹具、repoRoot、工具清单
├── architecture/        8  check-* 架构门禁、别名打包入口、执行器行为验证、长文件报告
├── chat/               74  按 src/features/chat 的子模块再分层
│   ├── conversation/      会话列表、置顶、排序、预热、统计
│   ├── messages/          提交、选择、编辑、搜索、分享、删除、分页、滚动
│   ├── reply/             回合协调、执行宿主、后台不变量、回复策略
│   ├── group/             群身份、成员、发言权、提及、附件、自动调用
│   ├── presentation/      气泡皮肤、Markdown、推理态、字符统计、纸笺
│   ├── composer/          输入区、草稿、图片选择/提交、页脚
│   ├── code/              代码卡片与网页预览
│   ├── appearance/        DIY 气泡与编辑会话
│   ├── favorites/         消息收藏
│   └── summary/           会话摘要
├── device/             26  phoneTools / deviceControl / screenCapture / netease / 悬浮层
├── companion/          17  陪伴、AI 日程、主动生活、软锁、诊断
├── assistants/         17  模型服务、助手身份、设置页、回收站
├── media/              13  MediaAsset 生命周期、裁剪、生图、相册
├── together-listening/ 12  一起听（含悬浮层）
├── host/               11  Agent Runtime、Host 装配、后台执行
├── prompting/          10  Prompt Pack、目录、调用点、持久化
├── calls/              10  通话运行时、历史、铃声、媒体
├── ui/                  9  开关、滑块、输入、弹窗、图片预览、字体
├── moments/             9  人机时刻
├── backup/              6  备份产物、恢复、覆盖度、数据管理
├── stickers/            4  贴纸 v2 与处理
├── diagnostics/         3  HTTP 原文诊断
├── profile/             3  人格、版本、更新
├── memory/              3  记忆 v3、玻璃场景、摘要设置
├── persistence/         2  SQLite 协调器、数据库基线
├── mcp/                 2  MCP 边界与注入
├── speech/              2  语音提供方、ASR 签名
├── wallet/              2  钱包记录与回复队列
└── web/                 2  Web 工具与搜索展示
```

## 命名

* 行为验证：`verify-<模块>-<被验证行为>.mjs`，文件名即 `verify:<模块>` 入口名的来源。
* 架构门禁：`check-<约束>.mjs`，不使用 `verify-` 前缀。
* 共享夹具：`<域>-fixture.mjs`、`<用途>-dependencies.mjs`，只放 `helpers/`。

## 测试类型

| 类型 | 判定 | 注意 |
| --- | --- | --- |
| 行为 | 转译加载生产模块，直接调用函数 | 外部边界用替身，不 mock 被测模块 |
| 集成 | `node:sqlite` 内存库 + 真实 Repository | 建库走 `bootstrapSqlite`，不要手抄 schema |
| 渲染 | `react-test-renderer` 跑真实生命周期 | 断言可观察输出，不锁 hook 调用顺序 |
| 静态 | 只读源码 / AST | 只用于退役守卫与结构契约；不写函数体正则 |
| 架构 | `check-*` | 通过 AST 与依赖规则判定，不做字符串匹配 |

## 共享基础设施

| 文件 | 用途 |
| --- | --- |
| `helpers/repo-root.mjs` | `repoRoot`：向上查找 `package.json`。**唯一**的仓库根来源 |
| `helpers/load-typescript-module.mjs` | 默认转译装载器（`loadTypeScriptModule`、`readRepoFile`） |
| `helpers/import-typescript-module.mjs` | 需要真正的 ESM 模块实例时使用（data URL import） |
| `helpers/sqlite-bootstrap-fixture.mjs` | 真实 `SCHEMAS` + `runMigrations` 建库，附 `createSqliteExecutor` |
| `helpers/coordinated-sqlite-fixture.mjs` | 真实 `DatabaseCoordinator` 调度与事务语义 |
| `helpers/agent-tool-schema-dependencies.mjs` | 真实 AJV JSON Schema 依赖 |
| `helpers/chat-*-fixture.mjs` | 聊天域共用装配（时间线 schema、消息变更、分享） |

约束：

* **不要在测试文件里再写一份转译装载器**。需要 JSX / 别名 / 特殊依赖策略时，先扩展 `load-typescript-module`。
* **不要手抄 `CREATE TABLE`**。手抄 schema 会随生产迁移漂移，而且没有机制提醒。用 `bootstrapSqlite` 或 `SCHEMAS`。
* **不要用 `path.resolve(..., '..')`、`import.meta.dirname, '..'`、`process.cwd()` 当仓库根**。用 `repoRoot`；否则移动目录就会静默读错文件。
* 只服务单个测试的替身留在该测试内。

## npm 入口

* 每个测试文件都必须在 `package.json` 注册入口；**没有入口的测试等于不存在**。
* 单文件入口：`"verify:<模块>": "node --no-warnings tests/<module>/verify-<...>.mjs"`。
* 多文件聚合：用 `&&` 串联，或用 `npm run` 引用成员条目。
* 全量入口展开 `npm run` 聚合，并将普通 `&&` 链中的命令逐条执行、去重；一个用例失败不会阻止后续用例。同一文件的不同模式参数分别执行。
* 需要 Gradle / 外网 / 真机的条目在命令里保留 `gradlew` 或 `RealNetwork` 字样；若由 Node 包装脚本启动，在 `run-all.mjs` 的 `NATIVE_ENTRIES` 登记。默认跳过，使用 `--with-native` 才执行，`cd` 与 Gradle 保留在同一个 shell。
* 全量只执行检查，不执行快照生成和诊断报告。快照更新使用独立的 `npm run architecture:snapshot`。

```bash
npm run verify:registration   # 校验注册、文件存在性及全量执行可达性
npm run verify:all            # 独立执行全部验证命令（默认跳过原生与外网）
npm run verify:all -- --with-native
npm run verify:all -- --list  # 只查看本次执行计划，不执行或生成文件
```

每次全量执行的原始输出保存到 `tmp/verification-*/`，失败时打印对应日志路径；汇总按独立命令计数，不能与旧版叶子入口数量直接比较。

## 验收流程

1. **改哪跑哪**：`npm run verify:<模块>`。
2. **改共享夹具 / 移动目录 / 调整入口**：`npm run verify:all`，与改动前的失败集逐项对比；新增失败即视为改动缺陷。
3. **提交前**：`npm run typecheck`，并对改动文件执行 `npx eslint`（全库 `npm run lint` 较慢）。
4. **架构相关改动**：`npm run architecture:aliases` / `architecture:check` / `architecture:sqlite` / `architecture:styles` / `architecture:cycles` / `architecture:snapshot:check`。

历史遗留失败与不稳定项记录在 `docs/verification/` 下，跑全量前先确认当前基线，避免把既有问题当成新回归。

## 新增测试的检查清单

1. 目录对应被测模块，文件名以 `verify-` 开头。
2. 仓库根用 `repoRoot`，装载用 `helpers/`。
3. 断言描述**可观察行为或长期约束**，不锁定实现形状。
4. 在 `package.json` 注册入口，并挂进对应的聚合条目。
5. 跑一次该入口，确认它在没有回归的前提下通过；若刻意验证失败路径，确保失败信息可读。
