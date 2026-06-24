---
r2p_stage: requirement_brief
r2p_version: 1
r2p_status: approved
r2p_created_at: 2026-06-24T18:27:17.815718+00:00
r2p_updated_at: 2026-06-24T18:27:44.365127+00:00
---

# Requirement Brief

## Goal
Deliver a scoped review-fix resilience and token-output optimization release for `@xenonbyte/drfx`: shorten generated-route workflow JSON output through compact/full modes and per-command allowlists, add size regression coverage for workflow context and generated route shells, evaluate shared prompt embedding duplication without weakening quality gates, and repair document fix-report contract/retry behavior so recoverable payload mismatches can continue through the full review-fix loop.

## In-Scope
- SCOPE-IN-001 Compact workflow JSON: add `--json=compact|full` for workflow subcommands, keep bare `--json` as full, fail closed on invalid values, and make compact output path-driven with per-subcommand allowlists.
- SCOPE-IN-002 Generated route integration: switch automatic route workflow invocations to `--json=compact` only after allowlist and continuation tests prove required paths remain available.
- SCOPE-IN-003 Size and token-proxy regression coverage: add byte/word-count budgets for context JSON, partitioned context, generated route shells, embedded shared content, and Codex copied shared assets using existing `node:test` patterns.
- SCOPE-IN-004 Shared embedding review: measure Codex duplicated shared content and implement fail-closed de-duplication only if the measured benefit clears the requirement's risk/benefit bar; otherwise record the decision and keep current behavior guarded by tests.
- SCOPE-IN-005 Document fix-report contract: align document and file-set fix reports around the same optional `Verification:` section schema and update parser, prompts, route fixtures, and schema-contract tests together.
- SCOPE-IN-006 Safe fix-report retry: allow document `fix-report-mismatch` recovery through `begin-fix` while reusing the original pre-fix guard baseline and preserving the required diff-review/full-re-review loop.
- SCOPE-IN-007 Documentation and fixtures: update README/developer docs, generated route fixtures, and embedded shared fixtures whenever public behavior or generated text changes.

## Out-of-Scope
- SCOPE-OUT-001 Reducing review depth, reviewer isolation, full re-review, diff review, partitioned review, guard checks, redaction, machine payload validation, or final-response validation.
- SCOPE-OUT-002 Introducing `rtk-ai/rtk` or any new runtime dependency; it is only a design reference for output filtering and budget tests.
- SCOPE-OUT-003 Adding a summarization layer that replaces primary review evidence or quality-gate inputs.
- SCOPE-OUT-004 Large unrelated workflow-state rewrites, broad module reshaping, or fixture churn not required by compact output, route text, or fix-report recovery.
- SCOPE-OUT-005 Mutating remote systems, publishing, committing, or changing historical release notes as part of this requirement.

## Non-Goals
- Do not make token reduction a PASS criterion; PASS remains controlled by the existing review-fix quality gates and re-review results.
- Do not silently hide missing compact fields or parser failures behind fallback behavior.
- Do not weaken prompt/rubric/protocol hard constraints to reduce route shell size.
- Do not allow retry to accept unparsed reports, remap issues, skip ledger checks, or treat already modified content as a clean baseline.

## Assumptions
- The current workflow JSON result shape is sufficiently stable to derive compact allowlists without changing underlying workflow execution semantics.
- Route automation can continue from compact output when all required artifact paths are retained and detailed bodies remain readable from manifest, receipt, or debug artifacts.
- Byte count and word-count proxies are acceptable regression signals because CI must stay offline and dependency-free.
- Prior approved prompt/rubric hardening that touches `shared/prompts/*` and embedded fixtures should be verified before implementation to avoid fixture conflicts.
- The document and file-set fix-report schemas can share the same optional `Verification:` section while preserving target-specific semantics.

