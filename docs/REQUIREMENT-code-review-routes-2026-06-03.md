# code review routes 需求

- 日期：2026-06-03
- 范围：`review-fix-pr`、`review-fix-code` 跨平台 route / skill / command
- 目标读者：`@xenonbyte/document-review-fix` 维护者与实现 agent
- 状态：需求草案
- 形态：需求文档，本文档不包含实现方案或代码改动

## 背景

`@xenonbyte/document-review-fix` 现在安装的是文档 review-fix routes：`review-fix-spec`、`review-fix-plan`、`review-fix-design` 和 `review-fix-doc`。这些 routes 已经具备三平台分发能力：Claude Code 安装 command，Codex 安装 skill，Gemini 安装 TOML command。这个安装模型适合继续承载代码审查类 workflow。

用户需要两个代码审查入口：

- `review-fix-pr`：审查当前分支相对某个 `base` 的 PR diff。
- `review-fix-code`：审查项目全局代码，支持可选 `scope=<path>` 缩小范围。

两个 route 不能合并。PR review 有 `base`、merge-base 和 diff 边界；全局代码审查没有 base，审查对象是项目内的代码结构、模块边界、运行契约、测试覆盖和潜在缺陷。两者的输入契约、guard 语义、扫描策略和停止条件不同。

这两个能力都不能实现成调用平台内置 `/review`。`/review` 是交互式 slash command，不是稳定的可编程 API；Claude、Codex、Gemini 之间也不能可靠互相调用对方命令。代码审查 routes 应使用本项目自己的工作流契约，复刻 PR/global code review 的判断标准，而不是嵌套调用平台内置命令。

Gemini 目前在本项目中是 advisory-only 平台，不能自动编辑文件或宣称 workflow PASS。因此两个 route 都可以安装到 Gemini，但 Gemini 版本只能做 read-only advisory review 或提示能力受限；自动修复能力只面向 Claude Code 和 Codex。

## 通用约束

两个 route 都必须只处理 actionable findings：真实 bug、回归风险、边界条件、API/契约不一致、安全问题、测试缺口、验证失败或会导致用户可见错误的问题。不应把纯风格偏好、无影响重构建议、过度抽象建议当作阻塞项。

两个 route 都必须支持：

```text
[read-only|review-and-fix] [guard=git|snapshot] [rounds=<n>]
```

不传模式时默认使用 `review-and-fix`。`read-only` 只审查并输出 findings，不修改文件、不运行修复步骤、不写入自动修复状态。`review-and-fix` 执行 review -> fix -> verify -> re-review loop。`read-only rounds=<n>` 不进入多轮修复循环，应提示 read-only 是单轮完整审查；如需多轮，用户应使用 `review-and-fix rounds=<n>`。

不传 `guard` 时默认使用 `guard=git`。`guard=snapshot` 是用户显式选择的 fallback。两种 guard 都不能静默降级；guard 不可用时必须停止并说明原因。

`rounds=<n>` 表示最多执行 N 轮，不表示必须跑满 N 轮。如果第 N 轮前已经 clean，route 必须提前停止。不传 `rounds` 时，route 持续执行 review -> fix -> verify -> re-review，直到 review 没有 actionable findings。即使未设置轮次，也必须在 blocker、no-progress、用户中断、验证无法继续或安全守卫失败时停止并说明原因。`rounds` 必须是正整数；无效值只输出用法提示，不启动 review 或自动修复。

每轮修复后必须运行最小必要验证。验证可以是目标测试、类型检查、lint、build、package dry-run 或 diff/check 类命令；如果无法运行合适验证，必须在输出中明确说明剩余风险。

两个 route 都不得 commit、push、创建 PR、修改远端状态、发布包、删除用户文件，除非用户在后续明确要求。

## 内部工作流一致性

两个 code review routes 的内部机制必须和现有 `review-fix-spec`、`review-fix-plan`、`review-fix-design`、`review-fix-doc` 保持同构，除非代码审查范围确实需要改名或扩展。不能为了代码 route 绕开现有安全和质量门槛。

必须沿用这些机制：

