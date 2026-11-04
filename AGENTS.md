# RavenCat 项目开发约束

> 修改代码前必须阅读本文。
> 本文只保存全项目长期有效的开发规则。具体 Feature 的实现细节以当前代码和对应专项架构文档为准。

---

## 0. 仓库角色与同步发布

维护者使用两个具有独立 Git 历史的仓库：私有仓库用于日常开发，公开仓库用于发布经过审阅的源码。

开始任务前，若仓库根目录存在 `REPOSITORY_WORKFLOW.local.md`，必须先阅读，确认本地仓库路径、远端、角色和公开提交署名。这是当前维护指南，由 Git 忽略，不能随源码公开；其他克隆中没有此文件时，按本文的通用规则工作。

* 日常功能与修复先在私有开发仓库完成，按改动范围验证并提交；用户要求同步时，将审阅过的源码变更同步到公开仓库，形成独立的公开提交。
* 同步必须保留目标仓库自己的 `.git`、历史、分支和远端。不得把私有分支或提交历史合并到公开仓库，也不得整目录覆盖公开仓库。
* 不同步本地维护指南、忽略文件、私人材料、账号配置、凭据或签名密钥。目标仓库已有的本地工作也必须保留。
* 同步源码、推送远端、构建 APK、上传附件和发布 Release 是不同操作，按用户当次任务已授权的范围执行。同一任务已有明确授权时继续完成，不重复要求确认。
* 未经用户明确要求，不得构建完整 APK。
* 公开贡献者在自己的克隆和分支中开发、提交贡献，不需要访问维护者的私有仓库。

---

## 1. 核心原则

RavenCat 是一个长期维护的单人项目。

开发目标不是“让当前任务通过”，而是：

* 保持代码简单；
* 保持职责和所有权清晰；
* 保持真实产品流程自洽；
* 尽量从根因解决问题；
* 避免为了理论风险制造复杂度；
* 避免把当前实现细节固化成永久约束。

### 1.1 优先解决根因

发现问题时优先修改真正拥有该问题的层。

禁止通过以下方式掩盖上游问题：

* 层层 fallback；
* 重复校验同一个内部不变量；
* 多处 retry；
* 调用点 sleep / delay；
* 为理论异常增加兼容分支；
* 在下一层重新验证上一层已经保证的状态；
* 新增第二套流程绕过原有问题。

如果问题可以通过更清楚的所有权、事务边界、接口或状态模型解决，不要增加补丁。

### 1.2 内部代码应互相信任

系统边界需要验证：

* 用户输入；
* 外部 API；
* 网络；
* SQLite；
* 文件；
* Android 原生模块；
* 模型输出。

已经经过边界验证的内部数据，应信任：

* TypeScript 类型；
* 上游业务校验；
* Repository contract；
* framework contract；
* 已建立的状态机不变量。

不要为了“不放心”继续增加：

* 无意义 optional chaining；
* 默认值；
* try/catch；
* fallback；
* 重复空值判断。

内部不变量不满足时，应直接暴露错误或断言失败，而不是静默修补。

---

## 2. 修改代码前必须先理解真实链路

不要仅根据文件名、注释、旧文档或测试推测系统行为。

修改业务逻辑前，应先确认：

```text
入口
→ application/use case
→ owner
→ Repository / Runtime
→ commit
→ commit 后副作用
→ consumer
```

特别注意：

* 谁真正调用这个函数；
* 谁真正消费这个事件；
* 是否存在另一条完成相同工作的路径；
* 当前代码是否仍然存在真实 consumer；
* 文档描述的旧功能是否已经删除；
* 某个 legacy 名称是否只剩历史残留。

### 2.1 不维护已经不存在的语义

如果代码仍声称服务于某个功能，但实际 consumer、产品流程或所属功能已经不存在：

优先确认它是否为死代码或历史残留。

不要因为：

> “以后也许还能用”

而自动保留复杂路径。

没有真实需求、真实 consumer 或明确架构契约的能力，不应为了假想未来继续增加维护成本。

如果确认是历史残留，应：

* 删除；
* 或重新命名为它现在真实表达的中性能力。