## Acceptance Criteria
- `--json`, `--json=full`, `--json=compact`, and invalid `--json=<value>` workflow behavior are covered by tests; bare `--json` remains full-compatible.
- Compact output has per-command allowlist tests that assert required fields exist and large/debug fields such as skeletons, raw prompts, raw transcripts, raw logs, full units, and full summaries are absent unless explicitly allowed.
- Generated Claude Code, Codex, Gemini, and opencode routes use compact workflow output for automated calls and still expose full/debug artifact paths for diagnosis.
- Context JSON and generated route shells have size-budget or snapshot tests that fail on accidental reintroduction of duplicated skeletons, raw prompt bodies, or abnormal shell growth.
- Codex shared de-duplication is either implemented with measured benefit plus offline/fail-closed install coverage, or explicitly recorded as not worth changing after measurement.
- Document `end-fix` accepts valid reports with or without a non-empty `Verification:` section, rejects empty/misordered/unknown sections, and exposes a safe retry path for recoverable `fix-report-mismatch`.
- Retry uses the original begin-fix baseline, validates allowed target/reference changes, reacquires the lock, and resumes into diff review/full re-review rather than PASS.
- README/developer documentation and generated fixtures are updated when behavior changes; `npm run syntaxcheck` and `npm test` pass or any unrun check is called out with residual risk.

## Open Questions
- Does the current branch already contain the 2026-06-23 shared prompt/rubric hardening and related embedded fixture updates that this requirement depends on? [DEFERRED to risk discovery evidence check]
- What initial size-budget thresholds give useful regression protection without creating noisy failures? [DEFERRED to design/spec with current fixture measurements]
- Does Codex shared de-duplication meet a worthwhile benefit threshold after measurement, or should the implementation keep the current static embedding model? [DEFERRED to design/spec measurement]

## Sources
- `00-raw-requirement.md`: source requirement text for token-output, route-shell, shared-embedding, and fix-report resilience goals.
- `01-intake-brief.md`: tier estimate, modifiers, and evidence block generated from the raw requirement.
- `02-project-context.md`: repository context pack showing Node.js/CommonJS project shape, source directories, entrypoint, and `npm test` command.
- Repository guidance: root `AGENTS.md` / provided project instructions covering tests, fixture handling, docs synchronization, and security boundaries.

## Trace
<!-- Map this stage's IDs to upstream/downstream. R3 derives & checks closure. -->
| This ID | Upstream | Status |
|---|---|---|
| SCOPE-IN-001 | raw requirement compact workflow JSON batch | [ADDRESSED] |
| SCOPE-IN-002 | raw requirement generated route compact-output batch | [ADDRESSED] |
| SCOPE-IN-003 | raw requirement size/token regression batch | [ADDRESSED] |
| SCOPE-IN-004 | raw requirement shared embedding de-duplication evaluation batch | [ADDRESSED] |
| SCOPE-IN-005 | raw requirement document fix-report schema batch | [ADDRESSED] |
| SCOPE-IN-006 | raw requirement fix-report retry resilience batch | [ADDRESSED] |
| SCOPE-IN-007 | raw requirement documentation/fixture verification requirements | [ADDRESSED] |
| SCOPE-OUT-001 | raw requirement quality-boundary non-goals | [ADDRESSED] |
| SCOPE-OUT-002 | raw requirement no new runtime dependency constraint | [ADDRESSED] |
| SCOPE-OUT-003 | raw requirement no summarization quality-gate replacement constraint | [ADDRESSED] |
| SCOPE-OUT-004 | raw requirement narrow module boundary constraint | [ADDRESSED] |
| SCOPE-OUT-005 | repository safety and release-side-effect constraints | [ADDRESSED] |

## Upstream Summary (read-only)
# review-fix Token 消耗与循环韧性优化需求

- 日期：2026-06-25
- 范围：workflow JSON 输出、route 生成文本、shared prompt/rubric 嵌入策略、fix report 契约、循环恢复能力、相关测试与文档
- 目标读者：`@xenonbyte/drfx` 维护者与实现 agent
- 状态：需求草案
- 形态：需求文档。本文描述问题、目标、质量边界、需求条目与验收标准；不替代实现期的具体代码方案

## 背景

`@xenonbyte/drfx` 的核心价值是把审查、修复、diff review、full re-review、guard、receipt、状态恢复与平台 route 安装做成可审计的 review-fix workflow。当前项目在质量门上已经相对完整，但执行过程中存在明显的 token 消耗压力和一处循环恢复脆弱点，主要来自三类内容：