- Coordinator 负责整个 loop，读取规则、分发 reviewer、triage findings、执行或协调修复、做 diff review、触发 full re-review，并且是唯一可以决定最终通过的角色。
- Reviewer 必须是 isolated read-only subagent，用于 initial review 和每次 full re-review。Reviewer 不得修改文件。
- Fixer 默认由 coordinator 执行。只有当问题集合有清晰边界、上下文可压缩、锁和 guard 可刷新时，才允许使用串行 fixer subagent。
- `review-and-fix` 必须遵循 review -> triage -> fix -> diff review -> full re-review -> repeat 的闭环。修复后不能只靠 diff review 宣称通过，必须经过 full re-review。
- `read-only` 不能写文件，不能创建自动修复状态，不能宣称 workflow PASS；它只能输出 clean/findings/blocked/unsupported 这类 read-only 结果。
- 运行时必须保留 reviewer readiness probe、reviewer write-blocking/fingerprint guard、stdin handoff proof、redaction、machine payload validation、final-response validation、receipt/debug 输出边界等硬约束。
- Persistent review-and-fix 需要 target-local/project-local state；resume 不依赖 chat history。代码 routes 的 state key 可以从 route、project root、base/scope 和 guard 语义派生，但必须可恢复、可校验、可拒绝过期状态。
- No-state read-only 路径不能创建 `.docs-review-fix/targets/` 状态，只能在内存中持有必要 token 或 guard 信息。
- Terminal/pause 状态必须复用现有语义：`pass`、`read-only-clean`、`read-only-findings`、`stopped-with-deferrals`、`stopped-no-progress`、`blocked`、`unsupported`、`externally-changed`、`checkpoint` 等。代码 route 可以增加更具体的 status reason，但不能改变这些状态的含义。
- Default 用户输出必须保持简洁，不打印 raw workflow JSON、raw prompts、raw subagent transcripts、内部 issue IDs、secrets、tokens 或 raw logs。`debug` 只能输出 redacted audit details。

代码 route 的差异只在审查对象：

- `review-fix-pr` 的“target”是当前分支相对 `base` 的 PR diff 和修复涉及的文件集合。
- `review-fix-code` 的“target”是 project root 或 `scope=<path>` 限定的代码集合和修复涉及的文件集合。
- Reviewer guard、snapshot guard、diff review、lock 和 receipts 都必须适配“文件集合”，不能假设只有单个 Markdown target 文件。

## review-fix-pr

推荐调用形式：

```text
review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [rounds=<n>]
```

### 目标

1. 新增用户入口 `review-fix-pr`，并通过现有 install 机制安装到 Claude Code、Codex 和 Gemini。

2. `base=<branch>` 必填。如果缺少 `base`，只输出用法提示，不读取 diff、不启动 review、不修改文件。`base` 必须从已有本地 ref 或可解析 revision 中解析；route 不得为了补齐 base 隐式执行 `git fetch` 或改写本地远端跟踪引用，除非用户后续明确要求。

3. route 必须识别当前分支。如果 `base` 解析到的分支与当前分支相同，只输出提示，说明 base 不能等于当前分支，并要求用户换一个 base。

4. route 的审查对象是当前分支相对 `base` 的变更。默认比较语义应面向 PR 场景，即 review 当前分支相对 merge-base/base 的有效 diff，而不是全仓无差别扫描。

5. 不传模式时默认使用 `review-and-fix`。`read-only` 只输出 PR findings 和建议，不修改文件。

6. `guard=git` 必须面向 PR 场景：确认 base 可解析、当前分支不等于 base、merge-base 存在，并阻止自动修复覆盖无关本地改动。多轮修复中，第一轮之后工作区包含本 route 产生的修改是正常状态；`guard=git` 不能在每轮开始都要求整个工作区回到 clean HEAD。

7. `guard=snapshot` 必须保护本轮可能修改的 PR 相关文件集合，至少覆盖初始 PR diff 涉及的文件和修复过程中需要触碰的必要依赖文件。

8. Claude Code 和 Codex 上，`review-and-fix` 发现 actionable findings 后应自动修复。修复范围必须限制在当前 PR 相关变更及其必要依赖内，不得覆盖无关本地改动。

9. route 必须在每轮输出简洁状态：轮次、模式、发现的问题摘要、修复摘要、验证命令和结果、是否继续下一轮。最终输出必须说明停止原因：clean、达到轮次上限、blocked、no-progress 或 unsupported。

