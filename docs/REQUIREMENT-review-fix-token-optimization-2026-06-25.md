# review-fix Token 消耗优化需求

- 日期：2026-06-25
- 范围：workflow JSON 输出、route 生成文本、shared prompt/rubric 嵌入策略、相关测试与文档
- 目标读者：`@xenonbyte/drfx` 维护者与实现 agent
- 状态：需求草案
- 形态：需求文档。本文描述问题、目标、质量边界、需求条目与验收标准；不替代实现期的具体代码方案

## 背景

`@xenonbyte/drfx` 的核心价值是把审查、修复、diff review、full re-review、guard、receipt、状态恢复与平台 route 安装做成可审计的 review-fix workflow。当前项目在质量门上已经相对完整，但执行过程中存在明显的 token 消耗压力，主要来自两类内容：

1. workflow 命令的默认 JSON 输出含有大量可由路径重新读取的结构化详情。
2. 生成 route shell 中重复嵌入 shared prompt、rubric、protocol 与模板文本，平台越多、route 越多，重复越明显。

本需求的目标不是“压缩审查内容”，而是区分三类信息：

- **审查必需信息**：reviewer、coordinator、fixer 做完整判断所需的文件、manifest、prompt、rubric、guard 和状态，不得削弱。
- **默认用户输出**：用于 route 串联和用户可见状态的最小结构，应尽量短。
- **诊断输出**：debug、full JSON、manifest 文件、receipt 与原始状态，可按需读取，不应默认塞进每次模型上下文。

本轮调研还阅读了 `rtk-ai/rtk` 项目。该项目的可借鉴点不是引入依赖，而是它的输出控制思路：命令照常完整执行，原始结果保留在可追溯位置，返回给模型的默认输出经过过滤、分组、截断和去重，并用测试守住 token budget。这个方向符合本项目的质量优先原则。

## 现状证据

- `workflow context` 当前同时返回 `contextManifestPath` 与 `contextPackSkeleton`。后者的内容已经写入 manifest 文件，默认 JSON 再返回一遍属于重复输出。一次小型样本测量中，context JSON 约 11 KB，其中 `contextPackSkeleton` 约 9.8 KB，默认输出去掉该字段可显著降低上下文消耗。
- `review-fix-code` 是生成 route 中体量最大的入口之一。Codex、Claude Code、opencode 版本的 route shell 约 88 KB 到 89 KB，Gemini 版本约 73 KB。文本中包含大量 shared 规则与协议内容，后续必须用快照和体量测试防止无意膨胀。
- Codex skill 当前既在 `SKILL.md` 中嵌入 shared 内容，又复制 shared assets。双份内容便于离线使用，但也带来明显重复，需要在不破坏 Codex 调用可靠性的前提下评估去重。
- 默认输出中不应包含 raw prompts、raw subagent transcripts、raw logs、secrets、tokens 或大段文件 skeleton。需要 debug 时，应通过路径读取 redacted artifact。

## 质量边界

任何优化都必须满足以下边界：

- 不减少 reviewer isolation，不取消 read-only reviewer，不绕过 reviewer readiness probe。
- 不减少 stdin handoff proof、write-blocking guard、fingerprint guard、redaction、machine payload validation、final-response validation。
- 不减少 review -> triage -> fix -> verify -> diff review -> full re-review -> repeat 闭环。
- 不用 compact 输出替代真实状态文件、manifest、receipt 或审查上下文。
- 不把 “token 少” 当作 PASS 条件。PASS 只能由既有质量门和 re-review 结果获得。
- 不引入会吞掉错误、静默降级、隐藏 blocker 或扩大自动修复写入范围的逻辑。
- 不引入外部运行时依赖，也不把 `rtk-ai/rtk` 作为本项目 runtime dependency。

## 目标

- G1：默认 workflow JSON 输出更短，只包含 route 串联和用户状态判断所需字段。
- G2：完整诊断信息仍可通过 `--json=full`、manifest path、receipt path 或 debug 路径读取。
- G3：生成 route 默认使用 compact 输出，避免把重复 JSON 继续灌入后续模型上下文。
- G4：新增可执行的体量回归测试，防止 context JSON、route shell、embedded shared 内容无意膨胀。
- G5：借鉴 `rtk-ai/rtk` 的输出过滤思想，只过滤返回面，不改变底层执行和审查语义。
- G6：识别并删除繁琐或冗余流程中的重复输出，优先减少默认数据面，而不是减少质量门。
- G7：所有优化必须有正收益，可量化为 token、字节、重复率、测试稳定性或维护复杂度下降。

## 非目标

- 不降低审查深度，不把完整文件集审查改为抽样审查。
- 不删除 full re-review、diff review、partitioned units、backstop review 或 aggregate coverage gate。
- 不修改 reviewer 输出 schema 来追求更短输出，除非能证明解析契约和质量门不变。
- 不引入通用 LLM 总结层来压缩 reviewer 证据。模型总结可能丢失 blocker，不适合作为质量门前置。
- 不把 prompt、rubric、workflow hard constraints 做语义删减。可去重、可延迟读取、可压缩重复措辞，但不得减弱规则。
- 不以大规模重构为目标。只有当冗余流程或结构问题直接增加 token、漂移或维护风险时才改。