1. workflow 命令的默认 JSON 输出含有大量可由路径重新读取的结构化详情。
2. 生成 route shell 中重复嵌入 shared prompt、rubric、protocol 与模板文本，平台越多、route 越多，重复越明显。
3. document route 的 fix report 契约、生成 route 提示和状态机恢复路径不完全一致，导致一次可修正的内部 payload 失配可能让自动 review-fix 循环停在 blocked 状态。

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
- 一次 `review-fix-doc` 实测暴露出循环恢复问题：document route 的 `end-fix` 只接受 `Fixed`、`Files changed`、`Not fixed`、`Residual risk` 四段 fix report；但 route/fixer 提示又要求记录每轮 verification。若 coordinator 把 `Verification:` 写入 document fix report，`end-fix` 会以 `fix-report-mismatch` 阻塞。file-set fix path 已支持 `Verification:` 和 blocked retry，document fix path 目前没有等价恢复路径。

## 已验证的脆弱假设

本需求里最脆弱的假设是：compact stdout 可以稳定枚举，并且不会让 route 后续步骤缺少必要状态。对当前实现的只读核对结论是：该假设可以成立，但前提是先落成 per-command allowlist 和 route-continuation 测试，不能用全局删字段替代验证。

- `workflowJson` 当前返回固定基础字段集合，包括 `targetStateDir`、`manifestPath`、`ledgerPath`、`contextManifestPath`、`contextPackSkeleton`、`reviewGuard`、`stateToken`、`blockingReason`、`statusReason`、`nextAction` 等。这说明 compact 可以从现有字段集合派生，不需要改变底层 workflow 执行语义。
- `formatWorkflowJson` 还会按结果追加锁信息、fix report 路径、final response、partitioned review 的 `units`、`summaries`、`coverageProof` 等字段。这说明 compact 不能只做全局黑名单，必须按 workflow subcommand 定义字段白名单。
- `contextManifestPath` 与 `contextPackSkeleton` 同时返回，且 skeleton 已写入 manifest。默认 stdout 只保留 path、让 route 需要详情时读取 artifact，是正向收益明确且不降低审查质量的优化。
- document `runEndFix` 当前调用 `parseFixReport(payload)`，不会开启 `allowVerification`；file-set `runEndFix` 调用 `parseFixReport(payload, { allowVerification: true })`，并要求 `Verification:` 非空。document route 的契约漂移不是猜测，而是当前 parser 和 workflow 的实际不一致。
- file-set blocked retry 已经在 `begin-fix` 路径复用 persisted baseline、校验 guard、重新加锁，并提示 `retry end-fix with a valid fix report`。document retry 应复用这个状态机思路，而不是设计成绕过 guard 的新捷径。

## 质量边界

任何优化都必须满足以下边界：

- 不减少 reviewer isolation，不取消 read-only reviewer，不绕过 reviewer readiness probe。
- 不减少 stdin handoff proof、write-blocking guard、fingerprint guard、redaction、machine payload validation、final-response validation。
- 不减少 review -> triage -> fix -> verify -> diff review -> full re-review -> repeat 闭环。
- 不用 compact 输出替代真实状态文件、manifest、receipt 或审查上下文。
- 不把 “token 少” 当作 PASS 条件。PASS 只能由既有质量门和 re-review 结果获得。
- 不引入会吞掉错误、静默降级、隐藏 blocker 或扩大自动修复写入范围的逻辑。
- 不引入外部运行时依赖，也不把 `rtk-ai/rtk` 作为本项目 runtime dependency。
- 不为了“继续循环”而接受未解析、未校验或 issue 映射不一致的 fix report。
- 修复 `fix-report-mismatch` 恢复能力时，必须保留原始 pre-fix guard baseline，不能把已经修改后的目标重新当作干净基线。

## 目标