10. Gemini 版本必须明确 advisory-only：可以安装同名 command，但不能自动修复；遇到 `review-and-fix` 请求时应提示用户改用 Claude Code 或 Codex 执行自动修复。

### 规则体系

`review-fix-pr` 必须有内置 PR rubric。内置规则覆盖通用 PR review 基线，不依赖具体仓库：

- correctness：逻辑正确性、边界条件、状态一致性、错误路径。
- regression：兼容性、历史行为、公共 API、CLI、schema、配置和协议变化。
- safety：不覆盖无关本地改动、不泄露 secrets、不误删文件、不修改远端状态。
- tests：测试缺口、关键失败路径、回滚路径、验证命令和验证结果。
- contracts：代码、文档、生成模板、frontmatter、TOML、README 和 manifest 契约是否同步。
- maintainability：只审查会影响行为、维护安全或验证能力的可维护性问题。
- platform：Claude Code、Codex、Gemini 的能力差异，尤其 Gemini advisory-only 限制。

`review-fix-pr` 必须支持以下外部规则文件：

```text
~/.docs-review-fix/rules/PR.md
.docs-review-fix/rules/PR.md
```

加载顺序为：

1. workflow hard constraints
2. built-in PR rubric
3. user-global PR rules
4. project-local PR rules

项目级规则比用户级规则更具体。外部规则可以收紧审查标准，但不能放宽 hard constraints。

示例项目规则：

```md
- 修改 CLI 参数时必须同步 README.md、README.zh-CN.md 和测试。
- 新增 route 必须覆盖 Claude Code、Codex、Gemini 三个平台生成产物。
- Gemini 相关改动不得声称 review-and-fix PASS。
- 涉及 install/uninstall manifest 的改动必须增加安全回归测试。
```

### 验收标准

- 缺少 `base` 时，`review-fix-pr` 只提示必填参数和示例。
- `base` 不可解析时，`review-fix-pr` 只提示用户提供可解析 base，不隐式 fetch 或改写本地远端跟踪引用。
- `base` 与当前分支相同时，`review-fix-pr` 只提示 base 不能等于当前分支。
- 不传模式时默认使用 `review-and-fix`。
- `read-only` 模式不修改文件，只输出 PR findings 和建议。
- 不传 `guard` 时默认使用 `guard=git`。
- `guard=git` 在多轮修复中不会因为本 route 上一轮产生的工作区改动而误判失败，但仍会阻止无关本地改动被覆盖。
- `guard=snapshot` 必须由用户显式传入，并为 PR 相关文件集合提供快照保护。
- 内置 PR rubric 覆盖 correctness、regression、safety、tests、contracts、maintainability 和 platform。
- 用户级 `~/.docs-review-fix/rules/PR.md` 和项目级 `.docs-review-fix/rules/PR.md` 会被读取并合并到 review context。
- 项目级 PR 规则优先于用户级 PR 规则；外部规则不能覆盖 workflow hard constraints。

## review-fix-code