不要让旧名称继续制造错误的系统地图。

---

## 3. 修改范围

一次任务只解决这次任务真正涉及的问题。

禁止：

* 顺手大规模重构邻近模块；
* 因为看到“不完美”就扩大任务；
* 为未来需求预先建设通用框架；
* 为一次调用抽象多层接口；
* 没有真实第二个实现时制造复杂策略系统；
* 把局部 bug 修复演变成整个项目清理。

允许在正在修改的文件和直接职责范围内顺手删除：

* 明确死代码；
* 明确过期兼容；
* 已被类型或上游保证覆盖的冗余防御代码；
* 与当前修改直接相关的历史残留。

如果发现更大的独立问题，应报告，而不是偷偷扩大修改范围。

---

## 4. 项目结构与依赖方向

技术栈：

* React Native；
* Expo；
* TypeScript；
* SQLite；
* Android 13+。

顶层源码：

```text
src/
├── app/        Expo Router 路由适配
├── host/       跨 Feature 装配与运行时组合
├── features/   业务模块
├── platform/   AI、Android、SQLite 等技术底座
└── shared/     无业务归属的公共能力
```

允许依赖方向：

```text
app      → host / features / shared
host     → features / platform / shared
features → platform / shared
platform → shared
shared   → 外部包 / shared
```

Feature 内通常：

```text
presentation → application → domain
infrastructure → domain / application / platform
```

强制要求：

* 跨 Feature 只能从 `@features/<feature>` 公共根出口导入；
* Feature 不得依赖 `app` 或 `host`；
* Feature application 不得直接依赖自己的具体 infrastructure；
* shared 不得依赖业务 Feature；
* platform 不得依赖 Feature；
* host 是跨 Feature 具体实现装配的唯一位置；
* 不重新创建已经删除的旧横向 `src/application`、`src/core`、`src/infrastructure`、`src/presentation` 兼容层。

### 4.1 Feature 公共出口

Feature 根 `index.ts` 只暴露其他模块真正需要依赖的稳定能力：

* command；
* query；
* stable DTO；
* public fact；
* presentation entry。

默认不要暴露：

* concrete Repository；
* SQLite adapter；
* configure 函数；
* 内部 runtime；
* 内部 projector；
* orchestration helper；
* 仅测试使用的实现细节。

Host-only 的具体装配能力应通过独立 composition 出口提供。

### 4.2 App 路由与 Feature 导航边界

具体页面地址和路由栈操作由 `src/app` 的路由适配或 `src/host/navigation` 的宿主导航装配负责。
Feature 只表达导航意图，避免业务页面与 App 的路由结构耦合。

* Feature 不直接调用 Expo Router 的导航 API，不持有 `router`、`Href` 或具体 App 页面路径。
* Feature 页面通过回调或已有的导航 context 表达“返回”“打开模型管理”等意图，参数使用业务 ID、能力类型等业务数据。
* App / Host 将导航意图转换为具体路径，并执行 `push`、`replace`、`back` 等路由操作；不要把路由实例或路径字符串传给 Feature 来绕过边界。
* Feature 自有的弹窗、页签、子页面状态仍由 Feature 管理；页面焦点等生命周期观察不等于导航执行。

例如，“管理视觉模型”由 Feature 调用 `onManageModels('ocr')`，再由 App 映射到模型管理页面。
新增设置入口或跨系统跳转时，应先确认导航的所有者；不能因按钮位于 Feature 中，就在该组件里直接调用 `useRouter()`。

---

## 5. Repository 与 SQLite

业务数据所有权属于对应 Feature。

* Repository port 位于 Feature `domain/`；
* SQLite adapter 位于 Feature `infrastructure/`；
* SQL 保留在对应 Feature；
* SQLite 连接、schema、migration 和调度属于 `platform/persistence`；
* UI 和 application 不执行原始 SQL。

运行时 SQLite 访问必须经过：

`@platform/persistence` 的 `databaseCoordinator`。

Feature、host、app、shared 不得直接获得 SQLite connection。

### 5.1 写入和事务