- G1：生成 route 自动调用的 compact workflow JSON 输出更短，只包含 route 串联和用户状态判断所需字段；用户手动 CLI 的裸 `--json` 仍保持等价于 `--json=full`。
- G2：完整诊断信息仍可通过 `--json=full`、manifest path、receipt path 或 debug 路径读取。
- G3：生成 route 默认使用 compact 输出，避免把重复 JSON 继续灌入后续模型上下文。
- G4：新增可执行的体量回归测试，防止 context JSON、route shell、embedded shared 内容无意膨胀。
- G5：借鉴 `rtk-ai/rtk` 的输出过滤思想，只过滤返回面，不改变底层执行和审查语义。
- G6：识别并删除繁琐或冗余流程中的重复输出，优先减少默认数据面，而不是减少质量门。
- G7：所有优化必须有正收益，可量化为 token、字节、重复率、测试稳定性或维护复杂度下降。
- G8：document route 的 fix report 契约、生成 route 提示和状态机恢复路径保持一致；可修正的内部 payload 失配不应迫使用户 reset 才能继续自动循环。
- G9：compact 输出切默认前，必须为 route 自动调用到的 workflow subcommand 建立字段 allowlist，并证明 compact 输出足以驱动后续步骤。

## 非目标

- 不降低审查深度，不把完整文件集审查改为抽样审查。
- 不删除 full re-review、diff review、partitioned units、backstop review 或 aggregate coverage gate。
- 不修改 reviewer 输出 schema 来追求更短输出，除非能证明解析契约和质量门不变。
- 不引入通用 LLM 总结层来压缩 reviewer 证据。模型总结可能丢失 blocker，不适合作为质量门前置。
- 不把 prompt、rubric、workflow hard constraints 做语义删减。可去重、可延迟读取、可压缩重复措辞，但不得减弱规则。
- 不以大规模重构为目标。只有当冗余流程或结构问题直接增加 token、漂移或维护风险时才改。
- 不把 blocked retry 设计成跳过 diff review 或 full re-review 的捷径。恢复后仍必须走完整闭环。
- 不允许 route 自行手改 `.drfx` manifest 或 ledger 来绕过状态机。

## 需求条目

### 批次 A：compact workflow JSON

#### A0 建立 compact stdout 字段 allowlist

- 现状：`workflowJson` 和 `formatWorkflowJson` 当前返回一个较宽的字段集合，其中既有 route 串联必须字段，也有 path-readable、debug-only 和 partitioned review 大字段。
- 需求：
  - 对每个 route 自动调用的 workflow subcommand 建立 compact 字段 allowlist，至少覆盖 `preflight`、`start`、`context`、`record-review`、`record-triage`、`begin-fix`、`refresh-lock`、`end-fix`、`abort-fix`、`record-diff-review`、`finalize`，以及 file-set/partitioned review 专属 subcommand。
  - allowlist 中的字段必须按用途标记为 `stdout required`、`path readable`、`user status` 或 `debug only`。compact stdout 只能默认返回 `stdout required`、`user status` 和 `path readable` 的路径值，`debug only` 只在 full 或 debug 输出里出现。
  - compact 必须保留 route 串联需要的路径字段，例如 `targetStateDir`、`manifestPath`、`ledgerPath`、`contextManifestPath`、`reviewerReportPath`、`fixReportPath`、`receiptPath`、`reviewPlanPath` 等按 subcommand 需要出现的路径。
  - compact 不得返回 raw prompt、raw transcript、raw log、完整 file skeleton、完整 `units`、完整 `summaries` 或可通过 artifact 路径读取的大对象。
- 验收：
  - 每个已列 subcommand 都有 compact allowlist 测试，测试同时断言必要字段存在和大字段缺席。
  - route fixture 或 workflow smoke 测试证明 generated route 使用 compact stdout 后仍能找到下一步所需 artifact。
  - 新增 subcommand 或新增 stdout 字段时，必须更新 allowlist 测试，否则测试失败。

#### A1 支持 `--json=compact|full`