## 需求条目

### 批次 A：compact workflow JSON

#### A1 支持 `--json=compact|full`

- 现状：CLI 已有 `--json` 检测，但 workflow 参数解析把 `--json` 当作 boolean flag，`--json=<value>` 尚未成为稳定契约。
- 需求：
  - `--json` 保持现有兼容语义，等价于 `--json=full`。
  - 新增 `--json=compact`，作为 route 内部默认使用的短输出格式。
  - 非法取值必须 fail closed，输出明确错误，不回退到 full 或 compact。
  - compact 与 full 只影响 stdout JSON 形状，不影响状态文件、manifest、receipt、guard 或审查 payload。
- 验收：
  - `--json`、`--json=full`、`--json=compact` 均有测试。
  - `--json=bad` 被拒绝。
  - 现有调用 `--json` 的测试和用户脚本保持兼容。

#### A2 compact context 输出省略重复 skeleton

- 现状：context JSON 同时返回 `contextManifestPath` 与 `contextPackSkeleton`，后者已经存在于 manifest 文件中。
- 需求：
  - compact 输出必须保留 `contextManifestPath`。
  - compact 输出默认省略 `contextPackSkeleton`。
  - full 输出继续保留 `contextPackSkeleton`，用于调试和兼容。
  - route 需要详细上下文时，应读取 `contextManifestPath` 指向的 manifest，而不是依赖 stdout 中的大字段。
- 验收：
  - compact context JSON 不包含 `contextPackSkeleton`。
  - full context JSON 包含 `contextPackSkeleton`。
  - compact 输出仍足以让 route 找到 manifest 并继续 workflow。
  - 新增 size regression 测试，确保 compact context 明显小于 full context。

#### A3 partitioned workflow 输出默认短摘要

- 现状：partitioned review 的 start/context 阶段可能返回 unit、summary、manifest 等大量结构，部分信息可以通过路径读取。
- 需求：
  - compact 输出保留 workflow id、status、route、target、guard、manifest path、review plan path、unit counts、blocking reason、next action 等必要字段。
  - compact 输出默认省略大型 `units`、`summaries`、prompt bodies、raw transcripts 和完整 skeleton。
  - full 输出继续保留调试所需的完整结构。
- 验收：
  - partitioned start/context 的 compact 输出可驱动后续步骤。
  - compact 输出不包含 raw prompts、raw transcripts、raw logs 或 secret-like payload。
  - full 输出仍满足现有调试需求。

### 批次 B：route 默认使用 compact 输出

#### B1 生成 route 调用切换到 `--json=compact`

- 现状：生成 route 内部调用 workflow 命令时使用 JSON 输出，容易把完整结构传给后续模型上下文。
- 需求：
  - 由 route 自动调用的 workflow 命令默认使用 `--json=compact`。
  - 需要调试、失败诊断或人工复现时，route 应提示可使用 `--json=full` 或 debug artifact 路径。
  - 外部用户手动运行 CLI 时仍可选择 full。
- 验收：
  - 生成的 Claude Code、Codex、Gemini、opencode route 中，自动 workflow 调用使用 compact。
  - debug 或诊断说明不丢失 full 路径。
  - 生成 fixture 更新后由快照测试守护。

#### B2 用户可见输出保持简短

- 需求：
  - 默认输出只报告当前状态、停止原因、accepted findings 摘要、验证命令、验证结果、下一步。
  - 不打印 raw JSON、raw prompt、raw transcript、内部 issue ids、secrets、tokens 或大段 logs。
  - 当输出被截断或压缩时，必须给出可追溯 artifact path，而不是吞掉信息。
- 验收：
  - 默认 route 输出没有大段 JSON。
  - debug 输出经过 redaction。
  - 失败时仍能定位 manifest、receipt 或 debug artifact。

### 批次 C：体量预算与回归测试

#### C1 context JSON 体量测试

- 需求：
  - 增加测试覆盖 compact 与 full 的字段差异。
  - 增加字节级或 token 近似预算断言，至少覆盖 `workflow context` 和 partitioned context。
  - 预算阈值应保守，允许合理增长，但能拦住重复 skeleton、raw prompt、raw transcript 重新进入 compact 输出。
- 验收：
  - 故意把 `contextPackSkeleton` 加回 compact 输出时测试失败。
  - 故意把 raw prompt 或 transcript 放入 compact 输出时测试失败。

#### C2 route shell 体量测试

- 需求：
  - 对每个 platform × route 的生成 route shell 做 size snapshot 或 budget test。
  - 对 embedded shared content 和 Codex copied shared assets 做字符串快照，防止 shared 文案漂移无人发现。
  - 预算失败时应提示具体 platform、route 和增长量。