所有 SQLite 写入共享 databaseCoordinator 单写者调度。

业务原子操作必须使用 transaction。

事务内只允许：

* SQL；
* 短小纯计算；
* row/entity mapping；
* 不变量检查。

事务内禁止：

* AI / LLM；
* 网络；
* 文件 IO；
* Android 原生调用；
* 通知；
* TTS / ASR；
* timer / sleep；
* UI 等待；
* event subscriber；
* 跨 Feature 发布；
* 另一个业务队列。

标准顺序：

```text
事务写入事实
→ commit
→ UI / cache
→ public fact / domain event
→ 派生任务
→ 派生写入再次通过 databaseCoordinator
```

依赖刚写入的数据时：

* 在同一 transaction 内读取；
* 或直接使用 transaction 返回值；
* 或使用明确 barrier。

不得用 timeout 猜测数据库是否写完。

### 5.2 SQLite 并发问题

不得通过以下方式解决数据库并发：

* 调用点 retry；
* sleep；
* 随机延迟；
* 无限增加 busy_timeout；
* 吞掉 SQLite 错误；
* 改成同步查询规避问题。

正确解决位置通常是：

* coordinator；
* transaction；
* 唯一约束；
* CAS / claim；
* fence；
* watermark；
* revision；
* 业务幂等键。

涉及复杂 SQLite 并发修改前，阅读对应 SQLite concurrency 专项文档。

---

## 6. AI 回复执行宿主与消息交付

修改通知、delivery、foreground、Headless wiring、RavenCat overlay 前，必须阅读 docs/architecture/ai-message-delivery-invariant.md。

assistant commit
→ AIMessageDeliveryCoordinator
→ 前台当前会话：suppressed
→ consumer 已展示：handled_by_consumer
→ 其他情况：native notification

### 6.1 AI 日程 / 应用后台执行 / Overlay FGS

修改 AI 日程自主执行、Companion 后台执行、`RavenCatCompanionExecutionHost`、`RavenCatOverlayService`
或它们的通知/诊断前，必须阅读：

```text
docs/ravencat/proactive-companion.md        （§6.3 后台执行宿主与应用持续运行）
docs/ravencat/floating-interaction.md       （§9.1 Overlay FGS 的所有权与不可依赖关系）
```

必须保持以下组合可独立工作：

```text
Floating Interaction OFF
Proactive Companion ON
=> 没有悬浮球、没有 Overlay FGS，AI 日程仍能在后台执行并按 AI 决策发出主动消息
```

Overlay FGS 属于 Floating Interaction；Proactive Companion 不拥有、也不得依赖它。
应用级通用保活由 `modules/background-runtime` 的独立总开关拥有，开启后跨业务任务持续运行，
只有用户关闭或恢复出厂才撤销。聊天、悬浮消息与 Companion 共用应用唯一 RN 后台身份，不得为每条消息／日程创建 Service 或 RN task。
Companion execution host 仍必须有界等待本次任务终态与取消回执，不能用 fire-and-forget 替代执行所有权。
通话媒体、悬浮 UI 与设备控制的功能服务继续由各自 owner 管理；不得借通用保活接管业务事实或绕过系统权限。
完整契约见 `docs/architecture/application-background-runtime.md`。

## 7. 并发与业务所有权

`databaseCoordinator` 只解决数据库执行调度，不等于业务并发控制。

存在以下模式时必须主动检查竞态：

```text
读取状态
→ await / 网络 / AI / 长操作
→ 再根据旧状态写入
```

例如：

```text
if (!runningTask) {
  await doSomethingSlow();
  createRunningTask();
}
```

如果业务要求“只能有一个 winner”，必须在真正拥有状态的层使用：

* atomic claim；
* CAS；
* transaction；
* unique constraint；
* fence。

UI 防抖、JS mutex 或再次检查可以改善体验，但不能代替持久化业务不变量。

---

## 8. AI / Agent Runtime

模型调用只负责模型行为，不应拥有业务事实提交。

不要复制第二套：

* Chat 回复流程；
* tool execution；
* streaming/non-streaming orchestration；
* message persistence；
* background recovery；
* delivery decision。