- 现状：CLI 已有 `--json` 检测，但 workflow 参数解析把 `--json` 当作 boolean flag，`--json=<value>` 尚未成为稳定契约。
- 需求：
  - `--json` 保持现有兼容语义，等价于 `--json=full`。
  - 新增 `--json=compact`，作为 route 内部默认使用的短输出格式。
  - 非法取值必须 fail closed，输出明确错误，不回退到 full 或 compact。
  - compact 与 full 只影响 stdout JSON 形状，不影响状态文件、manifest、receipt、guard 或审查 payload。
  - `--json=compact|full` 仅作用于 `workflow` 子命令；`doctor` / `status` 的 `--json`（boolean，喂给 strict-verified proof 流）不在本需求范围，保持现状不变。
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
  - partitioned review 的 `units`、`summaries`、`coverageProof` 等大字段是否进入 compact，必须由 A0 的 subcommand allowlist 明确决定，不能沿用 full 的默认追加字段。

### 批次 B：route 默认使用 compact 输出

#### B1 生成 route 调用切换到 `--json=compact`

- 现状：生成 route 内部调用 workflow 命令时使用 JSON 输出，容易把完整结构传给后续模型上下文。
- 需求：
  - 只有 A0 的 allowlist 和 route-continuation 测试通过后，才能把 generated route 默认调用切到 `--json=compact`。
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
  - 去重前必须先给出字节或 token proxy 测量，证明收益来自重复内容减少，而不是删减 prompt、rubric、protocol 或 workflow hard constraints。
  - 只有在体量下降达到实现前设定的最低收益阈值，且离线、安装、缺失文件 fail-closed 测试都通过时，才允许改 Codex skill 读取策略。
  - 若改动，必须保证离线安装、skill discoverability、route invocation、共享规则读取均可靠。
  - 若收益不明显、风险大于收益，或需要新增脆弱运行时读取路径，应保留现状，并只用 size test 防止继续膨胀。
- 验收：
  - 评估报告或测试输出记录去重前后的 route/skill 字节数、重复率或 token proxy 变化。
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
  - 对 workflow 输出字段做一次字段级审查，标记 `stdout required`、`path readable`、`user status`、`debug only` 四类。该四类分类的唯一真相源是 A0 的 per-command allowlist（及其测试数据）；本条不得形成与 A0 并行的第二份字段清单，只负责把该分类以可读注释或文档形式固化。
  - 默认 stdout 只保留 `stdout required`、`user status` 和 `path readable` 的路径值。
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

### 批次 F：workflow 循环恢复与契约一致性

#### F1 统一 document fix report 契约与 route 提示

- 现状：document fix path 只解析四段 fix report（`runEndFix` 调用 `parseFixReport(payload)`，不开 `allowVerification`），但 `fixer.md` 与 `coordinator.md` 无条件要求每轮记录 verification，file-set fix path 已支持可选 `Verification:` 段。结果是 prompt 要求与 parser 接受范围不一致：coordinator 把 `Verification:` 写入 document fix report 时，`end-fix` 以 `fix-report-mismatch` 阻塞。
- 决议（2026-06-25）：采用「对称可选」修法——让 document fix report 与 file-set 完全一致地接受**可选**的 `Verification:` 段，而不是把它做成 document 专属的强制段。这样无条件的 prompt 指令对两类 route 同时为真，彻底消除 schema 分叉，也不引入「document 比 file-set 更严」的新非对称。
- 需求：
  - document `runEndFix` 在 review-and-fix 路径启用 `allowVerification` 解析，使 document fix report 与 file-set 共用同一份 section schema：`Verification:` 为可选段，位于 `Not fixed:` 与 `Residual risk:` 之间。
  - `Verification:` 一旦出现必须非空（沿用既有 `requireListLines` / `redactText` 非空守卫，无需新增校验），内容为实际验证命令/检查方法加结果，或在无法运行验证时写明原因；缺失该段不阻塞（与 file-set 行为一致）。
  - parser 继续用 `allowVerification` 控制 schema，但 document 与 file-set 都开启它；两者 fix report schema 的差异仅允许体现在 target/file-set 语义（单文档 vs 文件集）上。
  - shared fixer prompt、coordinator prompt、generated route fixture、parser 测试和 workflow 测试必须描述同一份 fix report schema，且 `fixer.md` / `coordinator.md` 中「每轮记录 verification」的指令对 document 与 file-set 都可满足。