- 验收：
  - 任一 route shell 异常膨胀时测试失败。
  - prompt、rubric、protocol 文案变更需要显式更新 fixture。
  - 不引入新的测试依赖，继续使用 `node:test` 和现有 fixture 模式。

#### C3 token budget 说明

- 需求：
  - 在测试或开发脚本中提供粗略 token 估算，优先用字节和 word count 做稳定 proxy，不依赖外部 tokenizer。
  - 估算只用于回归监控，不作为 runtime PASS 条件。
- 验收：
  - 本地测试能报告 compact/full 的相对变化。
  - CI 不依赖网络或外部服务。

### 批次 D：shared 嵌入去重评估

#### D1 Codex skill shared 内容去重

- 现状：Codex skill 既嵌入 shared 内容，又复制 shared assets，存在重复。
- 需求：
  - 评估 Codex route 是否可以把部分 embedded shared 内容改为强制读取 copied shared source。
  - 若改动，必须保证离线安装、skill discoverability、route invocation、共享规则读取均可靠。
  - 若无法安全去重，应保留现状，并只用 size test 防止继续膨胀。
- 验收：
  - 去重后 Codex skill 仍能在无网络环境下完整执行。
  - 缺失 copied shared source 时必须 fail closed，不得用空规则继续。
  - 相关 fixture 和安装测试覆盖。

#### D2 非 Codex 平台只做低风险重复措辞压缩

- 需求：
  - Claude Code、Gemini、opencode route 中可压缩重复说明、重复警告、重复示例。
  - 不压缩 workflow hard constraints、质量门、平台能力差异和安全边界。
  - 文案压缩必须由 fixture diff 显式审查。
- 验收：
  - route shell 体量下降或至少不增长。
  - 关键质量词汇和 hard constraints 仍存在。
  - snapshot diff 可读，便于 review。

### 批次 E：流程和代码结构优化

#### E1 删除重复输出路径

- 需求：
  - 对 workflow 输出字段做一次字段级审查，标记 `stdout required`、`path readable`、`debug only` 三类。
  - 默认 stdout 只保留 `stdout required`。
  - `path readable` 字段保留文件路径，不重复输出文件正文。
  - `debug only` 字段只在 full 或 debug 输出中出现。
- 验收：
  - 字段分类写入测试或注释，避免后续无意回退。
  - compact 输出字段清单稳定。

#### E2 保持模块边界窄改动

- 需求：
  - 优先在 workflow JSON 格式化、参数解析、generator route 调用、测试 fixture 层做改动。
  - 不为了本需求大拆 `lib/workflow/helpers.js` 或重写 workflow 状态机。
  - 若某个模块必须拆分，必须证明它能减少重复、降低漂移或让体量测试更清晰。
- 验收：
  - diff 聚焦在输出格式、生成模板和测试。
  - 没有无关重构、无关格式化或公共接口漂移。

## 验证要求

- 每个实现批次至少运行：
  - `npm run syntaxcheck`
  - `npm test`
- 涉及生成模板、shared prompt、rubric 或 fixture 的改动，必须更新并审查对应 fixture。
- 涉及 README 行为说明的改动，必须保持 `README.md` 与 `README.zh-CN.md` 结构同步。
- 任何 compact/full 行为改动必须有针对性测试。
- 若某项检查无法运行，最终说明必须列出原因和剩余风险。

## 回滚

- A、B、C 批次应可独立回滚。A 是 CLI 输出契约扩展，B 是 route 调用方式，C 是测试护栏。
- D 批次涉及 Codex skill shared 嵌入策略，风险高于 A 到 C，应单独提交并保留明确 fixture diff。
- 所有批次不做数据迁移、不修改远端状态、不改变已有 workflow state 文件的读取语义。

## 风险与依赖

- compact 输出如果字段删减过度，可能导致 route 后续步骤拿不到必要路径。必须用 route 级 fixture 和 workflow e2e 测试覆盖。
- route shell 去重如果做得过深，可能让平台在缺少 shared source 时失败方式不清晰。必须 fail closed，并给出可读错误。
- 体量预算阈值过紧会制造维护噪音，过松又拦不住回归。初始阈值应基于当前 fixture 加合理余量，并在增长时要求显式说明。
- 本需求无新增第三方 runtime 依赖。`rtk-ai/rtk` 仅作为设计参考，不纳入依赖树。

## 完成定义

本需求完成时，应同时满足：

- 默认 workflow JSON 和 route 内部调用已使用 compact 输出。
- full 输出、manifest、receipt 和 debug artifact 仍可支持完整诊断。
- 审查和修复质量门没有减少。
- context JSON 和 route shell 有体量回归测试。
- shared prompt/rubric 的变更有 fixture 或 snapshot 守护。
- README 或开发文档已说明 compact/full 语义和调试入口。
- 全量语法检查和测试通过，或明确说明无法运行的检查与风险。