流式和非流式是传输形式差异，不应发展成两套业务流程。

涉及 Agent Runtime、Chat execution ownership 或 Android 后台运行生命周期时，应先阅读对应专项架构文档，不凭当前文件局部推断生命周期语义。

---

## 9. Android 平台范围

项目只支持：

```text
Android 13 / API 33+
```

因此：

* 不新增 iOS 代码；
* 不新增 Android 12 及以下兼容；
* 不为不可安装的平台保留 fallback；
* Android 13 已保证存在的能力可直接使用；
* 修改相关文件时遇到无必要旧平台兼容，可以在当前职责范围内删除；
* 不为了清旧兼容扩大成全项目重构。

原生模块位于：

```text
modules/
```

Android 主工程位于：

```text
android/
```

---

## 10. UI

* 主题从 `@shared/theme` 获取；
* 通用组件优先使用 `@shared/ui`；
* 新增或修改输入区域时，表单字段复用 `InputField`，自定义输入控件复用 `AppTextInput`；换行与增长在公共输入基础中维护，不在各页面复制高度计算。
* 表单窗口的键盘避让复用 `KeyboardAvoidingContainer` 或 `ModalSheet avoidKeyboard`；同一窗口只保留一个避让所有者。聊天面板互斥和原生悬浮窗的窗口控制留在各自负责层，不通过叠加避让修补。
* Feature 私有 UI 留在 Feature `presentation/`；
* 不创建新的 Feature 私有主题系统；
* 大型 `styles.ts` 应按真实 UI 职责拆分。

新增图标优先使用 `lucide-react-native`。

---

## 11. 注释与文档

新增和修改的：

* 注释；
* README；
* 架构文档；

使用中文。

注释应解释：

* 为什么；
* 所有权；
* 不变量；
* 特殊边界；
* 容易误改的原因。

不要用注释重复代码表面行为。

### 11.1 文档不是历史垃圾场

长期规则放 `AGENTS.md`。

Feature 当前结构和入口放 Feature README。

复杂专项不变量放独立架构文档。

阶段实施过程、旧设计和迁移历史不要不断堆入 `AGENTS.md`。

如果当前代码已经完成迁移：

* 更新状态；
* 删除失效描述；
* 不让“待迁移”“legacy 路径”永久保留在当前架构说明里。

---

## 12. 测试与验证

测试用于验证：

* 真实产品行为；
* 稳定 API；
* 数据一致性；
* 并发正确性；
* 恢复行为；
* 必须长期保持的架构边界；
* 真实发生过的回归 bug。

测试不用于冻结当前实现。

### 12.1 禁止实现锁定测试

除非任务明确要求，不得新增：

* 源码字符串断言；
* 源码 hash；
* 函数体正则；
* 必须使用某个 helper 的断言；
* 必须使用某种循环写法的断言；
* 内部函数调用顺序文本匹配；
* 临时文件结构锁定；
* 当前重构实现的源码形状快照。

架构边界优先通过：

* TypeScript；
* AST；
* dependency rule；
* public contract；
* 行为测试；

进行验证。

### 12.2 不得为了测试修改产品设计

生产代码不为测试服务。

如果一个测试阻止了另一种同样正确、更加简单的实现：

首先判断测试是否错误地锁定了实现细节。

如果是：

修改或删除测试。

不要给生产代码增加：

* compatibility；
* fallback；
* 特殊 test path；
* 重复逻辑；

只为了让旧测试继续通过。

新增测试前先问：

1. 它保护的是什么真实行为或长期约束？
2. 换一种同样正确的内部实现，它是否仍应通过？

第二个问题如果答案是否定的，通常不应写这个测试。

### 12.3 Git 基线验证与仓库安全

本仓库已经发生过自动化 Agent 为验证“修改前基线”而执行临时 Git 状态切换后，`.git/objects/pack` / object database 损坏、对象或本地提交历史无法读取的问题。以下规则是已知仓库安全约束，不是可选建议。

为验证失败是否由当前修改引入时，**禁止在当前工作仓库中临时改变 Git 状态再恢复**。