- 验收：
  - 含 `Verification:` 的 document fix report 能被 parser 和 workflow 接受；不含 `Verification:` 的 document fix report 仍按四段被接受，不阻塞。
  - `Verification:` 出现但为空、section 顺序错误或出现未知 section 时，document `end-fix` 以 `fix-report-mismatch` 阻塞，并给出可恢复下一步。
  - document 与 file-set 共用同一 section schema 测试夹具；任何一侧新增或删减 section 必须同步另一侧，或显式说明这是 target 语义差异。

#### F2 `fix-report-mismatch` 支持安全重提

- 现状：document `end-fix` 一旦因 fix report 格式或 issue 映射失配进入 `blocked`，后续不能直接补交正确 report 继续原 fix round；用户只能 reset 或人工清理状态。file-set path 已有部分 blocked retry 能力。
- 需求：
  - document route 必须复用 `begin-fix` 作为 blocked retry 入口：当 manifest 为 `Status: blocked`、`Current phase: fix`、`Blocking reason: fix-report-mismatch`，再次 `begin-fix` 应进入安全重提模式，并返回 `retry end-fix with a valid fix report` 一类下一步。
  - retry 必须复用原始 `begin-fix` guard baseline，不能重新采样已修改后的目标作为 pre-fix baseline。
  - retry 前必须确认目标修改仍只发生在允许的 target 文件内，reference 文件未变，target-only guard 可验证，rollback anchor 仍可用，并且锁能重新获取。
  - retry 只能恢复到可提交 `end-fix` 的状态，不能修改 accepted findings、跳过 ledger 校验或直接推进到 diff review。
  - 重提成功后必须继续 `diff review -> full re-review`，不能直接 PASS。
- 验收：
  - 测试覆盖：第一次 `end-fix` 提交无效 fix report 后进入 `fix-report-mismatch`，随后提交有效 report 可继续到 `diff-review`。
  - 测试覆盖：retry 期间出现 reference 变化、非 target 变化、target-only guard 不可用时仍 fail closed。
  - 测试覆盖：retry 不会重写 pre-fix baseline，不会把已经修改后的目标当作干净基线。
  - 成功 retry 后 ledger 中 accepted issue 被更新为 fixed，manifest 的 `lastFixReportPath`、`lastKnownContentSha256` 和 current phase 正确推进。

#### F3 修复提示与解析器的契约回归测试

- 需求：
  - 本项作为批次 F 的锚点优先落地：它能自动拦下 prompt 与 parser 之间的 schema 漂移（含 F1 修复后的回归），F1/F2 的契约改动都应先有 F3 守护。
  - 增加一组“prompt schema vs parser schema”测试，至少覆盖 reviewer result、triage result、document fix report、file-set fix report、diff review 和 final response。
  - 测试不需要理解自然语言质量，只检查 route/prompt 中给出的机器 payload section 名、顺序和必填字段是否能被 parser 接受。
  - 当 shared prompt 或 parser 任一侧修改 schema 时，fixture diff 必须显式显示两边同步变更。
- 验收：
  - 故意在 document fixer prompt 中加入 parser 不支持的 section 时测试失败。
  - 故意让 parser 新增必填字段但 prompt 未更新时测试失败。

#### F4 blocker 输出给出可恢复路径

- 需求：
  - `fix-report-mismatch` 默认用户输出应说明是内部 payload 契约问题、目标是否已经被写入、是否需要 `resume`、`reset` 或 retry。
  - debug 输出可以给出 redacted parser 错误和 report path，但不得打印 raw prompt、raw transcript 或目标正文。
  - 当 retry 能继续时，默认下一步应是 retry；只有无法安全 retry 时才建议 `reset`。
- 验收：
  - document route 和 file-set route 的 `fix-report-mismatch` 输出可区分“可重提 report”和“必须 reset/人工处理”。
  - 用户可见输出不暴露内部 issue IDs、raw JSON 或原始 payload 正文。

## 验证要求

- 每个实现批次至少运行：
  - `npm run syntaxcheck`
  - `npm test`