推荐调用形式：

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [rounds=<n>]
```

`scope` 可选。不传 `scope` 表示审查 project root 下的全局代码；传入 `scope` 时，只审查和修复 scope 内代码及其必要依赖。`scope` 必须规范化后仍位于 project root 内；不存在、越界、指向被排除目录或无法安全解析的 scope 必须停止并提示，不得跟随路径穿越到项目外。

### 目标

1. 新增用户入口 `review-fix-code`，并通过现有 install 机制安装到 Claude Code、Codex 和 Gemini。

2. `review-fix-code` 不接受 `base=<branch>`。如果用户传入 `base`，route 必须提示这是 `review-fix-pr` 的参数，并要求用户改用 `review-fix-pr base=<branch>`。

3. route 默认审查当前 project root 下的全局代码。它必须排除 `.git`、`.docs-review-fix`、`node_modules`、构建产物、依赖缓存、临时文件和其他明显非源码目录。

4. route 的审查对象是项目代码整体，而不是 PR diff。审查应优先覆盖入口点、公共 API、CLI 命令、配置/schema、模板生成、安装/卸载安全、状态机、持久化、测试夹具和跨平台分支。

5. 不传模式时默认使用 `review-and-fix`。`read-only` 只输出全局代码 findings 和建议，不修改文件。

6. `guard=git` 必须确认项目处于可回滚状态，并阻止自动修复覆盖无关本地改动。多轮修复中，第一轮之后工作区包含本 route 产生的修改是正常状态；`guard=git` 不能在每轮开始都要求整个工作区回到 clean HEAD。

7. `guard=snapshot` 必须保护本轮可能修改的文件集合，至少覆盖审查命中的 scope 内代码文件和修复过程中需要触碰的必要依赖文件。

8. Claude Code 和 Codex 上，`review-and-fix` 发现 actionable findings 后应自动修复。修复范围必须限制在全局审查范围、命中问题及其必要依赖内，不得把无关历史问题扩大成本次任务。

9. route 必须在每轮输出简洁状态：轮次、模式、审查范围、发现的问题摘要、修复摘要、验证命令和结果、是否继续下一轮。最终输出必须说明停止原因：clean、达到轮次上限、blocked、no-progress 或 unsupported。

10. Gemini 版本必须明确 advisory-only：可以安装同名 command，但不能自动修复；遇到 `review-and-fix` 请求时应提示用户改用 Claude Code 或 Codex 执行自动修复。

### 规则体系

`review-fix-code` 必须有内置 CODE rubric。内置规则覆盖全局代码审查基线，不依赖具体仓库：

- correctness：逻辑正确性、边界条件、错误路径、状态一致性。
- architecture：模块边界、入口点、公共 API、跨模块调用和循环依赖风险。
- state-and-io：文件系统、持久化、manifest、锁、恢复、并发和重复执行。
- safety：不覆盖无关本地改动、不泄露 secrets、不误删文件、不修改远端状态。
- tests：测试缺口、关键失败路径、回滚路径、验证命令和验证结果。
- contracts：代码、文档、生成模板、frontmatter、TOML、README、schema 和 manifest 契约是否同步。
- maintainability：只审查会影响行为、维护安全或验证能力的可维护性问题。
- platform：Claude Code、Codex、Gemini 的能力差异，尤其 Gemini advisory-only 限制。

`review-fix-code` 必须支持以下外部规则文件：

```text
~/.docs-review-fix/rules/CODE.md
.docs-review-fix/rules/CODE.md
```

加载顺序为：

1. workflow hard constraints
2. built-in CODE rubric
3. user-global CODE rules
4. project-local CODE rules

项目级规则比用户级规则更具体。外部规则可以收紧审查标准，但不能放宽 hard constraints。

示例项目规则：

```md
- 修改 CLI 参数或 route 名称时必须同步 README.md、README.zh-CN.md 和测试。
- 修改 install/uninstall 行为必须增加 manifest 安全回归测试。
- 涉及 workflow state、lock、ledger、receipt 的改动必须覆盖 resume 或 rollback 路径。
- Gemini 相关改动不得声称 review-and-fix PASS。
```

### 验收标准

- `review-fix-code` 可被安装到 Claude Code、Codex 和 Gemini。
- 传入 `base=<branch>` 时，route 提示这是 `review-fix-pr` 参数，不继续执行全局代码审查。
- 未传 `scope` 时审查 project root 下代码，并排除 `.git`、`.docs-review-fix`、依赖目录、构建产物和临时文件。
- 传入 `scope=<path>` 时，审查和自动修复限制在 scope 及必要依赖内。
- `scope=<path>` 不存在、越界、指向被排除目录或无法安全解析时，route 必须停止并提示，不得审查或修改项目外文件。
- 不传模式时默认使用 `review-and-fix`。
- `read-only` 模式不修改文件，只输出全局代码 findings 和建议。
- 不传 `guard` 时默认使用 `guard=git`。
- `guard=git` 在多轮修复中不会因为本 route 上一轮产生的工作区改动而误判失败，但仍会阻止无关本地改动被覆盖。
- `guard=snapshot` 必须由用户显式传入，并为审查命中的文件集合提供快照保护。
- 内置 CODE rubric 覆盖 correctness、architecture、state-and-io、safety、tests、contracts、maintainability 和 platform。
- 用户级 `~/.docs-review-fix/rules/CODE.md` 和项目级 `.docs-review-fix/rules/CODE.md` 会被读取并合并到 review context。
- 项目级 CODE 规则优先于用户级 CODE 规则；外部规则不能覆盖 workflow hard constraints。

## 非目标

- 不替代现有 `review-fix-spec`、`review-fix-plan`、`review-fix-design`、`review-fix-doc` 文档 routes。
- 不调用或包装平台内置 `/review`。
- 不在 Gemini v1 中实现自动修复。
- 不自动提交、推送、发 PR、resolve GitHub review thread、修改远端数据或发布包。
- 不把纯风格偏好、无风险重构或大规模架构重写作为默认自动修复范围。
- 不新增新的语言运行时或大型外部依赖。

## 现有文档 routes 的 rounds 扩展

现有 `review-fix-spec`、`review-fix-plan`、`review-fix-design`、`review-fix-doc` 也应支持 `rounds=<n>`，让文档 routes 和新增 code routes 的循环控制语义一致。

更新后的调用形式：

```text
review-fix-spec <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [rounds=<n>] [resume] [ledger=<target-local path>] [root=<project-root>] [debug]
review-fix-plan <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [rounds=<n>] [resume] [ledger=<target-local path>] [root=<project-root>] [debug]
review-fix-design <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [rounds=<n>] [resume] [ledger=<target-local path>] [root=<project-root>] [debug]
review-fix-doc <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [rounds=<n>] [resume] [ledger=<target-local path>] [root=<project-root>] [debug]
```

`rounds=<n>` 表示最多执行 N 轮 review/fix/re-review，不表示必须跑满 N 轮。如果第 N 轮前已经 `pass`，必须提前停止。不传 `rounds` 时保持现有行为：持续运行到 `pass`、`blocked`、`stopped-no-progress`、`stopped-with-deferrals`、`unsupported`、用户停止或其他既有终态。

`rounds` 必须是正整数。无效值只输出用法提示，不启动 workflow、不创建状态、不读取 target/reference bodies。`read-only rounds=<n>` 不进入修复循环，建议判为不支持并提示 read-only 是单轮完整审查；如需多轮，用户应使用 `review-and-fix rounds=<n>`。

实现时不能把现有 `Current round` 或 `rounds/` receipt 目录误当成用户传入的 rounds 上限。用户的 `rounds=<n>` 需要作为独立的 invocation/workflow metadata 持久化或等价记录，并在 loop 继续前检查是否达到上限。

## 共同验收标准

- 任一 guard 不可用时，route 必须停止并说明原因，不得静默切换到另一个 guard。
- 两个 code review routes 复用现有 document routes 的 subagent、triage、diff review、full re-review、runtime probe、stdin handoff、fingerprint guard、redaction、persistent/no-state、finalize 和 receipt 机制。
- Reviewer subagent 必须 read-only；reviewer 修改任何受监控文件时必须阻断。
- `review-and-fix` 不能在修复后跳过 full re-review 直接宣称通过。
- `read-only` 不能创建自动修复状态，也不能宣称 workflow PASS。
- 与 hard constraints 冲突的 PR/CODE 规则会阻断或报告规则冲突。
- `rounds=1` 时最多执行一轮 review/fix/verify/re-review。
- `rounds=5` 时如果第 2 轮已经 clean，必须在第 2 轮停止。
- 未传 `rounds` 时，只要每轮仍有 actionable findings 且能安全修复，就继续循环；一旦 clean 或 blocked/no-progress 就停止。
- 四个现有文档 routes 支持 `rounds=<n>`；`rounds` 无效时只提示用法，不启动 workflow。
- 两个 code review routes 和四个现有文档 routes 的 `read-only rounds=<n>` 不支持进入多轮修复循环，必须提示用户改用 `review-and-fix rounds=<n>`。
- Gemini 对两个 route 都保持 advisory-only；即使用户省略模式默认应为 `review-and-fix`，Gemini 也不能自动修复，必须提示改用 Claude Code 或 Codex。
- Claude Code 和 Codex 的生成入口说明自动修复能力；Gemini 的生成入口说明 advisory-only 限制。
- 实现时必须同步更新 `README.md` 和 `README.zh-CN.md`：新增 `review-fix-pr`、`review-fix-code`，补充现有文档 routes 的 `rounds=<n>` 参数，说明 `read-only` / `review-and-fix` 默认语义、`guard=git|snapshot`、内置规则、用户级/项目级规则文件、Gemini advisory-only 限制和常用调用示例；两份 README 的章节结构和信息覆盖必须保持一致。
- 生成产物和安装 manifest 测试覆盖两个新增 route。