除非用户明确要求，不得执行或使用以下操作作为基线验证、清理或自动修复手段：

* `git stash` / `git stash push` / `git stash pop` / `git stash apply`；
* `git reset --hard`；
* `git checkout -- .`；
* `git restore .` 或其他批量恢复工作树的命令；
* `git clean`；
* `git gc`；
* `git repack`；
* `git prune`；
* `git maintenance`；
* 任何会重写、删除、重新打包 `.git/objects` 的命令；
* 任何“先临时修改当前仓库状态，执行验证，再尝试恢复”的自动化流程。

尤其禁止将恢复步骤放在可能失败的验证命令之后，例如：

```bash
git stash && npm run verify:xxx && git stash pop
```

验证命令返回非零退出码时，后续恢复不会执行；不得设计依赖这种恢复链的工作流。

如果必须确认干净基线：

1. 使用**完全独立的 clone**，使其拥有独立的 Git object database；
2. 在独立 clone 中 checkout 所需 commit 后执行验证；
3. 不使用 `git worktree` 作为需要 Git 隔离的替代方案，因为 worktree 与主仓库共享 object database；
4. 如果无法安全创建独立 clone，明确报告“未能安全验证基线”，不要退回到 stash/reset 等方案。

默认只允许使用不会修改仓库状态的 Git 检查，例如：

```bash
git status
git diff
git diff --cached
git log
git show
git branch
git rev-parse
git fsck --full
git count-objects -vH
```

如果出现以下一类错误：

```text
bad object
missing blob
missing tree
missing commit
invalid object
packfile is corrupt
index file corrupt
unable to read object
fatal: bad object HEAD
```

必须立即停止一切 Git 写操作。不得擅自用 `git gc`、`git repack`、`git prune`、`git reset --hard` 等命令尝试“修复”。应保留当前工作文件，报告原始错误和触发前后的命令，仅进行只读诊断；需要恢复时优先从干净 clone 重建。

保护用户的工作树、未 push 的本地提交、refs 和 Git object database，优先级高于获得基线验证结果。

---

## 13. 修改完成后的检查

只运行与本次修改实际相关的检查。

禁止因为完成了一次局部修改，就机械地运行全部基础检查、架构门禁或业务专项验证。

根据改动范围选择：

```bash
npm run typecheck                    # TypeScript 类型、接口或产品代码改动
npx eslint <本次修改文件>          # 默认只检查本次修改文件；需全库时再运行 npm run lint
npm run architecture:aliases         # 别名、导入或模块出口改动
npm run architecture:check           # 分层、跨 Feature 依赖或公共出口改动
npm run architecture:sqlite          # SQLite 访问、Repository 或持久化边界改动
npm run architecture:styles          # 样式文件新增、拆分或明显增长
npm run architecture:cycles          # 多模块依赖关系改动
npm run architecture:snapshot:check  # 项目结构、模块或架构快照输入改动
```

业务专项验证同样只运行本次改动涉及的 Feature：

```bash
npm run verify:chat
npm run verify:raven-cat
npm run verify:memory
npm run verify:calls
npm run verify:agent-runtime
```

只有在跨层、跨 Feature、大范围重构，或用户明确要求时，才运行完整验证集。

不要为了一个局部任务创建新的大型验证框架。

---

## 14. Agent 工作方式

开始修改前：

1. 阅读当前实现；
2. 找到真实入口和 consumer；
3. 确认所有权；
4. 确认任务边界；
5. 再修改。

修改过程中：

* 选择最简单的正确方案；
* 不增加假想需求；
* 不复制已有能力；
* 不偷偷扩大范围；
* 不通过 fallback 掩盖根因；
* 不为了测试牺牲设计。

修改完成后应说明：

* 修改了什么；
* 根因是什么；
* 为什么这个层应该负责；
* 删除了哪些旧路径；
* 跑了哪些验证；
* 是否发现未处理但独立的问题。

如果发现当前设计本身存在问题，而正确修复明显超出本次任务：

**停止扩大代码改动，明确报告问题。**

不要为了“把任务做完”擅自设计一套新的架构。