- 涉及生成模板、shared prompt、rubric 或 fixture 的改动，必须更新并审查对应 fixture。
- 涉及 README 行为说明的改动，必须保持 `README.md` 与 `README.zh-CN.md` 结构同步。
- 任何 compact/full 行为改动必须有针对性测试，包括 per-command allowlist、必要字段存在、大字段缺席和 generated route 后续步骤可继续。
- fix report schema、blocked retry 或 route prompt 改动必须有针对性 workflow 测试，覆盖 document route 和 file-set route 的差异。
- `fix-report-mismatch` 恢复能力必须至少有一个失败后成功重提的回归测试。
- Codex shared 去重只有在收益测量、离线执行、安装路径、缺失 shared source fail-closed 测试都通过后才能实施；否则必须记录为暂不改行为。
- 若某项检查无法运行，最终说明必须列出原因和剩余风险。

## 回滚

- A、B、C 批次应可独立回滚。A 是 CLI 输出契约扩展，B 是 route 调用方式，C 是测试护栏。
- D 批次涉及 Codex skill shared 嵌入策略，风险高于 A 到 C，应单独提交并保留明确 fixture diff。
- F 批次涉及 workflow 状态恢复，应单独提交或至少与 token 输出压缩解耦，避免把恢复语义变更混进体量优化 diff。
- 所有批次不做数据迁移、不修改远端状态、不改变已有 workflow state 文件的读取语义。

## 风险与依赖

- compact 输出如果字段删减过度，可能导致 route 后续步骤拿不到必要路径。必须用 route 级 fixture 和 workflow e2e 测试覆盖。
- route shell 去重如果做得过深，可能让平台在缺少 shared source 时失败方式不清晰。必须 fail closed，并给出可读错误。
- Codex shared 去重如果收益不足，反而会把一次静态嵌入变成运行时文件读取风险。D1 必须允许“测量后不改行为”作为合格结论。
- 体量预算阈值过紧会制造维护噪音，过松又拦不住回归。初始阈值应基于当前 fixture 加合理余量，并在增长时要求显式说明。
- `fix-report-mismatch` retry 如果设计过宽，可能把真实状态漂移误判为可恢复错误。retry 必须绑定原 begin-fix baseline、target-only guard 和 reference fingerprint。
- document 与 file-set fix report schema 现统一为同一份（仅 target 语义不同，见 F1 决议）；若未来再分叉，route 生成文本、shared prompt 和 parser 测试必须把差异显式化。
- 开工前需确认 2026-06-23 已批准的加固批次（P2/P3/PLAN-rubric）若涉及 `shared/prompts/*` 与 `embedded/` fixture 再生已全部落地；本需求的 F1/D2/B1 也会再生这些 fixture，未落地的前序改动会造成 fixture 冲突。`fixer.md` 现含 “Surfacing is a valid fix”（3b 标志），据此判断前序大概率已落地，仍需开工前核对。
- 本需求无新增第三方 runtime 依赖。`rtk-ai/rtk` 仅作为设计参考，不纳入依赖树。

## 完成定义

本需求完成时，应同时满足：

- 用户手动 CLI 的裸 `--json` 仍保持 full 兼容语义，生成 route 内部 workflow 调用已使用 compact 输出。
- route 自动调用到的 workflow subcommand 都有 compact allowlist 测试，compact 输出被证明足以驱动后续步骤。
- full 输出、manifest、receipt 和 debug artifact 仍可支持完整诊断。
- 审查和修复质量门没有减少。
- context JSON 和 route shell 有体量回归测试。
- shared prompt/rubric 的变更有 fixture 或 snapshot 守护。
- Codex shared 去重已通过收益门槛和 fail-closed 测试，或被明确记录为收益不足而暂不改行为。
- document route 的 fix report 契约与 generated route 提示一致，`fix-report-mismatch` 可在安全条件下重提并继续完整 review-fix 循环。
- README 或开发文档已说明 compact/full 语义和调试入口。
- 全量语法检查和测试通过，或明确说明无法运行的检查与风险。
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 50673}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
