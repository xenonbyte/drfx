# Document Review Loop Design v2

## 1. 背景

V1 定义了完整的文档审查修复闭环：

```text
review -> triage -> fix -> diff review -> full re-review
```

这个方向是对的，但当前实现并没有真正执行这个闭环。当前包实际交付的是安装器、平台路由生成器、共享 prompts、rubrics，以及一组安全辅助库。生成出来的 platform routes 是指令包，不是可执行 coordinator。当前没有任何命令或库入口会解析一次用户调用，然后端到端驱动 review、triage、fix、diff review、full re-review、ledger 更新、target lock、receipts 和 resume state。

本文档基于以下来源对照后编写：

- `design/DESIGN-v1.md`
- `docs/superpowers/specs/2026-05-20-document-review-loop-v1-implementation-design.md`
- `docs/superpowers/plans/2026-05-20-document-review-loop-v1-implementation-plan.md`
- `shared/rubrics/spec.md`
- `shared/rubrics/plan.md`
- 当前 `bin/`、`lib/`、`skills/`、`shared/`、`templates/`、`test/` 下的源码

当前仓库存在 v1 implementation spec/plan，但它们描述的是从空 workspace 构建 v1 package 的历史计划，其中部分事实已经被当前源码取代，例如 package name、已存在文件集合和 git/workspace 状态。V2 把这些文档作为 historical prior design input；当它们与当前 `package.json` 或源码冲突时，以当前源码为准。本文档只把当前仓库真实存在的文件作为既有依据。

所以当前包更准确的定义是：

```text
drfx CLI          = installer, uninstaller, capability checker
generated routes  = Codex skills / Claude Code commands / Gemini commands with route-specific workflow instructions and embedded rubrics
lib/*             = unconnected helper modules for parsing, state, locks, ledgers, manifests, receipts, redaction, capabilities, and install safety
```

它还不是：

```text
an executable document review-fix workflow
```

## 2. 当前实现快照

当前已经实现并可用的内容：

- `package.json` 声明了 `@xenonbyte/document-review-fix`、CommonJS、Node.js `>=20.0.0`、`bin.drfx` 和 `npm test`。
- `bin/drfx.js` 只支持 `check`、`install` 和 `uninstall`。
- `lib/input.js` 解析 entry skill 调用，并校验 target/reference/root 路径。
- `lib/target-state.js` 计算 target key、校验 custom ledger path、格式化和读取 manifest、评估 resume 冲突，并计算 fingerprint。
- `lib/ledger.js` 格式化和解析 issue ledger table，并支持 issue status transition。
- `lib/lock.js` 实现 target-local lock acquire、refresh、pre-fix fingerprint guard 和 owner-checked release。
- `lib/receipts.js` 格式化和写入 round receipts。
- `lib/rulebook.js` 解析和合并 custom rulebooks，并检查 hard-constraint conflict。
- `lib/redaction.js` 对常见 secret-like values 做 redaction。
- `lib/capability.js` 构建和校验 capability descriptors，并通过 OS temp fixtures 校验 fingerprint guard support。
- `lib/adapters/claude.js` 和 `lib/adapters/codex.js` 返回 `unverified` reviewer isolation 和 write blocking。
- `lib/adapters/gemini.js` 返回 `unsupported` reviewer isolation 和 write blocking。
- `lib/generator.js`、`lib/install.js` 和 `lib/manifest.js` 生成、安装、卸载并校验 platform route files 和 manifests。
- `shared/core.md`、`shared/long-task.md`、`shared/rubrics/*` 和 `shared/prompts/*` 记录了预期 workflow。
- `skills/review-fix-*` source skills 是简短 route descriptors。
- 测试覆盖了很多 helper modules 和 generated text。

当前尚未实现的内容：

- 没有 coordinator runner。
- 没有可执行的 `review -> triage -> fix -> diff review -> full re-review` loop。
- 一次真实 skill invocation 不会创建 project-local `.docs-review-fix/targets/<target-key>/`。
- 不会自动 dispatch reviewer subagent。
- 没有 reviewer output parser。
- 没有把 reviewer findings 转成稳定 `ISSUE-###` ledger rows 的 triage engine。
- 没有 fix round engine。
- 没有 diff review engine。
- 没有 full re-review engine。
- 没有 runtime resume command 或 route behavior 会从 target-local state 继续。
- 没有 generated route 会真正调用 helper libraries 来创建 state、locks、ledgers、receipts 和 context packs。
- 没有 final response builder 来强制执行 v1 final response contract。

## 3. V2 目标

V2 要把这个包从 instruction bundle 变成 practical agent-runtime-executable review-fix workflow。首批路径以 Codex Practical 为必达目标；Claude Code generated command 实现同一套 Practical 路径，但只有当前 Claude Code runtime 同时暴露 reviewer delegation、fingerprint guard 和 stdin handoff 时才声明 Practical 可用，否则必须降级或 fail closed。

默认 v2 路径是 **Practical Mode**：

- Codex 或 Claude Code 的 host agent 是 coordinator。
- 当前 runtime 可用 subagent delegation / Task-style reviewer mechanism 时，使用该 runtime 的 reviewer subagent 作为 reviewer。
- coordinator 默认直接修复 accepted issues。
- 对 bounded issue list，可选使用一个 serial fixer subagent。
- target locks、fingerprints、target-only writes、ledgers、manifests、receipts 和 full re-review 都是强制项。
- 只有 persistent `review-and-fix` workflow 在 full-document reviewer `PASS`，或 reviewer `FAIL` 仅包含所选 strictness 允许的 explicitly accepted non-blocking low findings，且 coordinator agreement 后，workflow 才能进入 `pass`。
- final response 必须把 assurance level 标为 `practical`，并记录 `Runtime platform: codex | claude-code`。

V2 保留 **Strict Verified Mode**，作为未来或可选的更高保障路径：

- Strict verified mode 需要 reviewer isolation 和 write blocking 的 machine-verifiable proof。
- 当前 Claude 和 Codex adapters 不提供这个 proof。
- 缺少 strict proof 不得阻塞 Practical Mode。

V1 到 V2 的核心修正是：

```text
Missing machine-verifiable write blocking is not allowed to make the practical workflow useless.
It only prevents claiming strict verified reviewer isolation.
```

## 4. 非目标

V2 不做这些事：

- 不引入 TypeScript、Babel、bundlers 或 runtime dependencies。
- 如果 runtime 本身没有暴露能力，不实现生产级 Codex 或 Claude Code runtime capability API。
- 不让 Gemini 具备 automatic-fix 能力。
- 不修改 reference documents。
- 不允许多个 fixers 并发编辑同一个 target。
- 不在非 git document project 中执行 automatic target writes；没有 git rollback anchor 时只允许 read-only/advisory。安全备份方案不属于 v2 范围。
- 不把 raw secrets、raw logs、credentials、cookies、tokens、private keys 或 transcript dumps 写入 workflow state。
- 不依赖 chat history 做 resume。
- 当用户明确要求人工确认时，不替代 human judgment。

## 5. 当前缺口矩阵

| Area | V1 intent | Current state | V2 requirement |
|---|---|---|---|
| CLI entry | Short route invocation starts the workflow | `drfx` only supports `check/install/uninstall` | Keep public `check/install/uninstall`; add internal deterministic `drfx workflow ...` commands that generated routes actually use |
| Generated route | Runs the loop behind `$review-fix-*` / Claude Code command | Embeds rules and prompts only | Must instruct and drive the coordinator through concrete state-backed steps |
| Coordinator | Owns review, triage, fix, diff review, re-review, state, final status | Only a prompt template exists | Implement coordinator execution contract and generated-route procedure |
| Reviewer dispatch | Mandatory isolated read-only reviewer for initial review and full re-review | No dispatch code or route procedure | Practical Mode must spawn a reviewer subagent and record guard fingerprints |
| Reviewer output | `PASS` or structured `FAIL` findings | Schema exists only in prompts | Add parser/validator for reviewer reports |
| Triage | Findings become accepted/reopened/merged/downgraded/rejected/deferred triage decisions with stable ledger rows | Ledger helpers exist but are not connected; ledger statuses are `accepted/fixed/merged/rejected/deferred/reopened` and do not include `downgraded` | Add triage recording, stable issue ID assignment, explicit reopened mapping, and an explicit downgraded-to-ledger mapping |
| Fix | Coordinator fixes accepted issues directly by default | No fix engine or route step | Generated route must direct the LLM coordinator/fixer to perform bounded target-only edits under lock |
| Diff review | Required after each fix round | Prompt text only | Add coordinator diff-review contract plus deterministic receipt/status recording |
| Full re-review | Required after every fix round | Prompt text only | Route must spawn fresh reviewer after every fix round |
| Target state | `.docs-review-fix/targets/<target-key>/` stores state | Helpers exist but no runtime caller | Create/update target state during real workflows |
| Manifest | Tracks status, fingerprints, target, refs, strictness, mode, ledger | Formatter/parser exists | Coordinator must write and update it on each phase transition |
| Ledger | Stores durable issue state | Formatter/parser exists | Coordinator must create, update, and resume from it |
| Receipts | Written for audit trail, round 2+, interruptions, blockers | Formatter/writer exists | Coordinator must write receipts at required stop points |
| Lock | Protects target before writes | Lock helper exists | Coordinator must acquire, refresh, pre-fix check, and release it during fixes |
| Reviewer guard | Fingerprint target and refs before and after review | Capability probe exists, but no workflow guard | Add per-review target/reference fingerprint guard |
| Resume | Continue from target-local state | Resume evaluator exists | Add route behavior for `resume` |
| Capability gate | Strict proof needed for automatic PASS | Blocks practical usefulness by design interpretation | Split `practical` from `strict-verified` |
| Final response | Reports changes, verification, terminal state, risk | Prompt text only | Add final response checklist and generated route enforcement |
| Tests | Cover workflow behavior | Mostly helper and text tests | Add end-to-end fixture tests for practical workflow state transitions |

## 6. Capability Model

V2 使用三个 assurance levels：

- `advisory`
- `practical`
- `strict-verified`

`Status`、`Current phase`、`Assurance` 和 `Runtime platform` 是四个不同字段：

- `Status` 是当前 workflow state。它可以是 active phase state（`review`、`triage`、`fix`、`diff-review`、`full-re-review`）或 terminal/pause state（`pass`、`read-only-clean`、`blocked`、`read-only-findings` 等）。V2 implementation 必须把新增 terminal/pause statuses 加入 manifest status enum。
- `Current phase` 是 resume/report 指针。Active phase state 下它必须等于 `Status`；terminal/pause state 下它记录 workflow 停止时所在 phase，`pass` 时写 `final`。
- `Assurance` 描述本次运行的保障级别。
- `Runtime platform` 描述 generated route 或 direct command 的运行宿主。允许值是 `codex`、`claude-code`、`gemini` 和 internal tests 使用的 `manual`。它不得混入 `Assurance`。

Practical PASS 必须表示为 `Status: pass` plus `Assurance: practical`，不得新增 `practical-pass` 之类的 terminal status。该组合只允许出现在 persistent `review-and-fix` finalization 中。

本文档不使用 `blocked: <reason>` 作为状态简写。Manifest、JSON output、reports、receipts 和 final response 必须表达为 `Status: blocked` plus `Blocking reason: <reason>` / `blockingReason: <reason>`，不得把 blocker code 拼进 manifest status value。

### 6.0 Advisory Mode

Advisory Mode 是所有 platform 在 capability 不足时的共享降级路径。

要求：

- 可以运行 read-only advisory review。
- 可以输出 findings、risk、recommended fixes 和 next actions。
- 不得编辑 target files。
- 不得声明 workflow PASS。
- Effective mode 必须是 `read-only`。任何 persistent manifest 或 no-state JSON output 都不得出现 `Assurance: advisory` plus `Mode: review-and-fix`。
- final response 必须声明 `Assurance: advisory`。
- 正常完成时 final status 必须是 `read-only-clean`、`read-only-findings` 或 `unsupported`。`read-only-clean` 表示 read-only review 没有发现会阻塞所选 strictness 的 finding，但它不是 workflow PASS，也不得被表述为 PASS。
- 如果 advisory run 在 parser、fingerprint guard、final validation 或 state validation 上遇到不可恢复 blocker，可以停止为 `Status: blocked` plus allowed `Blocking reason`；仍然必须声明 `Assurance: advisory`，且不得编辑 target files。

Codex 或 Claude Code 在无法使用 reviewer subagent 时，必须降级为 Advisory Mode。Gemini 在 v2 始终使用 Advisory Mode。

Advisory Mode 的 review producer 是 coordinator，不是 isolated reviewer subagent。降级到 Advisory Mode 后，generated route 不再尝试 spawn reviewer subagent；coordinator 对 target/reference 做 read-only review，并输出与 reviewer result 相同的 `PASS`/`FAIL` schema 交给 `record-review`。该结果必须在 reports/JSON 中标记为 coordinator-produced advisory review；它可以支持 `read-only-clean` / `read-only-findings`，但永远不能支持 workflow `pass`。

Fingerprint guard 不是可选降级项。任何 workflow-command-backed review，不论 `Assurance` 是 `practical` 还是 `advisory`，都必须能在 review 前后计算 target/reference fingerprints，并为 no-state flow 生成 `reviewGuard`。如果 fingerprint guard 不可用或输出不可解析，本次 workflow 停止为 `Status: blocked` plus `Blocking reason: fingerprint-guard-unavailable` 或 `fingerprint-guard-output-invalid`；generated route 不得重跑一个缺少 `reviewGuard` 的 advisory flow。

Mode/assurance normalization rules:

- User-facing generated route 支持三个 invocation intent：`explain`、`read-only` 和 `review-and-fix`。如果用户没有传 `read-only` 或 `review-and-fix`，默认 intent 是 `explain`：route 只输出用法、当前 capability/assurance 含义和下一步命令示例，不运行 `drfx workflow ...`，不读取 target/reference，不创建 state，也不声明 review result。
- Internal workflow commands 只接受 `read-only` 和 `review-and-fix` 两种 `Mode`；`explain` 不得写入 manifest、JSON output 或 final response。Generated routes 必须在调用 internal workflow commands 前把 `explain` 截停。
- User-facing generated route 支持一个可选 assurance request token：`assurance=practical|strict-verified|advisory`。`strict` 和 `normal` 只表示 review strictness，永远不能被解释为 assurance。没有 `assurance=` token 时，Codex/Claude Code generated routes 默认请求 `practical`，Gemini 默认请求 `advisory`。只有显式 `assurance=strict-verified` 才能触发 strict verified proof flow；如果同时缺少 `read-only`/`review-and-fix` mode token，route 仍按 `explain` intent 停止，不运行 proof flow。
- Codex/Claude Code route 中显式 `assurance=advisory read-only` 表示用户主动选择 coordinator-produced advisory review，不是 practical runtime downgrade。Route 必须跳过 subagent probe，传 `--runtime-subagent-probe not-required --runtime-downgrade-reason none`，仍必须在 review guard 和任何 semantic stdin handoff 前满足 fingerprint guard 和 stdin handoff requirements。
- V2 必须兼容当前 `lib/input.js` 的既有调用。实现方式固定为扩展 `parseInvocation(entrySkill, tokens, options)`，新增可选 `options.defaultMode`、`options.defaultAssurance` 和 `options.includeMetadata`。未传 options 时行为保持 v1：默认 `mode: "review-and-fix"` 且不解析 assurance，避免破坏现有 tests 和 source skill parsing。Workflow commands 必须调用 `parseInvocation(..., { defaultMode: "read-only", defaultAssurance: <route-or-command-default>, includeMetadata: true })`，并读取返回的 `modeSource: "explicit" | "default"`、`requestedAssurance: "practical" | "strict-verified" | "advisory" | null` 和 `assuranceSource: "explicit" | "default" | null`。`assurance=` 只在 `includeMetadata: true` 时可解析；未传 options 的 source skill parsing 继续把 `assurance=` 当作 unknown token 拒绝。
- Workflow parser 需要区分 `requestedMode` 和 `effective mode`。`requestedMode` 来自显式 route tokens；direct manual/test 调用省略 mode token 时，由 workflow command 通过上面的 parser options 把 parser default 固定为 `read-only`。`effective mode` 是写入 manifest、JSON output 和 final response validation 的 `Mode`。
- `Assurance: advisory` 时，`effective mode` 必须是 `read-only`。
- 如果用户或 route 请求 `review-and-fix`，但 subagent runtime check 降级为 Advisory Mode，generated route 必须把 `effective mode` 改为 `read-only`，传入具体 `--runtime-downgrade-reason <code>`，并在 final response 的 deferrals/blocks 区域说明原始请求是 `review-and-fix` 但本次只执行 read-only advisory review。Workflow JSON 必须保留 `requestedMode: review-and-fix`、`mode: read-only` 和 `modeNormalizedFrom: review-and-fix`。
- 如果 direct manual/test `workflow start` 未传 `--assurance`，internal command 默认 `Assurance: advisory`；此时只有显式或隐式 read-only 启动有效。若 tokens 显式包含 `review-and-fix`，必须返回 validation error `advisory-review-and-fix-unsupported`，不得创建 manifest。
- 如果 direct manual/test `workflow start` 同时省略 `--assurance` 和 mode token，internal command 必须使用 `requestedMode: read-only`、`effective mode: read-only`、`Assurance: advisory` 和 `modeSource: default`，并在 JSON output 中返回 `modeNormalizedFrom: null`。Generated routes 不得依赖这个默认；它们必须在 route 层先判断 `explain` intent，并在运行 workflow commands 时显式传入 runtime check 后的 assurance 和 effective mode。

### 6.1 Practical Mode

Practical Mode 是 generated Codex skills 和 generated Claude Code commands 的默认有用模式。

要求：

- Generated route 必须在当前 session 内做 runtime check，并把自己的 platform 固定传给 internal commands。Codex generated skill 传 `--runtime-platform codex`；Claude Code generated command 传 `--runtime-platform claude-code`；Gemini generated command 传 `--runtime-platform gemini` 且始终 advisory。Direct manual/test use 可以传 `--runtime-platform manual`。
- Runtime platform 不通过模型名称、环境变量或自然语言自述自动猜测。它由 installed generated entrypoint 绑定：Codex skill 入口只能传 `codex`，Claude Code command 入口只能传 `claude-code`，Gemini command 入口只能传 `gemini`；internal commands 只校验该 enum 和 assurance 组合，不负责识别宿主。
- 如果 host agent 当前不能调用本 platform 的 reviewer delegation mechanism，则本次运行降级为 Advisory Mode。无法在 reviewer/advisory review 前后运行 fingerprint guard 时，本次 workflow fail closed，不降级。
- Runtime check 的 subagent 判定必须是一次真实 probe，而不是文本自述。Generated route 在 `workflow start` 前尝试 spawn 一个不读取 target/reference、不写文件的 reviewer probe；Codex route 使用 Codex subagent delegation，Claude Code route 使用 Claude Code Task/subagent reviewer mechanism。Probe prompt 只要求返回精确字符串 `DRFX_REVIEWER_READY`。如果 subagent tool 不存在、tool call 不可发起、probe 报错、返回值不是精确字符串，或需要用户确认才能继续，判定为 unavailable/failed。
- Subagent probe failure mapping 固定如下：tool 不存在或当前 route 无法发起 tool call -> `--runtime-subagent-probe unavailable --runtime-downgrade-reason subagent-delegation-unavailable`；tool call 报错、timeout、被用户/host 拒绝或无法读取返回值 -> `--runtime-subagent-probe failed --runtime-downgrade-reason reviewer-dispatch-failed`；返回值不是 exact single line `DRFX_REVIEWER_READY` -> `--runtime-subagent-probe failed --runtime-downgrade-reason reviewer-probe-invalid`。Generated route 不得把 probe prompt 的自然语言回复解释为 ready。
- Runtime check 的 fingerprint 判定由 internal workflow command 执行，分成两个不同步骤。`workflow start` 必须在任何 persistent state write 前执行 startup fingerprint probe：解析 target/reference path 后立即计算一次 current fingerprints，证明 fingerprint guard 可运行，并把结果写入 JSON output 的 `runtimeCheck.fingerprintGuard` 和后续 manifest 的 `Runtime fingerprint guard`。`workflow context` 负责建立具体 review phase 的 reviewer guard baseline；persistent flow 把 baseline 写入 context manifest，no-state flow 把 baseline 写入 `reviewGuard`。如果 fingerprint command 失败或输出不能解析，本次 workflow fail closed 为 `Status: blocked` plus `Blocking reason: fingerprint-guard-unavailable` 或 `fingerprint-guard-output-invalid`。
- Persistent `workflow start --assurance practical|strict-verified|advisory` 必须先完成 token parse、path validation、assurance/mode validation、runtime flag validation 和 startup fingerprint probe，再创建或修改 `.docs-review-fix` state。若 fingerprint guard 不可用或输出无法解析，command 必须返回 `ok: false` JSON，`status: blocked`，`blockingReason: fingerprint-guard-unavailable` 或 `fingerprint-guard-output-invalid`，且不得创建 target state directory、写 partial manifest 或写 advisory downgrade manifest。Generated route 必须停止，不得用 advisory mode 重跑无 guard workflow。
- No-state `workflow context --no-state --assurance practical|advisory` 若无法计算 review guard baseline，必须返回同样的 `ok: false` JSON，不得返回不完整 `reviewGuard`，也不得进入 `record-review`。
- `workflow start --assurance practical` 必须带 `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready` 和 `--runtime-stdin-handoff ready`；缺少这些 flags 或值不是 `ready` 时，internal command 必须拒绝 practical state/final PASS persistence。Practical 的 subagent probe 和 stdin handoff probe 是 generated route 在当前 session 内提供的 runtime assertion，不是 strict proof；internal command 必须把它们记录为 `runtimePlatform`、`runtimeCheck.subagentProbe.status: ready`、`runtimeCheck.subagentProbe.evidence: route-asserted-ready`、`runtimeCheck.stdinHandoff.status: ready` 和 `runtimeCheck.stdinHandoff.evidence: route-asserted-ready`。No-state commands 在 `--assurance practical` 时也必须带相同 `--runtime-platform`、`--runtime-subagent-probe ready` 和 `--runtime-stdin-handoff ready`，否则返回 validation error JSON。
- Persistent `workflow start` 必须把 runtime check 结果写入 `MANIFEST.md`，后续 persistent subcommands 只能从 manifest 派生 `runtimeCheck`，不得要求 coordinator 重传或重新声明 probe 结果。
- `read-only` run 不得产生 `Status: pass`。这条规则同时适用于 no-state read-only 和带 `ledger=` / `resume` 的 persistent read-only。Clean read-only result 一律使用 `Status: read-only-clean`，并在 final response 中明确它不是 workflow PASS。
- `pass` 只允许 persistent `review-and-fix` workflow 使用，并且必须由 latest review/fix/diff-review/full-re-review state、final response validator 和 coordinator agreement 共同支撑。
- 如果用户请求 `review-and-fix` 但 subagent runtime check 降级到 Advisory Mode，generated route 必须把本次有效 mode 改为 `read-only`，不得进入 fix。没有 `ledger=` 且没有 `resume` 时使用 no-state advisory flow；有 `ledger=` 或 `resume` 时创建/读取 persistent state，但 manifest 必须写 `Mode: read-only`、`Assurance: advisory`、`Blocking reason: none` 和对应 `Runtime downgrade reason`。
- Advisory downgrade 必须在 final response 的 deferrals/blocks 区域记录 concrete reason。允许的 runtime downgrade reasons 只包括 `subagent-delegation-unavailable`、`reviewer-dispatch-failed` 和 `reviewer-probe-invalid`。Fingerprint guard failure 使用 `Blocking reason`，不写入 `Runtime downgrade reason`。
- 这个 runtime check 不依赖 `drfx check` 的 `can_spawn_isolated_reviewer` 或 `reviewer_write_blocked` adapter descriptor。当前 `drfx check` 中 Codex 和 Claude adapters 的 unverified write-blocking proof 只阻止 `strict-verified` assurance，不阻止 `practical`。
- coordinator 必须尝试为 initial review 和 full re-review 使用 reviewer subagent。
- reviewer prompt 必须是 read-only 且 self-contained。
- coordinator 必须在 reviewer execution 前后 fingerprint target 和 references。
- 如果 reviewer execution 期间 target 或 reference 出现非 intentional coordinator write 的变化，停止为 `Status: blocked` plus `Blocking reason: reviewer-mutated-file`。
- coordinator 可以在 triage 和 lock acquisition 后修复 accepted issues。
- 只有 persistent `review-and-fix` workflow 中，reviewer 返回 `PASS`，或者 reviewer 返回 `FAIL` 但全部 findings 都是 low severity，且这些 low findings 在所选 strictness 下满足 accepted non-blocking 规则时，final state 才能是 `pass`。
- final response 必须声明 `Assurance: practical`。

Accepted non-blocking low 规则：

- `normal` strictness 下，coordinator 可以在 triage 中明确接受 low finding 为 non-blocking，并在 rationale 中说明它为什么不影响当前目标。
- `strict` strictness 下，新发现的 low finding 不能直接让 workflow PASS。Coordinator 可以把它接受为 non-blocking，但必须把 issue ID 和 rationale 带入下一次 full re-review context；只有后续 reviewer 在该 context 下没有提出新的 blocking finding，才可进入 coordinator agreement。

Practical Mode 不声称 runtime 具有 machine-enforced reviewer write blocking。

如果当前 runtime 不支持 subagent delegation / Task-style reviewer mechanism：

- coordinator 自身最多执行 read-only advisory review。
- 这不算 isolated reviewer，因此 `Assurance` 降级为 `advisory`。
- 不得进入 fix 阶段。
- final status 为 `read-only-clean` when no blocking findings are found，或 `read-only-findings` when blocking findings remain。
- final response 必须说明当前 runtime platform 不支持 subagent，无法执行 practical review-fix loop。

### 6.2 Strict Verified Mode

Strict Verified Mode 只有在 `drfx check` 当前运行把所有 required capabilities 报为 `verified` 时才可用：

- `can_spawn_isolated_reviewer`
- `reviewer_write_blocked`
- `fingerprint_guard_available`

Strict Verified Mode 的唯一 user-facing 入口是显式 route token `assurance=strict-verified` plus 显式 `read-only` 或 `review-and-fix` mode token。`strict` strictness flag 不得触发 Strict Verified Mode；没有 `assurance=strict-verified` 时，Codex/Claude Code route 使用 Practical request，Gemini 使用 Advisory request。

Generated route 请求 strict verified assurance 时，必须把 current-run descriptor path、runtime platform 和 proof run id 传给 internal workflow command，并且 workflow command 必须校验 route token 中的 `requestedAssurance` 与 `--assurance strict-verified` 一致。Internal workflow command 必须读取 descriptor JSON，并调用 `lib/capability.js` 的 `validateCurrentDescriptor(descriptor, { packageVersion, platform: descriptorPlatformFor(runtimePlatform), runId: proofRunId, requireVerified: true })`。Strict proof 只有在 validation result 同时满足 `valid === true`、`trusted === true`、`passCapable === true` 且 `errors.length === 0` 时才成立；仅凭 `--assurance strict-verified` 字符串，或仅凭 schema-valid/unverified descriptor，不得写入 strict verified manifest 或通过 final validation。

`descriptorPlatformFor(runtimePlatform)` 固定映射为：`codex -> codex`、`claude-code -> claude`、`gemini -> gemini`。Install/check public platform token 继续使用 `claude`，但 runtime manifest 写 `Runtime platform: claude-code`。V2 generated Gemini route 不请求 Strict Verified Mode；如果 direct/manual strict verified start 使用 `--runtime-platform gemini`，command 必须停止为 `Status: unsupported` plus `Status reason: unsupported-runtime-capability`，不得写 strict verified manifest。

如果缺少这些能力，strict mode 停止为 `unsupported`，并且在 Codex 或 Claude Code 下可以提供 Practical Mode。

Strict Verified read-only behavior：

- `assurance=strict-verified read-only` 是 workflow-backed persistent read-only run，即使没有 `ledger=` 或 `resume` 也必须创建 target-local state after successful strict proof validation and startup fingerprint probe。
- 它必须记录 manifest、context manifest、normalized reviewer/triage reports when applicable、receipts when required 和 final response validation result。它不得编辑 target files。
- 它的 terminal status 只能是 `read-only-clean`、`read-only-findings`、`unsupported` 或 `blocked`；clean result 仍然不是 workflow `pass`。
- No-state subcommands reject `--assurance strict-verified`。用户若需要 no-state read-only validation，必须请求 `assurance=practical` 或 `assurance=advisory`，或省略 assurance 让 route 按 platform default 选择。
- 如果 strict proof validation fails, command may persist only the advisory-compatible `unsupported` manifest described in 9.2, and only after target state can be safely derived and startup fingerprint probe succeeds. If startup fingerprint probe fails, no state is written and the command returns blocked JSON with the fingerprint blocker.

### 6.3 Gemini Mode

Gemini 在 v2 仍然是 advisory-only：

- 可以运行 read-only advisory review。
- 不得编辑 target files。
- 不得声明 workflow PASS。
- Gemini generated route 只有显式 `read-only` 才运行 workflow-backed advisory review。用户请求 `review-and-fix` 时，route 必须运行 `workflow preflight --no-state ... --terminal-status unsupported --status-reason unsupported-runtime-capability --blocking-reason none --assurance advisory --runtime-platform gemini --runtime-subagent-probe not-required --runtime-stdin-handoff not-required` 生成 `preflight-terminal` token。如果 host 能提供 real stdin handle，route 随后用同一 token 调用 no-state `finalize --final-response-stdin`，但必须把 `--runtime-stdin-handoff ready` 传给 finalizer；如果 stdin 不可用，route 输出未 finalizer-validated `Status: unsupported` response，并明确声明 finalization was not validated。它不得把 Gemini `review-and-fix` 当作 subagent runtime downgrade，也不得创建 `Mode: review-and-fix` state。

## 7. 执行架构

V2 引入 workflow execution layer，但 coordinator 仍然是 LLM host agent。Coordinator 不能直接 `require()` Node.js modules，也不能通过 CLI 完成语义审查或正文修复。

```text
User invokes route
        |
        v
Generated route with embedded workflow contract
        |
        v
Host agent (Codex or Claude Code coordinator)
        |
        +--> internal drfx workflow commands for deterministic state work
        |       - parse invocation
        |       - derive target key
        |       - create/update MANIFEST.md, ISSUES.md, reports, receipts
        |       - validate report schemas
        |       - acquire/refresh/release lock
        |       - compute fingerprint guards
        |
        +--> LLM actions
                - read target/reference files
                - spawn reviewer subagent
                - make semantic triage decisions
                - edit target document
                - perform diff review judgment
                - spawn full re-review subagent
                - make final coordinator agreement
```

Node package 负责 deterministic helpers：parsing、state、validation、locks、fingerprints 和 persistence。Generated routes 通过 internal `drfx workflow ...` commands 使用这些 helpers；这些 commands 是 deterministic facade，不是 reviewer、triage engine、fixer 或 final judge。

这是有意设计。没有 model runtime 时，本地 Node CLI 无法独立完成语义级 LLM review、triage、Markdown edit、diff review judgment 或 final agreement。Generated routes 因此必须是 operational route instructions：它们驱动 coordinator 逐步运行 loop，但 semantic work 仍由 LLM 完成。

## 8. 新增和变更文件

V2 会新增或实质性修改超过 8 个文件：

- `design/DESIGN-v2.md`
- `bin/drfx.js`
- `lib/workflow.js`
- `lib/reviewer-report.js`
- `lib/context-pack.js`
- `lib/final-response.js`
- `lib/input.js`
- `lib/target-state.js`
- `lib/ledger.js`
- `shared/core.md`
- `shared/long-task.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`
- `templates/codex-skill.md.tmpl`
- `templates/claude-command.md.tmpl`
- `templates/gemini-command.toml.tmpl`
- `skills/review-fix-spec/SKILL.md`
- `skills/review-fix-plan/SKILL.md`
- `skills/review-fix-design/SKILL.md`
- `skills/review-fix-doc/SKILL.md`
- `README.md`
- `test/workflow-state.test.js`
- `test/input-parsing.test.js`
- `test/reviewer-report.test.js`
- `test/context-pack.test.js`
- `test/triage.test.js`
- `test/fix-lock.test.js`
- `test/diff-review.test.js`
- `test/final-response.test.js`
- `test/resume.test.js`
- `test/practical-route.test.js`
- `test/e2e-workflow.test.js`

这个范围较大是必要的。V1 实现的是 helper libraries 和 route installation；V2 实现使用它们的 workflow layer。

`lib/workflow.js`、`lib/reviewer-report.js`、`lib/context-pack.js` 和 `lib/final-response.js` 都是 deterministic support modules。它们不得调用 LLM，不得修改 target document，不得把 semantic judgment 包装成 CLI 自动化。它们的运行时消费者是 internal `drfx workflow ...` commands 和 generator；semantic review/fix work 的消费者是 generated skill 中的 coordinator instructions。

## 9. Interface Changes

### 9.1 Public CLI Commands

保留现有命令：

```text
drfx check [--platform claude,codex,gemini] [--json]
drfx install --platform claude,codex,gemini
drfx uninstall --platform claude,codex,gemini
```

V2 不增加新的 public user-facing review/fix command。用户仍然通过 generated routes 调用 review-fix workflow：Codex 用 generated skill，Claude Code 和 Gemini 用 generated command。

`drfx check --json` 是 strict verified route 的 proof discovery interface。JSON output 必须包含 `packageVersion`、`runId`、每个平台的 `descriptorPath`、descriptor `validation` summary 和 redacted advisory reason。Generated routes 只有在用户显式传 `assurance=strict-verified` 时才请求 strict verified proof；route 必须在同一次 route flow 内运行 `drfx check --platform <public-platform> --json`，从 JSON 中读取 `runId` 和 `descriptorPath`，再传给 `drfx workflow start --assurance strict-verified ... --runtime-subagent-probe ready --runtime-stdin-handoff ready --capability-descriptor <path> --proof-run-id <runId>`。Generated routes 不得从 human-readable `drfx check` output 抓取 proof，也不得读取安装时遗留 descriptor 当作 current-run proof。

`drfx check --json` machine contract：

- stdout 必须只输出一个 UTF-8 JSON object，不夹杂 human-readable report text。stderr 只用于 unexpected process/runtime errors。
- advisory capability result 不是 command failure。只要 descriptor files 和 validation summaries 成功生成，process exit code 必须是 `0`，即使某个平台的 `trusted` 或 `passCapable` 是 `false`。CLI/parser/internal failure 使用 non-zero exit code，并输出 `ok: false` JSON when possible。
- JSON top-level shape 固定为：

```json
{
  "ok": true,
  "packageName": "@xenonbyte/document-review-fix",
  "packageVersion": "<package version>",
  "runId": "<uuid>",
  "checkedAt": "<ISO timestamp>",
  "descriptorDirectory": "<absolute OS temp directory>",
  "platforms": {
    "codex": {
      "descriptorPath": "<absolute descriptor json path>",
      "validation": {
        "valid": true,
        "trusted": false,
        "passCapable": false,
        "errors": []
      },
      "advisoryReason": "<redacted reason or empty string>"
    }
  }
}
```

- `platforms` only includes requested public platforms. Public platform keys remain `claude`、`codex` and `gemini`; generated routes map `claude-code` runtime to public platform `claude` before running `drfx check --json`。
- `descriptorDirectory` 必须是 `fs.mkdtempSync(path.join(os.tmpdir(), "drfx-check-"))` style OS temp directory，不得位于 repository、target project、package install directory 或 `.docs-review-fix` 下。
- 每个 `descriptorPath` 必须是 absolute path under `descriptorDirectory`，basename 固定为 `<public-platform>.json`，file mode should be owner-readable/writable only when the platform supports it。Descriptor file content is the exact JSON descriptor accepted by `validateCurrentDescriptor`；it must not contain raw logs、tokens、cookies、target/reference contents or prompt text。
- Descriptor files 是 current-run handoff artifacts。Generated routes must read them in the same route flow and pass the path plus `runId` to `workflow start`; they must not cache, copy into project state, publish, or reuse them across later invocations. OS temp cleanup may remove them after the run; missing descriptor path during `workflow start` is `strict-proof-validation-failed`。

### 9.2 Internal Workflow Commands

新增 internal state-oriented workflow commands。它们面向 generated routes 和 tests，不是 standalone reviewer/fixer，也不应被 README 宣传成用户完成审查修复的入口：

```text
drfx workflow start <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [resume] [ledger=<path>] [root=<path>] [--assurance practical|strict-verified|advisory] [--runtime-platform codex|claude-code|gemini|manual] [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>] [--capability-descriptor <path>] [--proof-run-id <run-id>]
drfx workflow preflight --no-state <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [root=<path>] --terminal-status unsupported|blocked --status-reason <allowed status reason or none> --blocking-reason <allowed blocker or none> --assurance advisory|practical --runtime-platform codex|claude-code|gemini|manual [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>]
drfx workflow context <target-state-dir> --phase initial-review|full-re-review|fix
drfx workflow context --no-state <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [root=<path>] --assurance advisory|practical --runtime-platform codex|claude-code|gemini|manual [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>] --phase initial-review
drfx workflow record-review <target-state-dir> --phase initial-review|full-re-review (--result <reviewer-result-file>|--result-stdin)
drfx workflow record-review --no-state <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [root=<path>] --assurance advisory|practical --runtime-platform codex|claude-code|gemini|manual [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>] --phase initial-review --review-guard <base64url-json> (--result <reviewer-result-file>|--result-stdin)
drfx workflow record-triage <target-state-dir> (--triage <triage-file>|--triage-stdin)
drfx workflow record-triage --no-state <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [root=<path>] --assurance advisory|practical --runtime-platform codex|claude-code|gemini|manual [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>] --state-token <base64url-json> (--triage <triage-file>|--triage-stdin)
drfx workflow begin-fix <target-state-dir>
drfx workflow refresh-lock <target-state-dir>
drfx workflow end-fix <target-state-dir> (--fix-report <fix-report-file>|--fix-report-stdin)
drfx workflow abort-fix <target-state-dir> --status blocked|checkpoint --reason <allowed blocker or status reason> --next-action <redacted next action>
drfx workflow record-diff-review <target-state-dir> (--result <diff-review-file>|--result-stdin)
drfx workflow finalize <target-state-dir> (--final-response <final-response-file>|--final-response-stdin)
drfx workflow finalize --no-state <entry-skill> [target=<path>] [ref=<path> ...] [strict|normal] [read-only|review-and-fix] [assurance=practical|strict-verified|advisory] [root=<path>] --assurance advisory|practical --runtime-platform codex|claude-code|gemini|manual [--runtime-subagent-probe ready|unavailable|failed|not-required] [--runtime-stdin-handoff ready|unavailable|not-required] [--runtime-downgrade-reason <code|none>] --state-token <base64url-json> (--final-response <final-response-file>|--final-response-stdin)
```

Legality matrix for runtime flags:

- `--assurance practical` only with `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready` and `--runtime-stdin-handoff ready`。
- `--assurance advisory` with `--runtime-subagent-probe unavailable|failed` requires one of the allowed subagent downgrade reasons；with `--runtime-subagent-probe not-required` it is valid for Gemini、direct manual/test read-only runs、or explicit Codex/Claude Code `assurance=advisory read-only` runs that intentionally skip practical subagent probing。
- `--assurance strict-verified` is persistent `workflow start` only and requires `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready`、`--runtime-stdin-handoff ready`、`--capability-descriptor` plus `--proof-run-id`。
- `--runtime-stdin-handoff ready` is required for generated route workflow-backed review paths before any command using `--*-stdin` can be considered valid；`unavailable` maps to `Status: blocked` plus `Blocking reason: unsafe-handoff-file`；`not-required` is allowed only for deterministic tests using safe file fixtures, preflight unsupported paths with no semantic stdin payload, or direct manual/debug commands that do not consume semantic stdin。A no-state `preflight-terminal` token may record `not-required`, but any later no-state `finalize --final-response-stdin` must rerun or reuse a positive stdin handoff check and pass `--runtime-stdin-handoff ready`; if stdin is unavailable, the route may only emit an explicitly unvalidated user-facing terminal response.

`bin/drfx.js` parser 和 dispatcher 必须做这些具体变更：

- Top-level command whitelist 从 `check/install/uninstall` 扩展为 `check/install/uninstall/workflow`。
- `check` 增加 shared output flag `--json`；human-readable output 保持兼容。`check --json` 必须输出 generated routes 可解析的 current-run `runId` 和 per-platform descriptor paths，用于 strict verified proof handoff。
- 当 `argv[2] === "workflow"` 时，top-level parser 只确认 `argv[3]` 是 workflow subcommand，并把 `argv[3]` 与 `argv.slice(4)` 分别交给 workflow dispatcher；不得沿用当前 top-level unknown-option rejection 处理 workflow 参数。
- Workflow subcommand whitelist 是 `start/preflight/context/record-review/record-triage/begin-fix/refresh-lock/end-fix/abort-fix/record-diff-review/finalize`。Whitelist 校验发生在 `bin/drfx.js` 和 `lib/workflow.js` 两侧：`bin/drfx.js` 给用户早失败，`lib/workflow.js` 给 tests 和直接调用一致的 parser error。
- `--json` 是所有 workflow subcommands 的 shared output flag；human-readable output 可以存在，但 generated routes 必须使用 `--json`。
- `--assurance` 只允许用于 `workflow start` 和 no-state subcommands；persistent state subcommands 从 `MANIFEST.md` 读取 assurance。
- `workflow start` 如果未传 `--assurance`，只为 direct manual/test use 默认 `advisory`，并必须应用 6.0 的 mode/assurance normalization rules；generated routes 必须显式传入 runtime check 得出的 assurance。
- Workflow commands 调用 `parseInvocation` 时，`options.defaultAssurance` 必须等于 route 层或 direct command 已决定的 requested assurance：generated Codex/Claude Code absent `assurance=` 使用 `practical`，generated Gemini absent `assurance=` 使用 `advisory`，direct manual/test absent `--assurance` 使用 `null` until command defaulting sets effective `advisory`。
- `--runtime-platform` 只接受 `codex`、`claude-code`、`gemini` 和 direct manual/test use 的 `manual`。Generated routes 不得省略它：Codex route 固定传 `codex`，Claude Code command 固定传 `claude-code`，Gemini command 固定传 `gemini`。
- `--capability-descriptor` 和 `--proof-run-id` 只允许与 `--assurance strict-verified` 一起用于 `workflow start`，并且两者必须同时存在。Strict verified start 同时必须有 `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready` 和 `--runtime-stdin-handoff ready`。`workflow start` 必须读取 descriptor JSON，并调用 `lib/capability.js` 的 `validateCurrentDescriptor(descriptor, { packageVersion, platform: descriptorPlatformFor(runtimePlatform), runId: proofRunId, requireVerified: true })`；只有返回结果同时满足 `valid === true`、`trusted === true`、`passCapable === true` 且 `errors.length === 0`，才可写入 `Assurance: strict-verified`。任何 schema error、stale packageVersion、wrong platform、wrong run id、installer-default provenance、或 required capability 非 `verified` 都必须让 persistent `start` 停止为 `Status: unsupported`，不得写入 strict verified state。
- Strict proof validation failure 的 persistence 规则固定如下：如果 target state dir 可以安全 derive and startup fingerprint probe succeeds，`workflow start` 必须写入 advisory-compatible unsupported manifest，字段为 `Status: unsupported`、`Current phase: review`、`Mode: read-only`、`Assurance: advisory`、`Assurance proof: none`、`Runtime subagent probe: not-required`、`Runtime subagent probe evidence: none`、`Runtime fingerprint guard: passed`、`Runtime stdin handoff: not-required`、`Runtime stdin handoff evidence: none`、`Runtime downgrade reason: none`、`Blocking reason: none` 和 `Status reason: strict-proof-validation-failed`。只有原始 tokens 显式请求 `review-and-fix` 时，JSON output 才包含 `modeNormalizedFrom: review-and-fix`；省略 mode token 的 direct manual/test 调用保持 `modeNormalizedFrom: null`。JSON output 必须包含 `requestedAssurance: strict-verified`、`assurance: advisory`、`assuranceNormalizedFrom: strict-verified`、`strictProofError` 的 redacted summary 和 `nextAction: rerun with practical or provide current verified descriptor`。如果 target state dir 不能安全 derive，command 只返回 `ok: false` JSON，不写 state。如果 startup fingerprint probe fails or output is invalid，command returns `Status: blocked` plus the matching fingerprint `Blocking reason` and writes no state. These outcomes must not be normalized into advisory unsupported state. No strict proof failure path may persist `Mode: review-and-fix` with `Assurance: advisory`、`Assurance: strict-verified`、strict proof path、or `pass`。
- `--assurance practical` 不接受 descriptor shortcut。Practical Mode 的前置条件来自 generated route 在当前 session 内的 runtime check，不来自 `drfx check` descriptor。`--assurance practical` 只允许 `--runtime-platform codex|claude-code`；`gemini` 和 `manual` 不得写入 practical state 或 final PASS。
- `--assurance practical` 必须和 `--runtime-subagent-probe ready`、`--runtime-stdin-handoff ready` 同时出现。`--runtime-subagent-probe unavailable|failed` 只允许与 `--assurance advisory` 一起使用，并且必须带 `--runtime-downgrade-reason <code>`。
- `--runtime-stdin-handoff` 是 workflow command 的 runtime flag。Generated routes 在 `start` 或 no-state `context/preflight` 前必须传入该 flag；缺失时返回 validation error。`ready` 表示 route 已确认当前 host 能打开可写 stdin process/session handle；`unavailable` 只能产生 `Status: blocked` plus `Blocking reason: unsafe-handoff-file`；`not-required` 只能用于 deterministic file fixture tests、direct manual/debug file-input runs 或 no-state preflight unsupported paths。
- `--runtime-downgrade-reason` 只接受 `subagent-delegation-unavailable`、`reviewer-dispatch-failed`、`reviewer-probe-invalid` 和 `none`。`none` 只允许在 explicit advisory read-only、Gemini advisory/no-state preflight、direct manual/test non-downgrade flows、practical success 或 strict proof failure normalization paths 中使用；`--runtime-subagent-probe unavailable|failed` 时不得使用 `none`。
- No-state subcommands 只接受 `--assurance advisory|practical`；`strict-verified` 必须使用 persistent state，因为 strict verified PASS 需要可复查的 state 和 reports。
- Persistent `workflow start` 必须把 `runtimeCheck.subagentProbe`、`runtimeCheck.fingerprintGuard`、`runtimeCheck.stdinHandoff` 和 `runtimeCheck.downgradeReason` 写入 manifest fields；后续 persistent subcommands 的 JSON output 从 manifest 读取这些字段。
- `workflow start` 的 route tokens 继续复用 `lib/input.js` 的 `parseInvocation` 和 path validation，不能重新实现一套宽松 parser。Workflow commands 必须使用 `parseInvocation(..., { defaultMode: "read-only", includeMetadata: true })`，并在 JSON output 中暴露 `requestedMode`、`mode`、`modeSource`、`modeNormalizedFrom`、`requestedAssurance`、`assuranceSource` 和 `assuranceNormalizedFrom`。如果 route token 显式包含 `assurance=<value>`，该值必须与 `--assurance <value>` 一致，除非 command 正在把 failed `strict-verified` proof 持久化为 advisory-compatible `unsupported` state；该 exception 必须输出 `requestedAssurance: strict-verified`、`assurance: advisory` 和 `assuranceNormalizedFrom: strict-verified`。其他 mismatch 返回 validation error，不得创建 manifest 或 stateToken。Generated routes 的 `explain` intent 是 route 层预检，不进入 `parseInvocation` path validation。
- `--no-state` 只允许用于 effective `read-only` runs 的 `context`、`record-review`、`record-triage` 和 `finalize`。这些 commands 必须接收 `<entry-skill>` 和同一组 route tokens，并复用 `lib/input.js` 的 `parseInvocation` 和 path validation 派生 target metadata；它们只能做 validation、normalization、redaction 和 JSON output，不得创建 `.docs-review-fix` 或写 target-local reports。
- No-state review subcommands（`context`、`record-review`、`record-triage` 和 review-backed `finalize`）必须拒绝 `resume`、`ledger=` 和除 `initial-review` 以外的 phase。这些 review subcommands 的 tokens 中出现 `review-and-fix` 时，只有在 `--assurance advisory`、`--runtime-subagent-probe unavailable|failed` 和合法 non-`none` `--runtime-downgrade-reason` 同时存在时才允许；command 必须把 effective mode 归一化为 `read-only`，并在 JSON output 中写 `requestedMode: review-and-fix`、`mode: read-only`、`modeNormalizedFrom: review-and-fix`。其他 no-state review-backed `review-and-fix` 组合都返回 validation error。`workflow preflight --no-state` 的 pre-review terminal path 是例外：Gemini `review-and-fix` unsupported 可以使用 `--runtime-subagent-probe not-required --runtime-downgrade-reason none` 生成 `preflight-terminal` token。
- `workflow preflight --no-state` 是 no-review terminal token path，只允许在 route 还没有读取 target/reference、还没有生成 semantic report、也还没有 stateToken 时使用。它只接受 `--terminal-status unsupported|blocked`：`unsupported` 必须搭配 `--blocking-reason none` 和 `--status-reason unsupported-runtime-capability`，用于 Gemini `review-and-fix` 这类 runtime-capability no-state terminal response；`blocked` 必须搭配 allowed blocker 和 `--status-reason none`，主要用于 `unsafe-handoff-file` 这类 first semantic handoff 前的 blocker。Preflight 成功时返回 `stateToken` with `tokenKind: preflight-terminal`、eligible terminal status、route metadata、runtime flags 和 `contentPolicy: redacted-normalized-state-only`；它不得写 `.docs-review-fix`，不得输出 `reviewGuard`，不得包含 reviewer/triage/fix semantic payload。No-state `finalize` 可以接收该 token，并只能验证 token 中列出的 terminal status；如果 finalize 使用 `--final-response-stdin`，它必须用 `--runtime-stdin-handoff ready`，即使 preflight token 本身记录的是 `not-required`。
- No-state `context` 必须在 JSON output 中返回 `reviewGuard` string。该 string 是 base64url-encoded canonical safe JSON，decode 后只包含 `guardId`、phase、round、target fingerprint、reference fingerprints、normalized target/reference paths、assurance、strictness、mode 和 `contentPolicy: read-in-memory-only`。它不得包含 target/reference body、raw prompt 或 semantic reviewer output。`record-review` 必须把 `reviewGuard` 当作 untrusted input 校验 schema、canonical encoding、target/references/phase/round/strictness/mode/assurance 和 fingerprint baseline。
- No-state `record-review` 必须接收 `--review-guard <base64url-json>`，解析并校验它来自同一 target、references、phase、strictness、mode 和 assurance，然后重新 fingerprint target/reference 并与 guard baseline 对比。缺失、不可解析、target mismatch 或 phase mismatch 返回 validation error JSON；fingerprint mismatch 停止为 `Status: blocked` plus `Blocking reason: reviewer-mutated-file`。Persistent `record-review` 不接受 `--review-guard`，而是从 latest review context manifest 读取 guard baseline。
- No-state `record-review` 成功时必须在 JSON output 返回 `stateToken`。该 token 是 base64url-encoded canonical JSON，只能包含 `tokenVersion`、`tokenKind`、`tokenId`、`previousTokenSha256`、`createdAt`、normalized/redacted reviewer result、guard id、phase、round、target key、normalized target/reference paths、fingerprint summary、strictness、mode、assurance、runtime downgrade reason、eligible terminal statuses 和 `contentPolicy: redacted-normalized-state-only`。它不得包含 target/reference body、raw prompt、raw reviewer output、raw semantic input、raw transcript 或 secret-like values。第一个 token 的 `previousTokenSha256` 固定写 literal `none`；后续 token 必须写前一个 canonical decoded token bytes 的 SHA-256 hex。
- No-state `stateToken` 不是 security boundary 或 tamper-proof proof；它只是在同一次 coordinator flow 中传递 redacted validation state。Commands 必须把 token 当作 untrusted input：decode 后校验 exact schema、reject unknown fields、reject non-canonical JSON、重新计算 token sha256、校验 `previousTokenSha256` lineage、校验 target/references/phase/round/strictness/mode/assurance/guard id 与当前 command 参数匹配。任何 mismatch 返回 validation error JSON，不能进入 final validation。
- Canonical JSON applies to both `reviewGuard` and `stateToken`。Encoding 固定为 UTF-8 JSON bytes encoded with unpadded base64url；encoder 等价于 Node.js `Buffer.from(canonicalJsonBytes).toString('base64url')`。Decoder 必须拒绝 padding `=`、standard-base64 characters `+` 和 `/`、空白字符、非 UTF-8 bytes、decode 后 re-encode 不等于原 input 的 token，以及任何超过 32768 bytes 的 encoded `stateToken`。
- Canonical JSON object serialization 固定为：object keys recursively sorted by JavaScript string comparison (`a < b ? -1 : a > b ? 1 : 0`)；schema field names 必须是 ASCII；arrays 保持语义顺序；无 insignificant whitespace；string escaping 使用 `JSON.stringify` 等价输出；numbers 只允许 non-negative safe integers where schema explicitly permits numbers；timestamps 只允许 `new Date().toISOString()` 形式的 UTC ISO 8601 string；commands 不做 Unicode normalization，hash 和 canonical comparison 使用 `JSON.stringify` 输出后的 exact UTF-8 bytes。
- `stateToken` 的 sha256 和 `previousTokenSha256` lineage 计算基于 base64url decode 后的 canonical JSON bytes；第一个 `stateToken` 或 `preflight-terminal` token 的 `previousTokenSha256` 固定为 literal `none`。
- `stateToken` encoded string 长度上限固定为 32768 bytes。任何 no-state command 如果将要输出超过上限的 token，必须返回 `ok: false`、`Status: blocked`、`Blocking reason: state-token-too-large` 和 `nextAction: rerun with ledger= or review-and-fix persistent state`，不得输出截断 token。任何 no-state command 接收超过上限的 `--state-token` 必须返回同一 blocker。
- No-state `record-triage` 必须接收前一步 no-state `record-review` 返回的 `--state-token <base64url-json>`，校验同一 target、references、strictness、mode、assurance、review guard id、token kind 和 lineage 后，才能校验 triage stdin。成功时它必须返回新的 `stateToken`，包含 normalized/redacted reviewer summary、triage decisions、blocking finding summary、accepted non-blocking low issue IDs 和 next eligible terminal statuses。它不得写 report 或 ledger。
- No-state `finalize` 必须接收最新 `--state-token <base64url-json>`。如果 reviewer `PASS` 后直接 finalize，使用 `record-review` 返回的 token；如果 reviewer `FAIL` 后经过 triage，使用 `record-triage` 返回的 token；如果 workflow 在 review 前已经 terminal，使用 `workflow preflight --no-state` 返回的 `preflight-terminal` token。Finalizer 必须校验 token kind、lineage、target、references、strictness、mode、assurance、phase 和 eligible terminal statuses，并用该 token 验证 `read-only-clean`、`read-only-findings`、`unsupported` 或 `blocked` 的 final response 组合，不能只信任 final response 自述。
- No-state `finalize` 必须拒绝 `Status: pass`，错误码为 `no-state-pass-unsupported`；它只允许 `read-only-clean`、`read-only-findings`、`unsupported` 或 `blocked` 这类不依赖 persistent review/fix state 的 terminal statuses。
- `begin-fix`、`refresh-lock`、`end-fix`、`abort-fix` 和 `record-diff-review` 必须有 real `<target-state-dir>`；no-state runs 不得进入 fix 或 diff-review。
- 对 `record-review`、`record-triage`、`end-fix`、`record-diff-review` 和 `finalize`，对应的 file input 和 stdin input 必须二选一；缺失或同时传入都返回 validation error。
- Generated routes 必须使用 stdin input forms，不得把 reviewer、triage、fix、diff review 或 final response 的 raw semantic output 写成 project-local temp file 后再交给 CLI。
- `finalize` 必须读取 `--final-response-stdin` 或 `--final-response <file>`，用 `lib/final-response.js` 校验字段、status/assurance 组合和 redaction 后，才可持久化 final status；final status 从 final response 解析，不再接受单独的 final status flag。`--no-state` 下只校验并输出 JSON，不写 state。
- Public help 只展示 `check/install/uninstall`；`drfx workflow --help` 可以展示 internal help，并且必须标注 `internal deterministic interface`。

`lib/workflow.js` 的 module boundary：

- 导出 `runWorkflowCommand(subcommand, args, options)`，由 `bin/drfx.js` 在 `argv[2] === "workflow"` 时调用，其中 `subcommand === argv[3]`，`args === argv.slice(4)`；`options` 只包含 `cwd`、`env`、`stdin`、`stdout`/`stderr` writers、`now`、`packageVersion` 和 test fixtures。
- 导出 `parseWorkflowArgs(subcommand, args)`、`formatWorkflowJson(result)` 和 `formatWorkflowError(error)` 供 tests 直接覆盖 parser 和 JSON shape。
- 负责调用 `lib/input.js`、`lib/target-state.js`、`lib/ledger.js`、`lib/lock.js`、`lib/receipts.js`、`lib/rulebook.js`、`lib/reviewer-report.js`、`lib/context-pack.js`、`lib/final-response.js`、`lib/redaction.js` 和 `lib/capability.js`。
- 所有 persistent state writes 在 schema validation 和 redaction 后使用 temp file + rename；这些 temp files 只能包含 normalized/redacted state。失败时返回 `ok: false` JSON，不输出半成品 PASS。
- Error JSON shape 固定为 `ok`、`status`、`errorCode`、`message`、`targetStateDir`、`manifestPath`、`blockingReason`、`statusReason`、`nextAction`。当 `status !== "blocked"` 时 `blockingReason` 必须是 `none`；当 `status === "blocked"` 时 `statusReason` 必须是 `none`。
- 不导出 reviewer、triage、fix、diff-review 或 final PASS semantic helpers；这些 judgment 只能来自 coordinator/reviewer/fixer 文本输出。

Internal workflow commands 的边界：

- 可以解析 tokens、创建 state、写 manifest、写 ledger、写 reports、写 receipts、redact、校验 schema、计算 fingerprints、处理 locks。
- 不得 spawn LLM reviewer。
- 不得判断 finding 是否真实。
- 不得决定 triage semantic outcome。
- 不得编辑 target document。
- 不得执行 diff review judgment。
- 不得声明 final PASS。

Generated routes 必须把这些 commands 当作 deterministic state facade 使用。审查代码/文档、语义判断和修复正文必须通过 LLM coordinator、reviewer 或 bounded fixer 完成。

### 9.3 Output Format

供 generated routes 使用的命令应支持 `--json`。JSON output 必须避免 raw secrets，并包含：

- `ok`，成功为 `true`，validation/blocker/error 为 `false`
- `status`
- `targetStateDir`，no-state 时为 `null`
- `targetKey`，no-state 且无法安全 derive 时为 `null`
- `manifestPath`，no-state 时为 `null`
- `ledgerPath`，no-state 时为 `null`
- `round`
- `documentType`
- `strictness`
- `requestedMode`
- `mode`
- `modeSource`，值为 `explicit` 或 `default`
- `modeNormalizedFrom`，只有 internal command 把 requested mode 改成 effective mode 时填原始 mode；其他 output 为 `null`
- `requestedAssurance`，来自 `assurance=` route token 或 route default request；值为 `practical`、`strict-verified`、`advisory` 或 direct manual/test default 下的 `null`
- `assuranceSource`，值为 `explicit`、`default` 或 `null`
- `assuranceNormalizedFrom`，只有 internal command 把 requested assurance 改成 effective assurance 时填原始 assurance；其他 output 为 `null`
- `assurance`
- `runtimePlatform`，值为 `codex`、`claude-code`、`gemini` 或 `manual`
- `descriptorPlatform`，`strict-verified` 时为 `codex`、`claude` 或 `gemini`；其他 assurance level 为 `null`
- `assuranceProof`，`strict-verified` 时为 `{ runtimePlatform, descriptorPlatform, descriptorPath, proofRunId }`；其他 assurance level 为 `null`
- `strictProofError`，只有 strict verified descriptor validation failure 时填 redacted summary；其他 output 为 `null`
- `runtimeCheck`，包含 `subagentProbe`、`fingerprintGuard`、`stdinHandoff` 和 `downgradeReason`；`subagentProbe` 和 `stdinHandoff` 至少包含 `status` 和 `evidence`
- `contextManifestPath`，no-state 时为 `null`
- `contextPackSkeleton`，no-state `context` output 必填；persistent state 下可省略或为 `null`
- `reviewGuard`，successful no-state `context` output 必填，值是 base64url-encoded safe JSON string；error/blocker output 和其他 output 省略或为 `null`
- `stateToken`，successful no-state `preflight`、no-state `record-review` 和 no-state `record-triage` output 必填，值是 base64url-encoded canonical safe JSON string；error/blocker output 和 persistent state output 为 `null`
- `nextAction`
- `blockingReason`，所有 output 必填；`Status: blocked` 时为 allowed blocker code，其他 status 必须为 `none`
- `statusReason`，所有 output 必填；非 blocked terminal/pause status 的 machine-readable reason，若不适用则为 `none`

Persistent state output 从 `MANIFEST.md` 和 target-local state 派生这些字段。No-state output 从 `<entry-skill>`、route tokens、`--assurance` 和 runtime flags 派生基础字段；no-state `preflight` 生成 `preflight-terminal` `stateToken`；no-state `context` 额外生成 `reviewGuard`；no-state `record-review` 校验 `reviewGuard` 并生成首个 review-backed `stateToken`；no-state `record-triage` 和 `finalize` 必须从最新 `stateToken` 派生 validation state。No-state review commands（`context`、`record-review`、`record-triage` 和 review-backed `finalize`）都必须重新计算 target/reference fingerprints 作为当次 `runtimeCheck.fingerprintGuard`，且 workflow-command-backed review output 必须有 `fingerprintGuard: passed`；fingerprint unavailable 或 output-invalid 直接返回 blocked JSON，不得输出不完整 `reviewGuard`、review-backed `stateToken` 或 final validation result。No-state `preflight` 可以在 `unsupported-runtime-capability` 或 `unsafe-handoff-file` 这类 pre-review terminal path 中写 `runtimeCheck.fingerprintGuard.status: not-run`，因为它不执行 review guard；它仍必须校验 route tokens 和 target path shape。若 `finalize` 接收 preflight token，只能验证 token 允许的 `unsupported` 或 `blocked` status。如果缺少 target、无法安全 resolve root、需要 token 的命令中 `stateToken` 缺失、不可解析、非 canonical、unknown field、token kind mismatch、lineage mismatch、target mismatch、phase mismatch 或超过长度上限，命令必须返回 validation/blocker error，而不是输出不完整 JSON。

### 9.4 Assurance Field

`MANIFEST.md` 应新增：

```text
Manifest schema: 2
Assurance: practical | strict-verified | advisory
Runtime platform: codex | claude-code | gemini | manual
Descriptor platform: none | codex | claude | gemini
Assurance proof: none | capability-descriptor:<descriptor-platform>:<proof-run-id>
Runtime subagent probe: ready | unavailable | failed | not-required
Runtime subagent probe evidence: route-asserted-ready | none
Runtime fingerprint guard: passed | unavailable | output-invalid | not-run
Runtime stdin handoff: ready | unavailable | not-required
Runtime stdin handoff evidence: route-asserted-ready | none
Runtime downgrade reason: <runtime downgrade code or none>
```

`Manifest schema: 2` 是 v2 discriminator。没有 `Manifest schema` 字段的 manifests 只能按 v1 compatibility path 读取；一旦 manifest 写了 `Manifest schema: 2`，任何 v2 required field 缺失、未知 enum、字段重复或非法组合都必须停止为 `Status: blocked` plus `Blocking reason: state-validation-failed`，不得按 v1 manifest 静默归一化。

没有 `Assurance` 字段且没有 `Manifest schema` 字段的现有 manifests 应被视为 v1 manifests，并在 resume 时归一化为 `advisory`，除非用户明确要求用 `practical` restart。没有 `Assurance proof` 字段的 v1 manifests 归一化为 `none`。
没有 runtime fields 且没有 `Manifest schema` 字段的 v1 manifests 归一化为 `Runtime subagent probe: not-required`、`Runtime subagent probe evidence: none`、`Runtime fingerprint guard: not-run`、`Runtime stdin handoff: not-required`、`Runtime stdin handoff evidence: none` 和 `Runtime downgrade reason: none`。

当 `Assurance: strict-verified` 时，`Assurance proof` 必须来自同一次 `drfx check` 生成的 descriptor validation。Manifest 不保存 descriptor JSON 全文，只保存 runtime platform、descriptor platform 和 proof run id；descriptor path 可以出现在 receipt/report 中，但必须是 redacted safe path。`Assurance: practical` 和 `Assurance: advisory` 必须写 `Assurance proof: none` 和 `Descriptor platform: none`。
当 `Assurance: practical` 时，manifest 必须写 `Runtime platform: codex|claude-code`、`Runtime subagent probe: ready`、`Runtime subagent probe evidence: route-asserted-ready`、`Runtime stdin handoff: ready`、`Runtime stdin handoff evidence: route-asserted-ready` 和 fingerprint guard 的实际结果。这些 evidence 表示 generated route 声称已经完成 live probe；它不是 strict verified capability proof。Advisory downgrade 必须写 runtime platform、subagent probe 的失败状态、`Runtime fingerprint guard: passed`、`Runtime stdin handoff: ready|not-required` 和 `Runtime downgrade reason`。显式请求的 advisory read-only 不是 downgrade；它必须写 `Runtime subagent probe: not-required`、`Runtime subagent probe evidence: none`、`Runtime downgrade reason: none`，并在使用 semantic stdin handoff 时写 `Runtime stdin handoff: ready`。如果 fingerprint guard 未通过，不得写 advisory manifest；如果 stdin handoff 必需但不可用，不得写 practical/advisory workflow manifest，必须停止为 `unsafe-handoff-file`。

### 9.5 Semantic Handoff Safety

Reviewer、triage、fix、diff review 和 final response 都是 semantic output。它们进入 internal workflow commands 前必须走以下 handoff 规则：

- Generated routes 必须使用 `--result-stdin`、`--triage-stdin`、`--fix-report-stdin`、`--result-stdin` 或 `--final-response-stdin`，把 semantic output 直接传给 internal command。
- Generated routes 必须通过 host runtime 的真实 stdin channel 传递 semantic payload：启动对应 `drfx workflow ... --*-stdin` command，保持 process 等待 stdin，把 payload 写入 stdin，然后发送 EOF。可接受的 channel 是 host tool 暴露的 process stdin handle，例如 start process 后再 write stdin；不可接受的是 shell pipe、heredoc、herestring、command substitution、argv、environment variable、project-local temp file 或把 payload 拼进 shell command string。
- Stdin-capable process 的最低定义是：route 能启动命令并拿到一个 process/session handle；route 能对该 handle 执行一次或多次 stdin write；route 能发送 EOF；route 能读取 exit code 和 stdout/stderr。只支持一次性 shell command string 的 host 不满足这个定义。Codex route 必须使用 Codex 当前暴露的 process session/write-stdin capability；Claude Code route 必须使用 Claude Code 当前暴露的等价 stdin-capable Task/process capability。若某 runtime 只有普通 shell 命令执行而没有可写 stdin handle，semantic handoff 判定为 unavailable。
- Generated route 在第一次 semantic handoff 前必须确认当前 host tool 能打开 stdin-capable process。确认可以来自 host tool 的 explicit stdin capability，也可以来自启动实际 non-semantic stdin probe process 后拿到可写 stdin handle；仅运行 `--help`、shell command string 或 pipe 不算通过。确认成功后 route 必须把 `--runtime-stdin-handoff ready` 传给 `workflow start`、no-state `workflow context`，以及任何使用 `--*-stdin` 的 no-state command。No-state `workflow preflight` 只有在不携带 semantic stdin payload 的 pre-review terminal path 中可以记录 `not-required`。若 host 不支持 write-stdin/EOF，或 command 启动后没有可写 stdin handle，persistent workflow 停止为 `Status: blocked` plus `Blocking reason: unsafe-handoff-file`；no-state flow 必须先用 `workflow preflight --no-state --terminal-status blocked --blocking-reason unsafe-handoff-file --status-reason none --runtime-stdin-handoff unavailable` 生成 preflight terminal token；如果连该 deterministic command 也无法运行，route 输出未 finalizer-validated blocked response，并明确说明 finalizer 未执行。
- Command-generated `stateToken` and `reviewGuard` are not raw semantic payloads. They may be passed as argv only after a workflow command has produced them, and only if they are base64url safe JSON containing normalized/redacted state with no raw target/reference body、raw prompt、raw semantic input、raw transcript 或 secret-like values。`stateToken` 还必须满足 32768-byte encoded length cap。
- 如果当前 host runtime 没有可用 stdin channel，generated route 必须在 semantic handoff 前停止；persistent workflow 停止为 `Status: blocked` plus `Blocking reason: unsafe-handoff-file`。No-state flow 优先使用 `workflow preflight --no-state` 生成 `preflight-terminal` token；只有随后能使用 stdin 时，route 才能用 `--runtime-stdin-handoff ready` 调用 no-state finalizer。若 stdin unavailable 正是 blocker 且无法向 finalizer 传入 final response，route 可以输出未通过 workflow finalizer 校验的 user-facing blocked response，但必须声明 finalization was not validated。不得退回到 raw temp file handoff。
- Generated routes 不得把 raw reviewer/fixer/coordinator output 写入 repository、target-local state、`.docs-review-fix`、`context/`、`reports/`、`rounds/` 或任意 project-local temp path。
- File input forms 只允许用于 deterministic tests 或 manual debugging，且输入内容必须是 non-sensitive fixture 或已经 redacted 的 handoff file。Internal command 必须拒绝 symlink、directory、project-local state path 和不在 OS temp directory 下的 handoff file，错误使用 `Status: blocked` plus `Blocking reason: unsafe-handoff-file`；no-state command 返回 validation error JSON。
- Internal command 读取 stdin/file 后，必须先完成 parse、schema validation 和 redaction，再写入 manifest、ledger、reports、receipts、context manifests 或 JSON output。
- Persistent state 不保存 raw semantic input、raw subagent transcript、raw target/reference body、raw logs 或 partial secret values。只保存 normalized/redacted reports、issue rows、fingerprints、paths、safe anchors 和 schema metadata。
- 如果 stdin/file 内容触发 secret-like pattern，parser 必须在 normalized output 中 redacted；如果无法安全定位并 redact，workflow 停止为 `Status: blocked` plus `Blocking reason: unsafe-handoff-file`，不得写入 partial normalized report。

### 9.6 Machine-Parseable Semantic Payload Formats

Internal commands 必须解析固定 Markdown contract，不得从自由散文推断字段。Parser rules：

- Section headings、field names 和 enum values 大小写敏感。
- Required sections 必须按本节定义的顺序出现；允许 section 内有 Markdown list items，但不允许同义 heading。
- `none` 是 literal sentinel。空字符串、`N/A`、`not applicable` 或省略字段都不等价于 `none`。
- Parser 可以 tolerate 已列明的字段别名，但 normalized report 必须写回 canonical field names，并记录 warning。
- Unknown top-level sections、unknown fields、重复 singleton field 或 enum 外值都返回 validation error。
- 所有 parser 在返回 normalized output 前必须运行 redaction；如果 redaction 后 required value 为空，仍按 required-field error 处理。
- Field values are single logical lines. Multi-line field continuation, folded Markdown paragraphs, nested lists inside a field value, fenced code blocks and HTML blocks are rejected in machine payloads. If a value is not applicable, use literal `none` on the same line.
- Field separator is the first literal `: ` after the field name. The value may contain additional `:` characters after that separator. Leading and trailing spaces around values are trimmed before validation.
- List item records must start with `- <first_field>: <value>` at the exact indentation shown in the schema. Fields belonging to the same item must be indented by exactly two spaces and must appear in the schema order. Blank lines are allowed only between top-level sections, not inside one item record.
- PASS/FAIL and DIFF-OK/DIFF-FAIL status lines must be the entire first non-empty line of the payload.
- Final response machine block must appear exactly once, with one field per line in the order shown below. For V2's single-target workflow, `Files changed` is either literal `none` or the exact target path from the manifest/finalizer input; it is not parsed as an arbitrary comma-separated path list. `Fixed issue IDs` remains `none` or comma-separated `ISSUE-###` IDs.

Allowed parser aliases are closed:

- Reviewer finding field `impact` -> canonical `why_it_matters`。
- Reviewer finding field `recommendation` -> canonical `suggested_fix`。
- Reviewer finding field `suggestedFix` -> canonical `suggested_fix`。

No other aliases are recoverable. If a future implementation wants another alias, this table must be updated with the exact source field and canonical field before parser tests can accept it.

Reviewer result exact forms：

```text
PASS
Summary: <one redacted sentence or none>
```

或：

```text
FAIL
Findings:
- id: R001
  severity: high | medium | low
  location: <path + heading/line/safe anchor>
  issue: <redacted issue text>
  why_it_matters: <redacted rationale>
  suggested_fix: <redacted suggested fix>
  confidence: confirmed | unconfirmed
  sensitive: true | false
```

`id` 必须匹配 `R\d{3,}`，同一 report 内唯一。`sensitive` 缺失是 recoverable warning，默认 `false`；其他字段缺失是 hard error。

Triage result exact form：

```text
Triage:
- reviewer_id: R001
  issue_id: ISSUE-001
  decision: accepted | reopened | merged | downgraded | rejected | deferred
  severity: high | medium | low
  original_severity: high | medium | low | none
  rationale: <required except plain accepted with non_blocking=false>
  merged_into: ISSUE-### | none
  deferred_owner: <owner or none>
  deferred_next_action: <next action or none>
  non_blocking: true | false
```

`record-triage` 必须校验 `reviewer_id` 存在于 latest normalized reviewer result。`issue_id` 必须匹配 `ISSUE-\d{3,}`；new accepted/downgraded/deferred/rejected findings 必须使用 next stable issue ID，command 校验没有重复、倒退或跳号。`reopened` 的 `issue_id` 必须引用既有 issue row。`merged` 的语义固定为“当前 finding 被记录为 duplicate issue，并合并到 surviving issue”：如果该 duplicate finding 还没有 ledger row，`issue_id` 必须使用 next stable issue ID 并创建 status `merged` 的 ledger row；如果该 duplicate 已经在 resume 或 full re-review 中有 ledger row，`issue_id` 可以引用该既有 duplicate issue。`merged_into` 必须引用另一个既有 surviving `ISSUE-###`，不得等于 `issue_id`。

Fix report exact form：

```text
Fixed:
- ISSUE-001: <redacted summary>

Files changed:
- <target path>

Not fixed:
- ISSUE-002: <reason>

Residual risk:
- <risk or none identified>
```

`Not fixed` 和 `Residual risk` sections 必须存在；没有内容时写一个 list item `- none` 或 `- none identified`，不能省略 section。

Diff review exact forms：

```text
DIFF-OK
Summary: <one redacted sentence or none>
```

或：

```text
DIFF-FAIL
Findings:
- issue_id: ISSUE-001
  problem: <specific problem>
  required_action: <specific next action>
```

Final response exact form：

```text
Final status: pass | read-only-clean | read-only-findings | stopped-with-deferrals | blocked | unsupported | externally-changed | possible-target-replacement | checkpoint
Assurance: practical | strict-verified | advisory
Runtime platform: codex | claude-code | gemini | manual
Mode: review-and-fix | read-only
Target: <target path>
Files changed: <none or exact target path>
Fixed issue IDs: <none or comma-separated ISSUE-### values>
Verification performed: <redacted summary>
Deferrals or blockers: <none or redacted issue/blocker summary with owner and next action when applicable>
Blocking reason: <allowed blocker code or none>
Status reason: <allowed status reason or none>
Residual risk: <risk or none identified>
Redaction statement: <statement or none>
Coordinator agreement: <required when Final status is pass; otherwise none>
```

`finalize` parses only these lines for machine validation. The user-facing final answer may include short prose around them, but the canonical field block must appear exactly once and must be the source of persisted final status.

## 10. Workflow State Contract

V2 保留 target-local state root：

```text
.docs-review-fix/targets/<target-key>/
```

Persistent state 存在时的目标布局：

```text
.docs-review-fix/targets/<target-key>/
├── MANIFEST.md
├── ISSUES.md
├── CONTINUITY.md  (optional, coordinator-owned handoff)
├── SUMMARY.md     (optional, command-owned state summary)
├── context/
│   ├── current-reviewer-context-manifest.md
│   ├── current-fixer-context-manifest.md
│   └── merged-rules.md
├── reports/
│   ├── reviewer-round-001.md
│   ├── triage-round-001.md
│   ├── fix-round-001.md
│   ├── diff-review-round-001.md
│   └── full-review-round-001.md
├── LOCK/
│   └── lease.json
├── stale-locks/
└── rounds/
```

`context/` 和 `reports/` 是 v2 新增目录。它们让 loop 可审计，同时不保存 raw chat transcripts、raw target/reference bodies 或 raw semantic handoff input。

规则：

- `context/` 在 internal command 构建 reviewer 或 fixer context manifest 时创建。
- `context/` 只包含 generated context manifests 和 merged rule snapshots；context manifest 记录 paths、document type、strictness、mode、assurance、fingerprints、rules source list、accepted issue IDs、constraints、output schema 和 reviewer guard baseline。
- `context/` 不得包含 target document body、reference document body、raw prompt、raw subagent output、raw chat transcript 或未经 redaction 的 target excerpts。必要定位只能保存 heading、line number、issue ID 和 redacted safe anchor。
- `context/` 内容在 resume 时重建；resume 不依赖旧 context pack 继续运行。
- `reports/` 在每次 review、triage、fix、diff-review 和 full re-review 完成后写入。
- `reports/` 包含 normalized reviewer、triage、fix 和 diff-review reports。
- `reports/` 参与 resume；resume 读取 manifest 指针和最新 report 文件确定当前 phase。
- `rounds/` 包含 compact receipts。
- `SUMMARY.md` 是 optional command-owned summary。Persistent workflow 在 terminal/pause status、blocker、checkpoint 或 round >= 2 stop point 写入或更新它；内容只能由 `MANIFEST.md`、`ISSUES.md`、latest normalized reports 和 receipts 派生，字段固定为 target key、status、current phase、round、assurance、mode、latest report paths、issue counts、fixed issue IDs、blocking/status reason 和 next action。`SUMMARY.md` 不保存 raw target/reference body、raw semantic input、raw transcript 或 secret-like values。缺失 `SUMMARY.md` 不阻塞 resume。
- `CONTINUITY.md` 是 optional coordinator-owned handoff。Generated route 只在 workflow 因 blocker、deferral、checkpoint、interruption、context pressure 或 long-running handoff 停止时写入或更新它；successful one-round terminal runs 可以不创建。内容必须使用 `Snapshot`、`Decisions`、`Done (recent)`、`Now`、`Next`、`Open questions`、`Working set`、`Receipts` 这些 section 的子集，并且只能记录 redacted state summary、issue IDs、report paths、safe anchors 和 next actions。Resume 可以读取它作为 human context，但 deterministic resume decision 只能来自 `MANIFEST.md`、`ISSUES.md` 和 `reports/`；缺失、损坏或不可解析的 `CONTINUITY.md` 不得改变 manifest-derived phase，只能产生 recoverable warning。
- 不保存 raw subagent transcripts。
- 写入 state files 前必须先 redact sensitive values。
- `lib/target-state.js` reserved ledger directories 必须扩展为 `LOCK`、`stale-locks`、`rounds`、`context` 和 `reports`；reserved basenames 继续包含 `MANIFEST.md`、`CONTINUITY.md` 和 `SUMMARY.md`。
- Custom `ledger=` 不得解析到 `context/` 或 `reports/` 下，否则 resume 会把 operational artifacts 和 issue ledger 混在一起。

Receipt write contract：

- Receipts 写在 `rounds/<round>-<kind>.md`。如果同一 round/kind 需要重复写入，后续路径使用 `rounds/<round>-<kind>-attempt-###.md`，不得覆盖已有 receipt。
- 必须写 receipt 的 stop points：任何 `Status: blocked`、`unsupported`、`externally-changed`、`possible-target-replacement`、`read-only-findings`、`stopped-with-deferrals`、`checkpoint`，以及 generated route 因 interruption 或 context pressure 停止时。
- 必须写 receipt 的 non-stop points：`round >= 2` 的 review、triage、fix、diff-review、full-re-review phase completion；显式 audit trail run 的每个 phase completion。
- Optional receipt：round 1 正常 happy path 可以只写 reports，不强制写 receipt，除非 audit trail、blocker、checkpoint、interruption 或 context pressure 触发上面的规则。
- Receipt required fields 固定为 `Round`、`Kind`、`Status`、`Target`、`Issue IDs`、`Files changed`、`Verification`、`Summary`、`Next Action`、`Blocking reason` 和 `Status reason`。没有值时写 literal `none`，不得省略字段。
- Receipt content 必须来自 normalized reports、manifest、ledger、git target-only guard result 或 coordinator-provided redacted summary。Receipt 不得保存 raw target/reference body、raw semantic input、raw subagent transcript、raw prompt、raw logs 或 secret-like values。
- `abort-fix`、`end-fix` validation blocker 和 finalization blocker 都必须先写 receipt，再输出 final response 或 blocked JSON。Receipt write failure 本身停止为 `Status: blocked` plus `Blocking reason: state-validation-failed`。

## 11. Coordinator Workflow

State machine:

```text
                  +---------+
                  |  start  |
                  +----+----+
                       |
                       v
                  +---------+
          +------>| review  |<------------------+
          |       +----+----+                   |
          |        PASS FAIL                    |
          |         |    |                      |
          |         |    v                      |
          |         | +---------+               |
          |         | | triage  |               |
          |         | +----+----+               |
          |         |      | accepted issues    |
          |         |      v                    |
          |         | +---------+               |
          |         | |  fix    |               |
          |         | +----+----+               |
          |         |      |                    |
          |         |      v                    |
          |         | +-------------+           |
          |         | | diff review |--DIFF-FAIL--> fix
          |         | +------+------+           |
          |         |        | DIFF-OK          |
          |         |        v                  |
          |         | +----------------+        |
          |         +-| full re-review |--FAIL--+
          |           +-------+--------+
          |                   | PASS
          v                   v
     +--------------------------------+
     | coordinator agreement          |
     | -> pass / stopped / blocked    |
     +--------------------------------+
```

Round numbering:

- Initial review starts at round `001`.
- A fix round includes triage, fix, diff review, and full re-review for the same round number.
- A corrective fix after `DIFF-FAIL` stays in the same round and must produce a new diff review report before any full re-review.
- When full re-review returns `FAIL` with new or reopened blocking findings, the next triage starts round `002`.
- `MANIFEST.md` `Current round` is updated before entering a phase.
- Report paths must include the current round number, for example `reports/triage-round-002.md`.
- If the same report kind repeats within one round, first attempt may use the base path, and later attempts must append `-attempt-###`, for example `reports/diff-review-round-001-attempt-002.md` and `reports/fix-round-001-attempt-002.md`.

### 11.1 Start

Route invocation 时：

在以下 workflow start sequence 之前，如果 invocation tokens 没有包含 `read-only` 或 `review-and-fix`，generated route 默认执行 `explain` intent：输出 route 用法、mode 差异、Practical/Advisory/Strict Verified 的含义、需要显式传入的下一步示例，然后停止。此路径不得运行 `drfx workflow ...`、不得读取 target/reference、不得创建 `.docs-review-fix`、不得输出 review result 或 PASS。
1. Generated route 读取 user-facing tokens 中的 `assurance=` request；没有该 token 时，Codex/Claude Code route 请求 `practical`，Gemini route 请求 `advisory`。如果 token 是 `assurance=strict-verified`，route 必须先运行 `drfx check --platform <public-platform> --json` 获取 same-flow descriptor path 和 run id；如果 strict proof 前置数据缺失，route 使用 persistent `workflow start` strict-proof failure path。该 path 只有在 target state dir 可以安全 derive 且 startup fingerprint probe succeeds 时才输出 persisted `Status: unsupported` plus `Status reason: strict-proof-validation-failed`；如果 target state dir 不能安全 derive 或 fingerprint probe 失败，`workflow start` 只返回 `ok: false` JSON 且不写 state。Route 不得把这些 outcome finalize 成 Strict Verified，也不得把 `strict` strictness 当作 assurance。
2. Generated route 运行 runtime checks：subagent probe（Practical/Strict Verified required, Advisory not-required or downgrade）、stdin handoff probe（workflow-backed semantic handoff required）和 route-local selection of `--runtime-platform`。这些 checks 产生 fixed flags：`--runtime-subagent-probe ...`、`--runtime-stdin-handoff ...`、optional `--runtime-downgrade-reason ...`。
3. 对显式 `read-only` 或 `review-and-fix` invocation，Coordinator 运行 `drfx workflow start` 解析 entry skill 和 tokens。No-state pre-review terminal cases（例如 Gemini `review-and-fix` unsupported 或 stdin unavailable before review）运行 `drfx workflow preflight --no-state`，获取 `preflight-terminal` token 后在 stdin 可用时进入 no-state finalization；如果 stdin unavailable 正是 blocker 且 final response cannot be handed off, route 输出未 finalizer-validated blocked response。Preflight terminal cases 不得调用 `workflow context`。
4. Internal command 校验 target 和 reference paths，resolve project root，计算 target key，并校验 route token `assurance=` 与 `--assurance` 一致。
5. 如果传入 `--assurance strict-verified`，internal command 先校验 `--runtime-platform`、`--capability-descriptor` 和 `--proof-run-id`，读取 descriptor JSON，并用 `validateCurrentDescriptor(descriptor, { packageVersion, platform: descriptorPlatformFor(runtimePlatform), runId: proofRunId, requireVerified: true })` 验证 current-run proof。只有返回结果同时满足 `valid === true`、`trusted === true`、`passCapable === true` 且 `errors.length === 0`，才可创建 strict verified state。Strict proof validation failure 不立即写 state；如果 command 将持久化 advisory-compatible unsupported manifest，仍必须先完成下一步 startup fingerprint probe。
6. `workflow start` 在任何 persistent state write 前运行 startup fingerprint probe：对 target 和 references 计算 current fingerprints。失败时返回 blocked JSON，不创建 target state directory、不写 manifest、不写 advisory downgrade manifest。
7. Internal command 判断是否需要 persistent state。`review-and-fix` mode 下 persistent state 是必需的；因 runtime check 降级的 Advisory Mode 必须把 effective mode 写成 `read-only`。
8. Internal command 加载 package built-in rules、user-global rules 和 project-local rules，调用 `lib/rulebook.js` 合并并校验 hard-constraint conflicts before any persistent state write。Rulebook validation failure returns `ok: false`、`Status: blocked`、`Blocking reason: state-validation-failed` and writes no target state directory, manifest, ledger, report, context file or receipt.
9. 需要 persistent state 时，internal command 创建 `.docs-review-fix/targets/<target-key>/`。
10. 需要 persistent state 时，internal command 写入初始 `MANIFEST.md`，`Manifest schema: 2`、`Status: review`、`Current phase: review`、`Blocking reason: none`、`Runtime platform: <runtime-platform>`，`Assurance` 使用 route runtime check 后传入 `workflow start --assurance` 的值；不得从 `mode` 推导 assurance。`Assurance: strict-verified` 还必须写 `Descriptor platform: <descriptor-platform>` 和 `Assurance proof: capability-descriptor:<descriptor-platform>:<proof-run-id>`，其他 assurance level 写 `Descriptor platform: none` 和 `Assurance proof: none`。Manifest 同时写入 runtime fields；`practical` 写 `Runtime subagent probe: ready`、`Runtime subagent probe evidence: route-asserted-ready`、`Runtime stdin handoff: ready` 和 `Runtime stdin handoff evidence: route-asserted-ready`；advisory downgrade 写失败状态、stdin handoff state 和 downgrade reason。
11. Internal command 在需要时创建 `ISSUES.md`。
12. 需要 persistent state 时，internal command 写入 redacted `context/merged-rules.md`。No-state run 只在 JSON output 中返回 merged rule metadata/skeleton，不写 `.docs-review-fix`。
13. 如果 `workflow start` 返回 `targetStateDir`，Coordinator 运行 `drfx workflow context <target-state-dir> --phase initial-review` 获取 context manifest path。该 context command 为本次 review phase 建立 reviewer guard baseline；它不是 startup fingerprint probe。
14. 如果 no-state effective `read-only` run 返回 `targetStateDir: null`，Coordinator 运行 `drfx workflow context --no-state <entry-skill> <same route tokens> --assurance <assurance> --runtime-platform <runtime-platform> <no-state runtime flags below> --phase initial-review` 获取 `contextPackSkeleton` 和 `reviewGuard`，并在内存中构建 review prompt；不得写 `.docs-review-fix`。`<no-state runtime flags below>` 对 practical 是 `--runtime-subagent-probe ready --runtime-stdin-handoff ready`，对 advisory downgrade 是 `--runtime-subagent-probe failed|unavailable --runtime-downgrade-reason <code> --runtime-stdin-handoff ready`，对显式 `assurance=advisory read-only` 是 `--runtime-subagent-probe not-required --runtime-downgrade-reason none --runtime-stdin-handoff ready`。
15. Coordinator 按 context manifest/skeleton 读取 target/reference 文件，在内存中拼接 initial review prompt。Raw target/reference body 不得写入 context files、reports、receipts 或 temp files。

### 11.2 Initial Review

1. `drfx workflow context <target-state-dir> --phase initial-review` 必须在 reviewer dispatch 前 fingerprint target 和 references，并把 reviewer guard baseline 写入 latest review context manifest。No-state `context` 必须在 base64url `reviewGuard` string 中返回同样 baseline。
2. `Assurance: practical|strict-verified` 时，Coordinator 用 in-memory reviewer prompt spawn 一个 read-only reviewer subagent。`Assurance: advisory` 时，Coordinator 不 spawn subagent；它直接执行 read-only advisory review，并输出同一 reviewer result schema，report metadata 记录 `reviewProducer: coordinator-advisory`。
3. 要求 reviewer/advisory output 符合 reviewer schema。
4. reviewer/advisory review 完成后，`drfx workflow record-review` 必须重新 fingerprint target 和 references，并与 latest review context manifest 或 no-state `--review-guard` baseline 对比。
5. 如果任何文件发生变化，`record-review` 停止为 `Status: blocked` plus `Blocking reason: reviewer-mutated-file`，不得写入 partial reviewer report，也不得进入 triage/fix。
6. Coordinator 通过 stdin 把 reviewer/advisory output 交给 `drfx workflow record-review --result-stdin` 校验。Persistent state 下只记录 normalized/redacted `reports/reviewer-round-001.md`；no-state effective `read-only` 下使用 `drfx workflow record-review --no-state <entry-skill> <same route tokens> --assurance <assurance> <same no-state runtime platform and subagent probe fields> --runtime-stdin-handoff ready --phase initial-review --review-guard <base64url-json> --result-stdin`，只返回 normalized JSON 和 `stateToken`，不写 report。
7. 如果 reviewer/advisory output 是 `PASS`，进入 coordinator agreement。Initial review `PASS` 在没有 fix round 的 workflow 中就是 latest full-document review；finalizer 不得要求额外 full re-review。
8. 如果 reviewer/advisory output 是 `FAIL`，进入 triage。

### 11.3 Triage

1. 把 reviewer finding IDs 转成稳定的 `ISSUE-###` IDs。
2. 把每个 finding 分类为 `accepted`、`reopened`、`merged`、`downgraded`、`rejected` 或 `deferred`。
3. `downgraded` 是 triage decision，不是 ledger status；ledger row 必须写入 downgraded 后的 severity，status 写为 `accepted`，resolution 写明 `Downgraded from <original-severity>: <rationale>`。
4. 如果 downgraded 后是 low severity，并且 coordinator 明确接受为 non-blocking，ledger status 仍是 `accepted`，resolution 必须追加 `Accepted as non-blocking low: <rationale>`，并把 issue ID 加入后续 full re-review context。
5. `reopened` 只用于 latest full re-review 或 resume 后发现一个既有 issue 仍未解决、回归或被错误关闭的场景；`issue_id` 必须是原有 `ISSUE-###`，ledger status 写为 `reopened`，severity 更新为当前 triage severity，resolution 写明 `Reopened: <rationale>`。
6. 这一步是 coordinator 的 LLM semantic judgment；internal commands 只校验 shape、status mapping 和持久化结果。
7. 每个 `rejected`、`downgraded`、`merged`、`reopened` 或 `deferred` finding 都必须有 rationale；每个 `non_blocking: true` 的 finding 也必须有 rationale。
8. 每个 `deferred` finding 都必须有 owner 和 next action。
9. Coordinator 生成 triage result，并通过 stdin 交给 workflow command。
10. Coordinator 运行 `drfx workflow record-triage --triage-stdin` 校验 triage result。Persistent state 下写入 normalized/redacted `reports/triage-round-001.md` 并更新 `ISSUES.md`；no-state `read-only` 下使用 `drfx workflow record-triage --no-state <entry-skill> <same route tokens> --assurance <assurance> <same no-state runtime platform and subagent probe fields> --runtime-stdin-handoff ready --state-token <record-review-state-token> --triage-stdin`，只返回 normalized JSON 和新的 `stateToken`，不写 report 或 ledger。
11. 如果 high/medium findings 被 deferred，停止为 `stopped-with-deferrals`。
12. 如果 mode 是 `read-only` 且仍有 blocking findings，停止为 `read-only-findings`。
13. 如果 mode 是 `read-only` 且没有 blocking findings，停止为 `read-only-clean`，不得声明 PASS。Persistent read-only 也只能把 ledger/report/state 用作 audit trail，不能升级成 `pass`。
14. 如果 mode 不是 `read-only` 且没有 blocking findings：
    - `normal` strictness 下进入 coordinator agreement；
    - `strict` strictness 下，如果本轮新增了 accepted non-blocking low issue，必须先进入 full re-review，把这些 issue IDs 带入 reviewer context；
    - `strict` strictness 下，如果 accepted non-blocking low issues 已经被带入 latest full re-review context，进入 coordinator agreement。
15. 否则进入 fix。

### 11.4 Fix

1. Coordinator 运行 `drfx workflow begin-fix` acquire target lock 并执行 pre-fix fingerprint guard。
2. `begin-fix` 必须写入 machine-parseable、redacted fix guard baseline 到 `reports/fix-guard-round-###.md`；它仍是 Markdown report，不新增 JSON sidecar：
   - target fingerprint；
   - all reference fingerprints；
   - project root 必须是 git repository，且 target document 必须是 tracked file with `HEAD` rollback anchor；如果不是 git repository、没有 `HEAD`、target 未被 git 跟踪、target staged、target dirty、target deleted/renamed/copied/unreadable，或 target 已经是 untracked file，`begin-fix` 停止为 `Status: blocked` plus `Blocking reason: rollback-unavailable`，不得进入 fix；
   - git repository 下，运行 `git status --porcelain=v1 -z -- <target> <target-state-dir>` 建立 target-only baseline，并额外运行 whole-worktree `git status --porcelain=v1 -z` 检查非目标范围；
   - baseline 只允许当前 target-state files 已经出现在 git status 中；这些 allowed state paths 可以保留 normalized path。Target document 自身在 fix 前必须 clean，不得作为 allowed dirty baseline entry；
   - 如果 whole-worktree status 中存在任何非 target、非当前 target-state path 的 modified、deleted、renamed、copied、untracked 或 unreadable entry，`begin-fix` 必须停止为 `Status: blocked` plus `Blocking reason: unexpected-worktree-change`，不得读取该文件内容，不得进入 fix；
   - blocker report 对这些 non-target entries 只能记录 `pathSha256`、status code 和 entry kind；不得记录 raw non-target path、content sha256、file size、mtime 或任何从文件内容读取出的值；
   - 该规则故意要求 automatic fix 前 target document 有 git rollback anchor 且自身 clean，同时工作树在非目标范围内干净。V2 不支持通过读取 target 或 non-target file content 来保存 pre-fix backup，也不支持证明 pre-existing dirty files 未漂移，因为这会扩大敏感信息泄漏面；
   - V2 不维护 non-git baseline；drift detection 不能提供 safe rollback，因此不满足 automatic fix 前置条件。
3. 非 git root 可以继续执行 read-only/advisory review；如果用户请求 `review-and-fix`，workflow 必须在 first target write 前停止并说明需要在 git repository 中重跑或改用 read-only。
4. `begin-fix` 成功时 JSON output 必须返回 `lockOwnerId`、`leaseId`、`leaseExpiresAt`、`refreshAfterSeconds: 60` 和 `fixGuardReportPath`。`MANIFEST.md` 或 fix guard report 必须记录 active lock owner/lease id，后续 `refresh-lock`、`end-fix` 和 `abort-fix` 只能从 persistent state 读取，不接受 coordinator 自报 owner。
5. `begin-fix` 成功后，Coordinator 必须运行 `drfx workflow context <target-state-dir> --phase fix`。该 command 写入 `context/current-fixer-context-manifest.md`，并在 JSON output 中返回 fixer context skeleton；它不得读取或保存 target body。
6. Fix context manifest 必须包含当前 round、target path、reference paths marked read-only、strictness、effective mode、assurance、lock owner/lease id、fix guard report path、accepted/reopened issue IDs、每个 issue 的 safe location anchor、constraints、required fix report schema 和 `contentPolicy: read-in-memory-only`。如果没有 accepted/reopened issue IDs，command 必须返回 validation error，不得让 coordinator 进入 target write。
7. Coordinator 或 bounded serial fixer subagent 只能从 fix context skeleton 和 in-memory target/reference reads 执行 semantic edit；不得直接 `require()` `lib/context-pack.js`，不得把 raw fixer prompt 写入 filesystem。
8. Lock refresh 规则固定如下：如果距离 `begin-fix` 或上一次 `refresh-lock` 已超过 60 秒，coordinator 必须先运行 `drfx workflow refresh-lock <target-state-dir>`，再继续任何 target write、启动 bounded fixer subagent、或提交 `end-fix`。如果 runtime 不能在 fixer subagent 运行期间刷新锁，generated route 不得把实际 target writes 委托给该 fixer subagent；它必须由 coordinator 直接编辑，或把 issue list 拆成能在当前 lease 内完成的 serial slices。`refresh-lock` 只刷新当前 active lease，owner/lease mismatch、missing lease 或 corrupt lease 都停止为对应 lock blocker。
9. Coordinator 只修复 accepted issue IDs。
10. Coordinator 只修改 target document。
11. Coordinator 保持 references read-only。
12. Coordinator 不发明 requirements、background、product decisions 或 external facts。
13. Coordinator 生成 fix report，并通过 stdin 交给 workflow command。
14. Coordinator 运行 `drfx workflow end-fix --fix-report-stdin` 校验 fix report、确认 actual changed files 只包含 target document 和允许的 `.docs-review-fix/targets/<target-key>/` state files、写入 normalized/redacted `reports/fix-round-001.md`、更新 `ISSUES.md` fixed statuses、更新 `MANIFEST.md` fingerprint，并释放 target lock。
15. `end-fix` 的 actual changed-files 校验规则：
    - git root 下，把 after status 和 persisted baseline status 对比；除 target document 和当前 target-state files 外，任何新增、修改、删除、rename、copy 或 untracked entry 都停止为 `Status: blocked` plus `Blocking reason: unexpected-worktree-change`。Blocker report 对 non-target paths 只能使用 `pathSha256`、status code 和 entry kind，不得输出 raw path 或读取 file content。
    - reference fingerprints 变化时，无论 fix report 是否声明，都停止为 `Status: blocked` plus `Blocking reason: reference-mutated-file`。
    - fix report 的 `Files changed` 必须与 actual changed target set 匹配；report 少报或多报都停止为 `Status: blocked` plus `Blocking reason: fix-report-mismatch`。
16. `end-fix` 无论 success 还是 validation blocker，都必须在写入 normalized report/receipt 后尝试 owner-checked release。若 release 失败，final blocker 改为 `Status: blocked` plus `Blocking reason: lock-release-failed`，并在 blocker report 中引用原始 blocker code。不得在 active lock 持有状态下进入 diff review。
17. 如果 coordinator 在 fix phase 中断、遇到 context pressure、无法安全产生 fix report，或判断继续 target write 不安全，必须运行 `drfx workflow abort-fix <target-state-dir> --status blocked|checkpoint --reason <code> --next-action <redacted next action>`。`abort-fix` 写入 receipt、更新 manifest、尝试 owner-checked release，并且不得把任何 pending semantic output 写入 reports。`--status blocked` 时 reason 必须来自 allowed `Blocking reason`；`--status checkpoint` 时 reason 必须来自 allowed `Status reason`。Interruption 和 context pressure 使用 `--status checkpoint --reason checkpoint-requested`。
18. 进入 diff review。

### 11.5 Diff Review

1. Coordinator 检查 fix round 的 target diff。
2. Coordinator 确认每个 change 都映射到 accepted issue ID。
3. Coordinator 确认没有引入 unrelated scope。
4. Coordinator 确认没有引入 placeholder。
5. Coordinator 确认 terminology 和 structure 仍然 coherent。
6. Coordinator 确认没有 sensitive values 被复制到 state 或 responses。
7. Coordinator 生成 diff review result，并通过 stdin 交给 workflow command。
8. Coordinator 运行 `drfx workflow record-diff-review --result-stdin` 校验并写入 normalized/redacted `reports/diff-review-round-001.md`。
9. 如果 result 是 `DIFF-OK`，进入 full re-review。
10. 如果 result 是 `DIFF-FAIL`，不得进入 full re-review。`record-diff-review` 必须把 required actions 写入 report，并把 `Status` 设回 `fix`、`Current phase: fix`、`Blocking reason: none`，让 coordinator 在同一 round 内纠正 diff-review findings。
11. 如果 coordinator 判断 `DIFF-FAIL` 无法在 target-only rule 下安全纠正，停止为 `Status: blocked` plus `Blocking reason: diff-review-failed`，final response 必须列出 required actions。

### 11.6 Full Re-Review

1. Coordinator 运行 `drfx workflow context ... --phase full-re-review` 构建新的 reviewer context manifest/skeleton；persistent context manifest 同时写入新的 reviewer guard baseline。
2. 包含 fixed issue IDs 和 accepted non-blocking low issues。
3. reviewer dispatch 前 fingerprint target 和 references 已由 `workflow context` 记录为 reviewer guard baseline；coordinator 不得自行维护未持久化的 guard state。
4. Coordinator spawn 一个新的 read-only reviewer subagent。
5. 校验 reviewer output。
6. reviewer 完成后，`record-review` 重新 fingerprint target 和 references 并与 context manifest baseline 对比。
7. 如果检测到 reviewer mutation，停止为 `Status: blocked` plus `Blocking reason: reviewer-mutated-file`。
8. Coordinator 运行 `drfx workflow record-review --phase full-re-review --result-stdin` 记录 normalized/redacted `reports/full-review-round-001.md`。
9. 如果 `PASS`，进入 coordinator agreement。
10. 如果 `FAIL` 且 findings 全部是 low severity，进入 triage；coordinator 可以按所选 strictness 的 accepted non-blocking low 规则处理。
11. 如果 `FAIL` 包含任何 blocking finding，重复 triage、fix、diff review 和 full re-review。

### 11.7 Coordinator Agreement and Finalization

只有满足以下条件，coordinator 才能 finalize `pass`：

- Mode 是 `review-and-fix`，且 workflow 使用 persistent target-local state；`read-only` 和 no-state runs 永远不能 finalize `pass`；
- 最新 full-document review 返回 `PASS`，或返回 `FAIL` 但在所选 strictness 的 triage 后只剩允许的 non-blocking low issues。没有 fix round 时，initial review 就是 latest full-document review；有任何 fix round 时，latest full-document review 必须是 fix 后的 full re-review；
- coordinator 同意 reviewer result；
- 没有 unresolved high 或 medium accepted issue；
- strict mode 下没有 unresolved low issues，除非这些 low issues 已经被明确 accepted as non-blocking，并且已被带入 latest full re-review context；
- reviewer execution 期间没有检测到 target/reference mutation；
- 所有 fix rounds 都在 full re-review 前完成了 diff review；
- final response fields 完整。

Coordinator 运行 `drfx workflow finalize --final-response-stdin` 只能持久化 final status 并校验 final response checklist。该 command 不得替 coordinator 判断是否 PASS。

No-state finalization 使用 `drfx workflow finalize --no-state <entry-skill> <same route tokens> --assurance <assurance> <same runtime platform and subagent probe fields> --state-token <latest-no-state-token> --final-response-stdin`，只校验 read-only terminal response；如果 final response 通过 stdin 传入，finalizer 必须接收 `--runtime-stdin-handoff ready`，不得沿用 preflight-only `not-required`。如果 final response 声明 `Status: pass`，必须返回 `no-state-pass-unsupported`。No-state read-only review 无 blocking findings 时使用 `Status: read-only-clean`，不是 `pass`。`latest-no-state-token` 必须来自同一次 no-state `record-review` 或 `record-triage` output，finalizer 必须校验 token 的 target、references、strictness、mode、assurance、phase 和 eligible terminal statuses。

Final response 必须包含：

- final status；
- assurance level；
- target path；
- files changed；
- fixed issue IDs；
- verification performed；
- deferrals 或 blockers；
- residual risk；
- 如果处理了 sensitive issues，需要 redaction statement。

## 12. Reviewer Report Parser

新增 `lib/reviewer-report.js`。

职责：

- 解析 `PASS`。
- 解析带 `Findings:` list 的 `FAIL`。
- 校验 hard-required fields：
  - `id`
  - `severity`
  - `location`
  - `issue`
  - `why_it_matters`
  - `suggested_fix`
  - `confidence`
- 只接受 severity values `high`、`medium`、`low`。
- 只接受 confidence values `confirmed` 和 `unconfirmed`。
- `sensitive` 是 recoverable metadata：缺失时 parser 默认 `false` 并返回 `WARN_REVIEWER_REPORT_SENSITIVE_DEFAULTED`；如果 finding text 触发 secret-like pattern，parser 必须改为 `sensitive: true`、redact affected fields，并返回 `WARN_REVIEWER_REPORT_SENSITIVE_REDACTED`。
- 如果 secret-like pattern 被 redacted 且 reviewer 原始 `confidence` 是 `confirmed`，parser 必须把 normalized `confidence` 降为 `unconfirmed`。单纯缺少 `sensitive` metadata 不得改变 confidence。
- `record-review` 必须把 producer metadata 写入 normalized report：`reviewer-subagent` for `Assurance: practical|strict-verified`，`coordinator-advisory` for `Assurance: advisory`。Producer metadata 来自 workflow state/flags，不从 semantic payload 自述读取。
- 返回 parsed output 前 redact sensitive values。
- 用 stable error codes 拒绝 malformed reports。

Parser 不判断 finding 是否有效。它只校验 shape 和 safety。

Malformed reviewer output recovery path：

1. 如果 report 只有字段名拼写或同义字段错误，例如 `impact` 代替 `why_it_matters`，parser 可以 tolerant normalize，并在 normalized report 中记录 warning。
2. 如果 report 缺少 `sensitive` 这类 recoverable metadata，parser 返回 recoverable warning 并默认 `sensitive: false`；只有实际触发 secret-like redaction 时，parser 才把受影响 finding 的 normalized `confidence` 降为 `unconfirmed`。
3. 如果 report 缺少 hard-required field，例如 `why_it_matters`，parser 必须拒绝该 report，error code 使用 `ERR_REVIEWER_REPORT_REQUIRED_FIELD`。
4. 如果 report 完全不可解析，coordinator 最多重试 reviewer 一次，并在 retry prompt 中附上 reviewer schema。
5. 如果 retry 仍失败，workflow 停止为 `Status: blocked` plus `Blocking reason: reviewer-output-unparseable`，不得修文件。

## 13. Context Pack Builder

新增 `lib/context-pack.js`。

职责：

- 生成 embedded skill 中的 context pack 构建指令。
- 为 internal `drfx workflow context` 提供 deterministic context manifest/skeleton。
- 合并 target metadata、reference metadata、rules、accepted non-blocking low issues 和 output schema。
- Redact sensitive values before writing context manifest files。

Context pack 必填字段：

- target document path；
- reference document paths，且每个 reference 必须标记 read-only；
- document type；
- strictness；
- mode；
- assurance；
- merged rule set；
- accepted non-blocking low issue IDs，续轮时必填，没有则写 `none`；
- constraints；
- required output schema；
- current round；
- phase；
- reviewer guard baseline for review phases；
- `contentPolicy: read-in-memory-only`。

Phase-specific context rules:

- `initial-review` 和 `full-re-review` context manifest 必须包含 reviewer guard baseline，并把 required output schema 设为 reviewer `PASS`/`FAIL` schema。
- `fix` context manifest 不包含 reviewer guard baseline；它必须引用 latest fix guard report path、active lock owner/lease id、accepted/reopened issue IDs、safe anchors、target-only write rule、reference read-only rule、required fix report schema 和 expected changed file set。
- `fix` context 只允许 persistent workflow 使用；no-state commands 必须拒绝 `--phase fix`。
- `fix` context command 不得做 semantic issue selection。它只从 `ISSUES.md` 和 latest triage report 读取已经 accepted/reopened 的 issue IDs；如果 ledger/report 状态不一致，停止为 `Status: blocked` plus `Blocking reason: state-validation-failed`。

Persistent `drfx workflow context <target-state-dir> ...` 写入的是 context manifest，不是完整 prompt。Coordinator 按 manifest/skeleton 读取必要 target/reference 文件，在内存中拼接 reviewer/fixer prompt；它不得直接 `require()` `lib/context-pack.js`，也不得把拼好的 raw prompt 写入 filesystem。

No-state `read-only` behavior：

- `drfx workflow context --no-state <entry-skill> <route tokens> --assurance <assurance> <same no-state runtime flags> --phase initial-review` 返回包含 `contextPackSkeleton` 和 base64url `reviewGuard` string 的 JSON output，不返回 writable path。因为 `context` 会启动 review-backed no-state path，generated routes 必须传 `--runtime-stdin-handoff ready`；preflight-only terminal flow 不调用 `context`。
- `reviewGuard` 必须是 base64url-encoded safe JSON string，并且 decode 后只包含 guard id、phase、round、normalized target/reference paths、fingerprints、strictness、mode、assurance 和 `contentPolicy: read-in-memory-only`。
- Coordinator 可以把 skeleton 和实际 target/reference 内容拼成 in-memory reviewer prompt。
- No-state `record-review` 和 `record-triage` 之间只能通过 `stateToken` 传递 redacted normalized state。`stateToken` 是 workflow command 生成的 validation artifact，不是 raw semantic handoff；generated route 不得自行构造或编辑它。
- `stateToken` 可以作为 argv 传给后续 no-state workflow commands，因为它只包含 command 已验证、已 redacted、无 raw target/reference body 的 normalized state。Raw reviewer、triage 或 final response text 仍必须通过真实 stdin channel 传入，不得放入 argv、shell、env、pipe、heredoc、raw temp file 或 project-local state。
- No-state pre-review terminal outcomes 使用 `workflow preflight --no-state` 生成 `tokenKind: preflight-terminal` 的 `stateToken`。该 token 只能支持 `unsupported` 或 `blocked` finalization，不能替代 reviewer/triage token，也不能被转换成 `read-only-clean`、`read-only-findings` 或 `pass`。
- `stateToken` encoded length 不得超过 32768 bytes。超过上限时 no-state flow 必须停止为 `state-token-too-large`，并要求用户用 `ledger=` 或 persistent `review-and-fix` 重跑；不得把 token 改写成 raw temp file、env var、pipe 或 heredoc。
- `stateToken` 不提供 cryptographic trust。No-state commands 必须把 token decode 后当作 untrusted structured input 校验 schema、canonical encoding、token kind、token id、previous token sha256、target/references/strictness/mode/assurance/phase/round/guard id 和 eligible terminal statuses。Generated route 只能保存 latest command-returned token in memory；不得手写、编辑、截断或合并 token。
- No-state `finalize` 必须根据最新 `stateToken` 验证 clean/findings/unsupported/blocker status。缺少 token、token 与当前 route tokens 不匹配、token kind 与 final status 不兼容、token 中 reviewer result 与 final status 不兼容，或 token 中仍有 blocking findings 却声明 `read-only-clean`，都必须返回 validation error JSON。
- no-state context 不得写入 `context/`、`reports/`、`MANIFEST.md`、`ISSUES.md`、receipts 或任何 `.docs-review-fix` path。
- 如果 no-state run 需要 durable blocker/audit trail，coordinator 必须停止并告知用户 rerun with `ledger=` or `review-and-fix`；不得在 no-state run 中悄悄创建 state。

## 14. Triage Contract

新增 triage reports 的 workflow support。

必需 triage report shape：

```text
Triage:
- reviewer_id: R001
  issue_id: ISSUE-001
  decision: accepted | reopened | merged | downgraded | rejected | deferred
  severity: high | medium | low
  original_severity: high | medium | low | none
  rationale: <required except plain accepted; required when non_blocking=true>
  merged_into: ISSUE-### | none
  deferred_owner: <owner or none>
  deferred_next_action: <next action or none>
  non_blocking: true | false
```

规则：

- Accepted findings 获得稳定 issue IDs。
- Reopened findings 必须引用既有 `ISSUE-###`，不得分配新 ID；它们把 ledger status 写为 `reopened`，并在 resolution 中记录 reopening rationale。
- Merged findings 必须在 `merged_into` 指向 surviving issue ID；非 merged decisions 必须写 `merged_into: none`。
- New merged findings 必须获得自己的 `issue_id`，并在 ledger 中写一行 status `merged`，resolution 写 `Merged into <surviving-id>: <rationale>`。这行 duplicate issue 是 audit trail，不代表 surviving issue 的新状态。Resume 或 full re-review 遇到同一 duplicate issue 时可以复用既有 duplicate `issue_id`，但 `merged_into` 仍必须指向另一个既有 surviving issue。
- `merged_into` 指向的 surviving issue 必须已经存在于 ledger，且不得是 `rejected` 或 `deferred` status；如果 surviving issue 状态是 `fixed`，merged finding 必须有 rationale 说明它只是 duplicate evidence，不要求重新打开 fixed issue。需要重新修复 fixed issue 时应使用 `reopened`，不是 `merged`。
- Downgraded findings 不产生 `downgraded` ledger status；`record-triage` 必须把 ledger severity 写为 downgraded 后的 `severity`，status 写为 `accepted`，resolution 保留 original severity 和 rationale。
- `non_blocking: true` 只允许用于 low severity findings，且必须有 rationale。
- `normal` strictness 下，new low finding 可以在当前 triage 中标记 `non_blocking: true` 并进入 coordinator agreement。
- `strict` strictness 下，new low finding 可以标记 `non_blocking: true`，但必须先进入 full re-review；只有该 issue ID 已经在 latest reviewer context 中列为 accepted non-blocking low，才可不再阻塞 strict PASS。
- Rejected、merged、downgraded、reopened、deferred 和 `non_blocking: true` findings 都必须有 rationale。
- Deferred findings 额外需要 `deferred_owner` 和 `deferred_next_action`。
- Deferred high/medium findings 让 workflow 停止为 `stopped-with-deferrals`。
- Triage output 不得包含 raw secrets。

## 15. Fix Report Contract

V1 fixer schema 仍然有效，并在 v2 中变成可校验 contract：

```text
Fixed:
- ISSUE-001: <summary>

Files changed:
- <target path>

Not fixed:
- ISSUE-002: <reason, or none>

Residual risk:
- <risk, or none identified>
```

V2 新增校验：

- 每个 fixed ID 必须存在于 `ISSUES.md`。
- 每个 fixed ID 在 fix 前必须是 accepted 或 reopened。
- `Files changed` 只能包含 target document，并且必须与 `end-fix` 的 actual changed-files guard 一致。
- `end-fix` 不得只信任 fix report；必须使用 git baseline 校验 target-only write rule。
- `Not fixed` 不能省略。
- `Residual risk` 不能省略。
- Raw sensitive values 在写入 reports 前必须被拒绝或 redacted。

## 16. Diff Review Contract

Diff review 必须记录到 `reports/diff-review-round-###.md`。

必需 result：

```text
DIFF-OK
Summary: <one redacted sentence or none>
```

或：

```text
DIFF-FAIL
Findings:
- issue_id: ISSUE-001
  problem: <specific problem>
  required_action: <specific next action>
```

`DIFF-OK` 允许进入 full re-review。它本身永远不能产生 PASS。

`DIFF-FAIL` 必须阻止 full re-review。Coordinator 必须按 `required_action` 在同一 round 内回到 `fix` phase 纠正，或停止为 `Status: blocked` plus `Blocking reason: diff-review-failed`。`record-diff-review` 不得把 `DIFF-FAIL` 记录成可继续到 full re-review 的状态。

## 17. Final Response Validator

新增 `lib/final-response.js`。

职责：

- 生成 embedded skill 中的 final response checklist。
- 校验 final response 是否包含 required fields。
- 校验 status 与 assurance 的组合是否合法。
- 校验 `Status: blocked` 时必须有 non-`none` `Blocking reason`；非 blocked status 的 blocking reason 必须是 `none`。
- 校验非 blocked terminal/pause status 的 `Status reason` 与 manifest 或 no-state `stateToken` 一致；blocked status 的 `Status reason` 必须是 `none`。
- Redact sensitive values before final response text is persisted or echoed in reports。

Final response 必填字段：

- final status，必须来自 terminal/pause state 枚举；
- assurance level；
- target path；
- files changed；
- fixed issue IDs；
- verification performed；
- deferrals 或 blocks，包含 issue ID、reason、owner 和 next action when applicable；
- residual risk，或 `none identified`；
- redaction statement when sensitive issues were handled。
- blocking reason when final status is `blocked`。
- status reason when final status is non-`blocked` and needs a machine-readable reason。

如果 final status 为 `pass`：

- 必须是 persistent `review-and-fix` workflow finalization；`--no-state finalize` 和任何 `read-only` finalization 必须拒绝 `pass`；
- assurance 不能是 `advisory`；
- 不得存在 unresolved high/medium accepted issues；
- latest full-document review 必须是 `PASS`，或 latest full-document review 的 `FAIL` findings 在 triage 后只剩所选 strictness 允许的 explicitly accepted non-blocking low issues；
- strict mode 下，accepted non-blocking low issue IDs 必须已经出现在 latest full re-review context 中；
- coordinator agreement 必须明确记录。

如果 final status 为 `read-only-clean`：

- assurance 可以是 `advisory` 或 `practical`，但 final response 必须明确写出它不是 workflow PASS；
- 必须是 read-only mode；
- files changed 必须是 `none`；
- reviewer result 或 triage result 必须没有会阻塞所选 strictness 的 finding；
- no-state finalization 可以接受该状态，但必须用最新 `stateToken` 验证 reviewer/triage normalized state 确实没有 blocking finding。

如果 final status 为 `read-only-findings`：

- 必须是 read-only mode；
- final response 必须列出 blocking finding 或对应 issue IDs；
- no-state finalization 必须用最新 `stateToken` 验证 reviewer/triage normalized state 仍有 blocking finding，不得只信任 final response 自述。

## 18. Manifest Updates

V2 扩展 manifest，新增字段：

```text
Manifest schema: 2
Assurance: practical | strict-verified | advisory
Runtime platform: codex | claude-code | gemini | manual
Descriptor platform: none | codex | claude | gemini
Assurance proof: none | capability-descriptor:<descriptor-platform>:<proof-run-id>
Runtime subagent probe: ready | unavailable | failed | not-required
Runtime subagent probe evidence: route-asserted-ready | none
Runtime fingerprint guard: passed | unavailable | output-invalid | not-run
Runtime stdin handoff: ready | unavailable | not-required
Runtime stdin handoff evidence: route-asserted-ready | none
Runtime downgrade reason: <runtime downgrade code or none>
Current phase: review | triage | fix | diff-review | full-re-review | final
Blocking reason: <blocker code or none>
Status reason: <non-blocked status reason or none>
Current report path: <path or none>
Last reviewer report path: <path or none>
Last triage report path: <path or none>
Last fix report path: <path or none>
Last diff review report path: <path or none>
```

`lib/target-state.js` 必须支持读取没有这些字段的 v1 manifests，并在 v2 resume 时做 normalize。
缺失 runtime fields 且没有 `Manifest schema` 字段的 v1 manifests 归一化为 advisory-compatible defaults：`Runtime platform: manual`、`Descriptor platform: none`、`Runtime subagent probe: not-required`、`Runtime subagent probe evidence: none`、`Runtime fingerprint guard: not-run`、`Runtime stdin handoff: not-required`、`Runtime stdin handoff evidence: none` 和 `Runtime downgrade reason: none`。

Normalize rules：

- 没有 `Manifest schema` 的 manifest 是 v1 manifest；只有这种 manifest 可以走 compatibility normalization。
- `Manifest schema: 2` 的 manifest 是 v2 manifest；缺失任何 v2 required field、包含未知 v2 field label、字段重复、enum 外值或非法 status/assurance/mode 组合，必须停止为 `Status: blocked` plus `Blocking reason: state-validation-failed`。Parser 不得把损坏的 v2 manifest 当作 v1 manifest 继续。
- 没有 `Assurance` 的 v1 manifest 归一化为 `advisory`，除非用户明确要求用 `practical` restart。
- 没有 `Assurance proof` 的 v1 manifest 归一化为 `none`；如果 manifest 或 final response 声称 `strict-verified` 但 proof 缺失，resume 必须降级为 `unsupported`，不得继续声明 strict verified assurance。
- 没有 `Current phase` 的 v1 manifest：如果 `Status` 是 active phase state，则 `Current phase = Status`；如果 `Status` 是 terminal/pause state，则 `Current phase = final`，但 `blocked`、`externally-changed` 和 `possible-target-replacement` 可用 latest report path 推断停止 phase。
- 没有 `Blocking reason` 的 v1 manifest 归一化为 `none`；如果 `Status` 是 `blocked` 且无法从 receipts/reports 推断 reason，resume 必须停止并要求 coordinator 输出 explicit blocker before continuing。
- 没有 `Status reason` 的 v1 manifest 归一化为 `none`；如果 `Status` 是 `externally-changed`、`possible-target-replacement`、`unsupported`、`read-only-findings` 或 `stopped-with-deferrals`，resume 可以从 latest report/receipt 推断 `Status reason`，但不得把该 reason 写入 `Blocking reason`。

## 19. Generated Skill Behavior

### 19.1 Source Skills

`skills/review-fix-*` 下的 source skills 继续保持简短，但在 generated skill 真正具备 operational workflow instructions 前，不得暗示当前包已经能独立完成 review-fix loop。

每个 source skill 必须说明：

- fixed document type；
- route invocation syntax；
- no mode token means `explain` only；users must pass `read-only` or `review-and-fix` to start a workflow；
- optional `assurance=practical|strict-verified|advisory` syntax, including that `strict` is strictness only and Strict Verified requires `assurance=strict-verified`；
- Practical Mode behavior；
- strict verified mode limitations；
- target-only write rule；
- reviewer subagent requirement；
- state directory rule。

### 19.2 Generated Practical Routes

Generated Codex skills and generated Claude Code commands 必须是 operational。Codex route 的 Practical happy path 是 v2 必达目标；Claude Code command 必须实现同一流程。当前 host 缺少 subagent 时，正确行为是 advisory downgrade；缺少 fingerprint guard 时，正确行为是 `fingerprint-guard-unavailable` / `fingerprint-guard-output-invalid` fail closed；缺少 stdin handoff 时，正确行为是 `unsafe-handoff-file` fail closed。任何 fail-closed outcome 都不得被描述为 Practical support complete。

Route start 时它们必须：

在以下 route start sequence 之前，如果用户没有显式传 `read-only` 或 `review-and-fix`，只执行 `explain` intent 并停止；不得做 subagent probe、fingerprint guard、semantic handoff、target/reference read、state write 或 final validation。
1. 把 invoking agent 视为 coordinator。
2. 解析 user-facing `assurance=` token。没有 token 时，Codex/Claude Code route 请求 Practical，Gemini route 请求 Advisory；`assurance=strict-verified` 是唯一触发 Strict Verified Mode 的用户入口。`strict` strictness flag 不得影响 assurance selection。
3. 运行 subagent probe：Practical/Strict Verified request 必须 spawn 一个不读取 target/reference、不写文件的 reviewer probe，并要求它只返回 exact single line `DRFX_REVIEWER_READY`。Probe 成功后才能把 `--runtime-subagent-probe ready` 传给 workflow commands；失败时按 6.1 的 fixed failure mapping 传 `--runtime-subagent-probe failed|unavailable` 和具体 `--runtime-downgrade-reason`，并降级为 Advisory Mode。显式 `assurance=advisory read-only` 不运行 subagent probe，必须传 `--runtime-subagent-probe not-required --runtime-downgrade-reason none`。该 flag 是 generated route 的 runtime assertion，不能被描述成 strict verified proof。
4. 运行 stdin handoff probe：确认 host 能打开可写 stdin process/session handle。成功后传 `--runtime-stdin-handoff ready`；失败时传 `--runtime-stdin-handoff unavailable` 并停止为 `unsafe-handoff-file`，不得改用 heredoc、pipe、argv、env 或 temp file。
5. 确认 internal workflow commands 可以执行 startup fingerprint probe；如果 fingerprint guard 不可用或输出不可解析，停止为对应 fingerprint blocker，不得降级为无 guard Advisory Mode，也不得修文件。Persistent start 的 startup fingerprint probe 必须发生在 state write 前；reviewer guard baseline 后续由 `workflow context` 建立。
6. Practical Mode 下，运行 `drfx workflow start ... --assurance practical --runtime-platform codex|claude-code --runtime-subagent-probe ready --runtime-stdin-handoff ready`，让 persistent manifest 记录 runtime platform、runtime assertion、stdin assertion 和 fingerprint guard 结果。Strict Verified Mode 下，route 必须先运行 `drfx check --platform <public-platform> --json`，从 JSON output 读取同一次 check 的 `runId` 和 `platforms[<public-platform>].descriptorPath`；只有这两个值存在且对应 descriptor validation summary 没有 schema/read error 时，才可运行 `drfx workflow start ... --assurance strict-verified --runtime-platform <runtime-platform> --runtime-subagent-probe ready --runtime-stdin-handoff ready --capability-descriptor <descriptorPath> --proof-run-id <runId>`。Public platform 映射固定为 `codex -> codex`、`claude-code -> claude`、`gemini -> gemini`。
7. 在 `review-and-fix` mode 下创建 target-local state；no-state `read-only` mode 下不得创建 `.docs-review-fix`。
8. 构建 reviewer context manifest/skeleton。Persistent context manifest 必须包含 reviewer guard baseline；no-state context output 必须包含 `reviewGuard`。Coordinator 在内存中拼接 review prompt。
9. Practical/strict verified path 必须 spawn reviewer subagent。Advisory downgrade path 不 spawn reviewer subagent；coordinator 自己执行 read-only advisory review，并输出相同 reviewer result schema。
10. 通过真实 stdin channel 运行 `drfx workflow record-review --result-stdin` 记录或 no-state 校验 normalized reviewer result；no-state command 必须重传同一组 runtime flags，并传入 no-state `context` output 返回的 `--review-guard <base64url-json>`。No-state output 的 `stateToken` 必须保存到当前 coordinator 内存中，供后续 no-state command 使用；不得写入 filesystem 或手工编辑。
11. 由 coordinator 执行 semantic triage，并运行 `drfx workflow record-triage --triage-stdin` 持久化或 no-state 校验 triage；no-state command 必须重传同一组 runtime flags，并传入 latest command-returned `--state-token <base64url-json>`。No-state output 返回的新 `stateToken` 替换旧 token。
12. Mode 允许时，由 coordinator 或 bounded serial fixer subagent 修复 accepted issues。
13. 运行 `drfx workflow begin-fix`、必要的 `drfx workflow refresh-lock` 和 `drfx workflow end-fix --fix-report-stdin` 管理 lock、fingerprint 和 fix report；如果 fix phase 中断或无法安全产生 fix report，运行 `drfx workflow abort-fix` 释放 lock 并记录 stop point。
14. 由 coordinator 执行 diff review，并运行 `drfx workflow record-diff-review --result-stdin` 持久化结果；`DIFF-FAIL` 不得进入 full re-review。
15. Fix 后的 Practical/strict verified path 必须 spawn full re-review。Advisory path 不进入 fix，因此不执行 full re-review。
16. Repeat until terminal status。
17. 按 section 10 的 receipt write contract 写入 receipts；round 2+、audit trail、blocker、checkpoint、interruption 和 context pressure 都不能省略。
18. 产出 final response contract，并通过真实 stdin channel 运行 `drfx workflow finalize --final-response-stdin` 做 deterministic validation/persistence。No-state route 使用 `finalize --no-state ... --state-token <latest-no-state-token 或 preflight-terminal-token> --final-response-stdin`，并重传同一 runtime platform、assurance 和 subagent probe fields；如果 finalizer 通过 stdin 接收 final response，则 `--runtime-stdin-handoff` 必须是 `ready`，不得沿用 preflight-only `not-required`。No-state final status 不得是 `pass`；clean read-only result 使用 `read-only-clean`。

它们不得仅因为 `drfx check` 报 Codex 或 Claude Code reviewer write blocking 为 `unverified` 就停止 practical mode。该 check 只阻止 strict verified assurance。

`EMBEDDED_SHARED_CONTENT` 必须包含以下内容的精简版：

- `shared/core.md` 的完整 workflow 流程，不含重复背景叙述；
- `shared/long-task.md` 的 state 目录结构、resume 规则和 lock/receipt 要求；
- COMMON rubric；
- 当前 document type 的专属 rubric；
- reviewer prompt template，包含 `PASS`/`FAIL` schema；
- fixer constraints 和 fix report template；
- coordinator loop steps；
- context pack template；
- triage report template；
- diff review contract；
- final response checklist；
- redaction rules；
- terminal/pause state enum。

`EMBEDDED_SHARED_CONTENT` 不得包含：

- 其他 document type 的 rubrics；
- platform adapter implementation details；
- capability probe internals；
- install/uninstall logic；
- raw test fixtures。

### 19.3 Claude Code Commands

Claude Code commands 可以获得与 Codex 相同的 Practical Mode，但前提完全相同：当前 runtime 向 coordinator 暴露真实 subagent 或 Task-style reviewer mechanism，并且 coordinator 能执行 reviewer fingerprint guard 和 real stdin handoff。

缺少 subagent/Task-style reviewer mechanism 时，Claude Code 必须降级为 Advisory Mode。缺少 reviewer fingerprint guard 时，Claude Code 必须 fail closed 为 fingerprint blocker，不得降级为无 guard advisory review。缺少 real stdin handoff 时，Claude Code 必须 fail closed 为 `unsafe-handoff-file`。具备 machine-verifiable reviewer isolation、reviewer write blocking 和 fingerprint guard proof，且 same-flow stdin handoff ready 时，Claude Code 才能声明 `Assurance: strict-verified`。

### 19.4 Gemini Commands

Gemini commands 仍然是 advisory-only；它们只对显式 `read-only` 启动 workflow-backed advisory review，`review-and-fix` 通过 `workflow preflight --no-state` 返回 `unsupported-runtime-capability`。

## 20. README Corrections

`README.md` 必须更新为：

- v2 之前的 V1-style installed routes 是 instruction bundles，不是 standalone executable coordinators。
- V2 Codex routes 和 Claude Code commands 通过各自的 host coordinator、reviewer subagent 和 internal deterministic workflow commands 执行 practical workflow。
- README usage examples 必须显式写 `read-only` 或 `review-and-fix`；无 mode token 的 examples 只能出现在“explain intent”说明中，并且必须说明它们不会读取 target/reference、不会创建 state、不会运行 review result。
- README 必须说明 `assurance=practical|strict-verified|advisory` 是可选 user-facing assurance request token；`strict` 和 `normal` 只控制 review strictness，不控制 assurance。Strict Verified 示例必须显式写 `assurance=strict-verified`。
- `drfx check/install/uninstall` 是 public CLI；`drfx workflow ...` 是 generated route 和 tests 使用的 internal deterministic interface。
- `drfx check --json` 是 generated routes 获取 strict verified current-run `runId` 和 descriptor path 的唯一 machine-readable proof discovery interface；human-readable `drfx check` output 不作为 proof handoff。
- CLI 不执行 semantic review、triage、正文修复、diff review judgment 或 final PASS agreement。
- Practical Mode 要求 generated route 在当前 session 内实际确认 subagent delegation 和 fingerprint guard 可用；`drfx check` 的 unverified write-blocking proof 不阻塞 practical mode。
- Practical Mode 的 subagent 确认必须通过 `DRFX_REVIEWER_READY` probe，stdin handoff 必须通过 real handle probe，并由 generated route 把 `--runtime-subagent-probe ready` 和 `--runtime-stdin-handoff ready` 传给 internal workflow command。
- Subagent unavailable 可以降级为 coordinator-produced Advisory Mode；fingerprint guard unavailable 或 output invalid 是 fail-closed blocker，不会降级成无 guard advisory review。
- 显式 `assurance=advisory read-only` 是用户主动选择 coordinator-produced advisory review；Codex/Claude Code route 不运行 subagent probe，传 `--runtime-subagent-probe not-required --runtime-downgrade-reason none`，但仍必须通过 fingerprint guard 和 real stdin handoff。
- Practical Mode 不需要 `drfx check` strict proof。
- Strict verified PASS 需要 current-run proof of reviewer isolation、write blocking 和 fingerprint guard；generated route 必须只在用户显式传 `assurance=strict-verified` 时运行 proof flow，并把 `drfx check` 的 descriptor path 和 run id 传给 `drfx workflow start --assurance strict-verified --runtime-platform <runtime-platform> --runtime-subagent-probe ready --runtime-stdin-handoff ready --capability-descriptor <path> --proof-run-id <run-id>`。
- Gemini 是 advisory-only；Gemini `review-and-fix` 返回 `unsupported`，Gemini `read-only` 才运行 advisory review。
- 真实 `review-and-fix` runs 会创建 target-local state。
- Automatic target writes require a git repository, an existing `HEAD`, and a tracked, clean target document. Non-git document projects, untracked targets, staged targets, dirty targets, or targets without a rollback anchor can run read-only/advisory review, but `review-and-fix` blocks before the first target write with `rollback-unavailable`。
- Generated routes pass semantic reports to workflow commands through stdin; they do not write raw reviewer/fixer/coordinator output to project-local temp files or workflow state。
- Generated routes must use a real stdin channel for semantic handoff; if a host cannot stream stdin to a command, it must not fall back to heredocs, shell pipes, argv, environment variables, or raw temp files。
- Generated routes must record stdin handoff as `runtimeCheck.stdinHandoff` / `Runtime stdin handoff` and fail closed as `unsafe-handoff-file` before semantic handoff when unavailable。
- `read-only` without `ledger=` and without `resume` 仍然是 no-state；如果用户需要 durable blocker/audit trail，必须用 `ledger=` 或 persistent run 重跑。No-state commands use an in-memory `stateToken` to validate final status across `preflight`、`record-review`、`record-triage` 和 `finalize` without writing `.docs-review-fix`。No-state clean review uses `Status: read-only-clean`, not `pass`。
- No-state `stateToken` 通过 argv 传递且有 32768-byte encoded length cap；超过上限时必须用 `ledger=` 或 persistent run 重跑。
- Persistent `read-only` with `ledger=` or `resume` may write audit state, but it still cannot produce `Status: pass`; clean result remains `read-only-clean`。
- no-state `read-only` runs 可以使用 workflow commands 做 validation 和 JSON normalization，但不得写 `.docs-review-fix`。

## 21. Test Plan

新增测试必须证明 workflow 存在，而不只是 prompt text 描述了 workflow。

### 21.1 Workflow State Tests

覆盖：

- `drfx workflow start review-fix-design target=design/DESIGN-v1.md review-and-fix --assurance practical --runtime-platform codex --runtime-subagent-probe ready --runtime-stdin-handoff ready` 创建 `.docs-review-fix/targets/<target-key>/`。
- Manifest 包含 document type、strictness、mode、assurance、runtime platform、target key、fingerprints、stdin handoff state 和 ledger path。
- `read-only` without `ledger=` and without `resume` 不创建 state。
- pass-capable `review-and-fix`（`practical` 或 valid `strict-verified`）创建 state；`advisory` 不得以 `review-and-fix` effective mode 创建 state。
- no-state `read-only` workflow command outputs use `targetStateDir: null`、`manifestPath: null`、`ledgerPath: null`、`contextPackSkeleton` 和 `reviewGuard`，并且不创建 `.docs-review-fix`。
- workflow JSON outputs always include `ok`; errors use fixed `ok/status/errorCode/message/targetStateDir/manifestPath/blockingReason/statusReason/nextAction` shape。
- External references 在 context manifests/skeletons 中标记为 read-only。
- Internal workflow commands do not edit target content。
- `workflow start` validates merged rulebook hard-constraint conflicts before any persistent write；a conflict returns `Status: blocked` plus `Blocking reason: state-validation-failed` and leaves no target state directory、manifest、ledger、report、context file or receipt。
- Custom `ledger=` under `context/` or `reports/` is rejected as reserved target-state path。
- Existing `test/target-state.test.js` exact `ALLOWED_STATUSES` assertion must be updated to include `read-only-clean` and any new v2 terminal/pause statuses before implementation can be considered complete。
- Existing custom ledger reserved-path tests must be extended to reject `context/`、`reports/`、`context/merged-rules.md` 和 `reports/*.md`。
- `workflow start` with `Assurance: advisory` never persists `Mode: review-and-fix`；explicit advisory `review-and-fix` returns `advisory-review-and-fix-unsupported` unless it is a runtime downgrade path that normalizes effective mode to `read-only` with a valid downgrade reason。
- Generated routes with no mode token execute `explain` only and do not call `drfx workflow ...`。
- `assurance=practical|strict-verified|advisory` is parsed only when `includeMetadata: true`; `strict` strictness never changes assurance；explicit `assurance=` must match `--assurance` or workflow commands reject before state/token writes。
- Direct manual/test `workflow start` with no `--assurance` and no mode token defaults to `Assurance: advisory` plus requested/effective `Mode: read-only` and reports `modeNormalizedFrom: null`。
- `--assurance practical` is rejected unless `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready` and `--runtime-stdin-handoff ready` are all present。
- `workflow start --assurance practical --runtime-platform codex --runtime-subagent-probe ready --runtime-stdin-handoff ready` computes startup fingerprints before writing persistent state；fingerprint guard failure returns `ok: false`、`Status: blocked`、matching fingerprint `Blocking reason` and does not create a target state directory, partial practical manifest or advisory downgrade manifest。
- Persistent `workflow start --assurance practical --runtime-platform codex|claude-code --runtime-subagent-probe ready --runtime-stdin-handoff ready` writes runtime fields to `MANIFEST.md`; later persistent subcommands emit the same `runtimeCheck` without requiring the flags again。
- Direct manual/test `--runtime-platform manual` is advisory-only and cannot persist `Assurance: practical` or `Status: pass`。
- Persistent `workflow start` writes `Manifest schema: 2`; v2 manifest parser blocks corrupted schema-2 manifests as `state-validation-failed` instead of treating them as v1 manifests。
- no-state subcommands reject `--assurance strict-verified`。
- Runtime downgrade reasons are validated against the allowed enum and appear in `runtimeCheck` JSON output。
- Runtime stdin handoff is validated against `ready|unavailable|not-required` and appears in `runtimeCheck.stdinHandoff` JSON output and schema-2 manifest fields。
- `drfx check --json` returns current-run `runId` and per-platform `descriptorPath` values, while human-readable `drfx check` remains backward compatible and is not used for strict proof handoff。
- Strict verified descriptor validation failure writes only advisory-compatible `Status: unsupported` state with `Mode: read-only` and `Status reason: strict-proof-validation-failed` when target state can be safely derived and startup fingerprint probe succeeds；if target state cannot be safely derived or fingerprint probe is unavailable/output-invalid, it writes no state. All paths must prove no `Mode: review-and-fix` plus `Assurance: advisory` combination and no `Assurance: strict-verified` field are persisted。
- `assurance=strict-verified read-only` creates persistent read-only state even without `ledger=` or `resume`, rejects no-state execution, and can finalize only `read-only-clean`、`read-only-findings`、`unsupported` or `blocked`。
- Persistent `context/*-context-manifest.md` files do not contain raw target/reference body text。
- Persistent `record-review` recomputes reviewer guard fingerprints from latest context manifest and blocks `reviewer-mutated-file` before writing reviewer report。
- No-state `record-review` requires `--review-guard <base64url-json>` from no-state `context` output and blocks `reviewer-mutated-file` on fingerprint mismatch。
- `workflow preflight --no-state` returns a canonical `tokenKind: preflight-terminal` token for pre-review `unsupported` or `blocked` states; no-state `finalize` accepts that token only for the matching terminal status and rejects attempts to convert it to clean/findings/pass。
- No-state `record-review` returns a redacted canonical `stateToken` with `previousTokenSha256: none` on the first token；no-state `record-triage` and `finalize` reject missing, malformed, padded-base64url, non-canonical, unknown-field, wrong-kind, wrong-lineage, wrong-target, wrong-phase, stale, or over-32768-byte tokens。
- No-state commands that would produce an over-32768-byte `stateToken` stop as `Status: blocked` plus `Blocking reason: state-token-too-large` and tell the user to rerun with `ledger=` or persistent state。
- No-state `finalize` rejects `read-only-clean` when the latest `stateToken` contains blocking findings, and rejects `read-only-findings` when the token contains no blocking findings。
- Persistent and no-state `read-only` finalization rejects `Status: pass` and uses `read-only-clean` for clean reviews。
- Generated semantic handoff uses stdin forms in route text; missing host stdin handle is recorded as `runtimeCheck.stdinHandoff.status: unavailable` and rejected as `unsafe-handoff-file`; file handoff paths under project-local state are also rejected as `unsafe-handoff-file`。
- `SUMMARY.md` is written only at terminal/pause/checkpoint/blocker or configured audit/round stop points, contains only manifest/ledger/report-derived redacted fields, and missing `SUMMARY.md` does not block resume。
- `CONTINUITY.md` is optional; resume reads it when present but ignores missing or malformed continuity for deterministic phase selection, returning only a recoverable warning。
- Receipt paths use `rounds/<round>-<kind>.md` with `-attempt-###` on repeated writes, include the fixed receipt fields, and are mandatory for blocker、checkpoint、interruption、context pressure、round >= 2 and audit trail paths。

### 21.2 Reviewer Report Tests

覆盖：

- `PASS` parser。
- valid `FAIL` parser。
- missing `why_it_matters` rejection。
- recoverable alias normalization with warning。
- unparseable reviewer output retry path becomes `Status: blocked` plus `Blocking reason: reviewer-output-unparseable` after one failed retry。
- missing `sensitive` defaults to `false` without confidence downgrade; secret-like redaction sets `sensitive: true` and downgrades confirmed confidence to `unconfirmed`。
- invalid severity rejection。
- invalid confidence rejection。
- sensitive value redaction。

### 21.3 Context Pack Tests

覆盖：

- context manifest/skeleton includes target path、document type、strictness、mode、assurance 和 phase。
- reference paths are marked read-only。
- context manifest/skeleton includes COMMON plus current document type rubric only。
- resume rebuilds context instead of trusting stale context files。
- accepted non-blocking low issue IDs are included in full re-review context。
- context manifests include `contentPolicy: read-in-memory-only` and exclude target/reference body content。
- `context/merged-rules.md` is produced by workflow/rulebook integration, not by an undefined coordinator-to-CLI handoff。
- `workflow context <target-state-dir> --phase fix` writes `context/current-fixer-context-manifest.md` with active lock metadata、fix guard report path、accepted/reopened issue IDs、safe anchors、target-only constraints 和 fix report schema。
- `workflow context --phase fix` rejects no accepted/reopened issue IDs and no-state usage；it does not perform semantic issue selection。

### 21.4 Triage Tests

覆盖：

- accepted findings become stable issue IDs。
- reopened findings keep the original issue ID and write ledger status `reopened` with rationale。
- merged findings reference surviving IDs。
- rejected、merged、downgraded、reopened 和 deferred findings require rationale。
- downgraded findings write downgraded severity to ledger without adding a `downgraded` ledger status。
- normal low findings can be recorded as explicitly accepted non-blocking only with rationale。
- strict low findings newly accepted as non-blocking require a full re-review context before PASS。
- deferred high/medium findings require owner and next action。
- strict low findings block until fixed or accepted non-blocking。

### 21.5 Fix and Lock Tests

覆盖：

- fix cannot begin without lock。
- pre-fix fingerprint mismatch stops as `externally-changed`。
- fix report cannot claim reference file changes。
- fixed issue IDs must exist and be accepted。
- lock is released after successful fix。
- release failure is reported as `Status: blocked` plus `Blocking reason: lock-release-failed`。
- `refresh-lock` refreshes only the persisted active lease and rejects missing、corrupt、wrong-owner or stale leases with the correct lock blocker。
- Generated routes refresh the lock before target writes when more than 60 seconds have elapsed since `begin-fix` or previous refresh。
- `abort-fix` writes a receipt, updates manifest to `blocked` or `checkpoint`, attempts owner-checked release, and does not persist raw pending semantic output。
- `end-fix` attempts owner-checked release on success and validation blocker; release failure becomes `lock-release-failed` while preserving the original blocker in the blocker report。
- git-backed target-only guard detects any non-target worktree change introduced during fix。
- git-backed `begin-fix` blocks pre-existing non-target dirty worktree entries before target writes, records only `pathSha256`、status code 和 entry kind for those blocked entries, and never reads or persists non-target file content hashes、sizes、mtimes or raw paths。
- git-backed `begin-fix` rejects a missing `HEAD`, untracked target, staged target, dirty target, deleted/renamed/copied target, or unreadable target before writes as `Status: blocked` plus `Blocking reason: rollback-unavailable`。
- non-git `review-and-fix` stops before target writes as `Status: blocked` plus `Blocking reason: rollback-unavailable`。
- reference mutation during fix stops as `Status: blocked` plus `Blocking reason: reference-mutated-file`。
- fix report mismatch with actual changed files stops as `Status: blocked` plus `Blocking reason: fix-report-mismatch`。

### 21.6 Diff Review Tests

覆盖：

- `DIFF-OK` permits full re-review。
- `DIFF-FAIL` blocks full re-review, records required action, and either returns to `fix` in the same round or stops as `Status: blocked` plus `Blocking reason: diff-review-failed`。
- repeated fix/diff-review attempts in the same round use `-attempt-###` report paths and do not overwrite earlier reports。
- diff review cannot produce PASS。

### 21.7 Final Response Tests

覆盖：

- final response requires status、assurance、target path、files changed、fixed issue IDs、verification、deferrals/blocks、residual risk。
- final response validator accepts `--final-response-stdin` for generated routes, still supports safe file fixtures copied into OS temp, rejects repository-local fixture paths as handoff input, and validates `Blocking reason` for `Status: blocked`。
- `Status: pass` rejects `Assurance: advisory`。
- `Status: pass` rejects `Mode: read-only` even when state is persistent and assurance is `practical` or `strict-verified`。
- no-state `finalize` rejects `Status: pass` as `no-state-pass-unsupported`。
- no-state `finalize` accepts `Status: read-only-clean` for clean read-only reviews and verifies the final response does not call it PASS。
- no-state `finalize` requires latest `stateToken` and validates `read-only-clean` / `read-only-findings` against token contents。
- `Status: pass` rejects unresolved high/medium accepted issues。
- sensitive issue handling requires redaction statement。

### 21.8 Resume Tests

覆盖：

- resume loads manifest, ledger, continuity, and latest reports。
- resume uses latest report files to determine current phase。
- strictness conflict stops for user confirmation。
- mode conflict stops for user confirmation。
- stale prior PASS clears pass and starts review。
- stale non-pass state becomes `externally-changed`。
- same-path replacement becomes `possible-target-replacement`。

### 21.9 Generated Skill Tests

覆盖：

- generated Codex skill and generated Claude Code command both contain Practical Mode。
- generated Codex skill and generated Claude Code command do not treat unverified write blocking as a blocker for practical mode。
- generated Codex skill passes `--runtime-platform codex`; generated Claude Code command passes `--runtime-platform claude-code`。
- generated Codex skill and generated Claude Code command require `DRFX_REVIEWER_READY` probe before practical workflow start。
- generated routes pass `--runtime-subagent-probe ready` only after the probe succeeds。
- generated Codex skill and generated Claude Code command skip subagent probe for explicit `assurance=advisory read-only`, pass `--runtime-subagent-probe not-required --runtime-downgrade-reason none`, and still require fingerprint guard plus real stdin handoff before advisory review。
- generated routes parse `assurance=strict-verified` as the only Strict Verified user trigger and never treat `strict` strictness as an assurance request。
- generated routes pass `--runtime-stdin-handoff ready` only after proving a real stdin handle is available, and pass `unavailable` only for `unsafe-handoff-file` terminal/blocker paths。
- generated routes map probe tool absence, dispatch failure, and invalid probe output to the exact runtime downgrade reasons from 6.1。
- generated routes repeat the same runtime platform、assurance and subagent probe fields on no-state `context`、`record-review`、`record-triage` 和 `finalize` commands；when finalizer consumes `--final-response-stdin`, it must pass `--runtime-stdin-handoff ready` even if an earlier preflight token recorded `not-required`。
- generated routes require reviewer subagent dispatch for initial review and full re-review。
- generated routes record advisory downgrade reason when subagent dispatch is unavailable, and fail closed with fingerprint blocker when fingerprint guard is unavailable or output-invalid。
- generated routes do not delegate actual target writes to a fixer subagent unless they can satisfy the lock refresh rule; otherwise the coordinator edits directly or splits work into serial slices。
- generated routes call `abort-fix` when fix phase stops before a valid fix report can be produced。
- generated routes keep no-state `stateToken` values in coordinator memory and pass latest review/triage/preflight token to no-state `record-triage` and `finalize` without writing it to filesystem。
- generated routes require a real stdin handle before semantic handoff and do not instruct the coordinator to put semantic payloads in shell strings、argv、environment variables、heredocs、pipes or raw temp files。
- strict verified workflow start rejects missing, stale, wrong-run, installer-default, schema-invalid, or non-verified capability descriptor proof unless `validateCurrentDescriptor(...).trusted` and `.passCapable` are both true with no errors。
- strict verified generated routes obtain proof only from `drfx check --json` in the same route flow after explicit `assurance=strict-verified`; tests must reject any generated route text that scrapes human-readable `drfx check` output, treats `strict` as assurance, or reuses an installer-default descriptor path。
- generated routes require `.docs-review-fix/targets/<target-key>/` for `review-and-fix`。
- generated routes use `drfx workflow ...` only for deterministic state work。
- generated routes state that review、triage、fix、diff review judgment and final agreement are LLM work。
- generated Claude Code command falls back to advisory when subagent is unavailable, but fails closed with fingerprint blocker when fingerprint guard is unavailable or output-invalid。
- generated Claude Code command must also fail closed as `unsafe-handoff-file` when stdin handoff is unavailable, and must not describe any fail-closed outcome as completed Practical support。
- generated Gemini route remains advisory-only, runs workflow-backed review only for explicit `read-only`, and returns `unsupported-runtime-capability` for `review-and-fix` through no-state `preflight-terminal` token。
- generated Codex skill and generated Claude Code command define `EMBEDDED_SHARED_CONTENT` scope。

### 21.10 End-to-End Fixture Tests

使用 deterministic fixture source files，不使用 live model calls。Semantic payloads 默认通过 stdin 传入；需要覆盖 file input forms 的测试必须把 redacted fixture payload copy 到 OS temp directory 后再传 `--result <file>` / `--triage <file>` / `--fix-report <file>` / `--final-response <file>`。测试不得把 repository-local `test/fixtures/**` path 直接作为 workflow handoff file。

Fixture harness 只证明 deterministic workflow facade、state transitions、guard behavior 和 generated route text contract。它不证明 live model semantic quality，也不声称真实 Codex 或 Claude Code runtime 已经完成一次 model-backed review-fix loop。

Fixture harness 应通过 scripted reviewer/coordinator/fixer reports 模拟：

- reviewer `FAIL`；
- coordinator triage；
- target fix；
- diff review `DIFF-OK`；
- full re-review `PASS`；
- final `pass` with `Assurance: practical`。

Fixture test 应断言 manifest、ledger、reports、receipts 和 target content 都按预期更新。

The deterministic fixture harness is the actor that mutates the target file between successful `drfx workflow begin-fix` and `drfx workflow end-fix --fix-report-stdin`。That scripted edit stands in for the LLM coordinator/fixer in tests. No `drfx workflow ...` command may edit target content in order to make the fixture pass; workflow commands only acquire/refresh/release locks, validate reports, verify target-only changes, update state and persist normalized artifacts.

真实 Codex 和 Claude Code route 可执行性需要单独的 manual smoke run：用 installed generated Codex skill 和 generated Claude Code command 对一个 fixture target 各运行一次实际 workflow，记录 final response、state directory 和 changed target diff。Manual smoke 不替代 deterministic tests，也不作为 `npm test` 的一部分。

## 22. Rollback and Failure Handling

Rollback 是 file-based：

- target lock 防止 concurrent writes。
- Pre-fix fingerprint guard 阻止 stale writes。
- Automatic target writes 只允许在 document project 是 git repository 时执行；git 是 v2 唯一 rollback mechanism。
- 如果 document project 不是 git repository，`begin-fix` 必须在 first target write 前停止为 `Status: blocked` plus `Blocking reason: rollback-unavailable`，并提示用户在 git repository 中重跑或改用 `read-only`。
- 即使 document project 是 git repository，automatic target writes 也只允许在 target document 是 tracked file、repository has `HEAD`、target index clean、target worktree clean、且 target 没有 delete/rename/copy/unreadable/untracked state 时执行。否则 git 不能可靠提供 pre-fix rollback anchor，`begin-fix` 必须停止为 `Status: blocked` plus `Blocking reason: rollback-unavailable`。
- V2 不把 target document raw copy 写入 `.docs-review-fix` 做 backup。这样避免为了 rollback 把 secrets 或 raw document body 持久化进 workflow state。
- Round reports 和 receipts 记录具体 fixed issue IDs、changed target path、verification 和 next action，但不作为 non-git rollback substitute。

Failure states and blocker reasons：

Terminal/pause status values:

- `pass`
- `read-only-clean`
- `blocked`
- `unsupported`
- `externally-changed`
- `possible-target-replacement`
- `read-only-findings`
- `stopped-with-deferrals`
- `checkpoint`

Allowed `Blocking reason` values when `Status: blocked`:

- `reviewer-mutated-file`
- `lock-held`
- `corrupt-lock`
- `lock-release-failed`
- `reviewer-output-unparseable`
- `fingerprint-guard-unavailable`
- `fingerprint-guard-output-invalid`
- `state-validation-failed`
- `state-token-too-large`
- `final-validation-failed`
- `target-only-guard-unavailable`
- `unexpected-worktree-change`
- `reference-mutated-file`
- `fix-report-mismatch`
- `diff-review-failed`
- `rollback-unavailable`
- `unsafe-handoff-file`

`Blocking reason` must be `none` for non-`blocked` statuses.

Non-`blocked` terminal/pause details use `Status reason` / `statusReason` instead of `Blocking reason`.

Allowed `Status reason` values when `Status` is not `blocked`:

- `none`
- `strict-proof-validation-failed`
- `target-fingerprint-mismatch`
- `manifest-fingerprint-mismatch`
- `stale-fingerprint-mismatch`
- `same-path-replacement-suspected`
- `read-only-blocking-findings`
- `deferred-findings`
- `unsupported-runtime-capability`
- `checkpoint-requested`

`Status reason` must be `none` for `Status: blocked`. Current `lib/lock.js` errors such as `target-fingerprint-mismatch`、`manifest-fingerprint-mismatch` 和 `stale-fingerprint-mismatch` map to `Status: externally-changed` plus matching `Status reason`; they must not be written to `Blocking reason`.

每个 blocker 必须记录：

- blocker code；
- target path；
- current phase；
- report path when available；
- changed path only when it is target/reference/current target-state path；otherwise use `pathSha256` or redacted path；
- next action。

## 23. Acceptance Criteria

V2 可接受标准：

- Deterministic fixture harness 能通过 scripted reviewer/coordinator/fixer reports 驱动 generated route contract 和 `drfx workflow ...` facade，完成 practical workflow state transition。
- 一次 manual Codex smoke run 必须在 fixture target 上完成 Practical `review-and-fix` happy path，并产出 state directory、final response 和 target diff 作为人工验收记录。
- 一次 manual Claude Code smoke run 必须验证当前 runtime 的真实能力：如果 Claude Code runtime 暴露 subagent、fingerprint guard 和 stdin handoff，它必须完成同样的 Practical fixture workflow；如果 subagent 不可用，smoke 必须降级到 Advisory Mode；如果 fingerprint guard 不可用或 stdin handoff 不可用，smoke 必须在 first target write 前 fail closed 为对应 blocker，并且 README/generated command 不得声称该环境已完成 Claude Practical support。
- `review-and-fix` 创建 `.docs-review-fix/targets/<target-key>/`。
- Loop 记录 reviewer、triage、fix、diff review 和 full re-review reports。
- Loop 更新 `MANIFEST.md` 和 `ISSUES.md`。
- Loop 在 target writes 前使用 `lib/lock.js`。
- Fix phase 使用 `begin-fix`、`refresh-lock`、`end-fix` 和 `abort-fix` 闭合 lock lifecycle；任何 success、blocker、checkpoint、interruption 或 context pressure stop 都不得遗留 active lock，除非 release 失败并明确输出 `lock-release-failed`。
- Loop 只在 git repository 中执行 automatic target writes，并在 fix round 前后用 git target-only guard 校验 target-only write rule；fix 前若 target 没有 `HEAD` rollback anchor、未被 git 跟踪、staged、dirty、deleted/renamed/copied/unreadable，必须先停止为 `rollback-unavailable`。若存在非 target、非当前 target-state dirty worktree entry，必须先阻塞，且不得读取或持久化 non-target file content metadata。
- Non-git `review-and-fix`、untracked target、dirty target、staged target 或缺少 `HEAD` rollback anchor 的 target 在 first target write 前停止为 `rollback-unavailable`。
- Loop 通过 reviewer guard fingerprints 检测 reviewer mutation；persistent guard baseline lives in context manifest，no-state guard baseline is passed as `--review-guard <base64url-json>`。
- Receipts 按 section 10 的 stop-point 和 round/audit 规则写入，且包含 fixed fields；`CONTINUITY.md` 和 `SUMMARY.md` 是 optional state files，缺失不得阻塞 deterministic resume。
- No-state read-only flow uses generated canonical `stateToken` values between `preflight`、`record-review`、`record-triage` 和 `finalize` so final validation is state-backed without writing `.docs-review-fix`；tokens are untrusted inputs and must pass schema、canonical encoding、base64url no-padding validation、lineage、route-parameter validation and the 32768-byte encoded length cap。
- Loop 在 fixes 后执行 full re-review。
- Persistent `review-and-fix` Loop 可以以 `pass` + `Assurance: practical` 结束；所有 `read-only` runs，包括 no-state 和 persistent read-only，都不得声明 `pass`，clean result 必须是 `read-only-clean`。
- Loop 不允许 internal CLI 执行 semantic review、triage、target content fix、diff review judgment 或 final agreement。
- Codex 或 Claude Code 缺少 subagent 时降级为 `Assurance: advisory`，且不得修文件；缺少 fingerprint guard 时 fail closed，不得进入无 guard advisory review。
- Practical Mode 必须通过 live `DRFX_REVIEWER_READY` subagent probe 和 real stdin handoff probe，并把 `--runtime-platform codex|claude-code`、`--runtime-subagent-probe ready` 和 `--runtime-stdin-handoff ready` 传给 workflow commands。
- 显式 `assurance=advisory read-only` 不运行 `DRFX_REVIEWER_READY` probe，但必须传 `--runtime-subagent-probe not-required --runtime-downgrade-reason none`，且仍要通过 fingerprint guard 和 real stdin handoff。
- Practical Mode probe failure mapping 固定为 `subagent-delegation-unavailable`、`reviewer-dispatch-failed` 或 `reviewer-probe-invalid`，不得靠自然语言解释 probe output。
- Persistent Practical workflow 必须把 runtime platform、subagent probe assertion、stdin handoff assertion、fingerprint guard result 和 downgrade reason 写入 manifest，并让后续 command output 从 manifest 派生 `runtimeCheck`。Practical manifest 的 downgrade reason 必须是 `none`；advisory downgrade manifest 才能写 subagent downgrade reason。
- 缺少 current-run verified capability proof 时，loop 不声明 strict verified assurance。
- `--assurance strict-verified` without explicit route token `assurance=strict-verified` and matching `--runtime-platform`、`--runtime-subagent-probe ready`、`--runtime-stdin-handoff ready`、`--capability-descriptor` 和 `--proof-run-id` validation is rejected before manifest/final PASS persistence；validation must require `valid`、`trusted`、`passCapable` and no errors from `validateCurrentDescriptor`。
- Generated routes use a real stdin-handle semantic handoff and expose it as `runtimeCheck.stdinHandoff`; persistent context manifests and reports never store raw target/reference bodies, raw transcripts, raw semantic input, or raw secrets。
- No-state preflight tokens may record `Runtime stdin handoff: not-required` only before semantic payload exists；any no-state finalizer that receives `--final-response-stdin` must pass `--runtime-stdin-handoff ready` or clearly emit an unvalidated terminal response when stdin is unavailable。
- 保持 `read-only` no-state behavior；no-state finalization 只能输出 non-pass terminal statuses，包括 `read-only-clean`、`read-only-findings`、`unsupported` 和 `blocked`。
- Non-`blocked` terminal/pause details use `Status reason` / `statusReason`；`Blocking reason` remains `none` unless `Status: blocked`。
- Gemini 保持 advisory-only；`read-only` can run advisory review, `review-and-fix` returns `unsupported-runtime-capability` through a no-state `preflight-terminal` token without target writes。
- `npm test` passes。
- `node bin/drfx.js check` 继续工作。
- `node bin/drfx.js check --json` 输出 current-run `runId`、descriptor paths 和 validation summary，且不打印 human report text。
- `npm pack --dry-run` 包含预期 package files，并排除 project-local `.docs-review-fix` state。

## 24. Recommended Implementation Order

1. Add `design/DESIGN-v2.md`。
2. Add reviewer report parser, recovery behavior, stdin handoff support, and tests。
3. Add context manifest builder, merged-rule integration, and tests。
4. Add final response validator with `--final-response-stdin` and tests。
5. Extend manifest schema with v2 fields while preserving v1 read compatibility。
6. Extend `lib/target-state.js` reserved ledger paths to include `context/` and `reports/`。
7. Add `bin/drfx.js` workflow parser/dispatcher, `assurance=` token parsing, strict verified descriptor proof validation, runtime subagent probe flags, runtime stdin handoff flags, stdin/file handoff validation, `--no-state` validation mode, and internal help。
8. Add internal `drfx workflow start` and `drfx workflow preflight --no-state` commands and tests。
9. Add internal review/triage recording and ledger integration, including downgraded-to-ledger mapping。
10. Add internal begin-fix/refresh-lock/end-fix/abort-fix commands using lock、fingerprint guards、git baseline target-only guard, non-git and no-clean-target `rollback-unavailable` blocking, lock release guarantees, and fix stop receipts。
11. Add receipt writer integration and optional `SUMMARY.md` generation for terminal/pause/checkpoint/blocker and round/audit stop points。
12. Add internal diff review recording。
13. Add internal finalize command using `--final-response-stdin` validation。
14. Update generated Codex skill template and Claude Code command template for `assurance=` route token handling, `DRFX_REVIEWER_READY` runtime subagent probe, runtime stdin handoff probe, runtime platform propagation, no-state behavior, preflight terminal tokens, lock refresh/abort rules, stdin semantic handoff, and `EMBEDDED_SHARED_CONTENT` scope。
15. Update Gemini template, source skills, shared long-task docs, and README。
16. Add deterministic end-to-end fixture workflow test。
17. Reinstall Codex skills and Claude Code commands from the package。
18. Run mandatory manual Codex Practical smoke on a fixture target；run Claude Code smoke to prove either Practical success when runtime prerequisites exist or fail-closed/advisory behavior before target writes when they do not；then run the workflow on `design/DESIGN-v2.md` as the first real validation target for the available practical runtime。

## 25. Key Decisions

- V2 把 Practical Mode 作为默认有用路径。
- Strict verified capability 仍然有价值，但不能阻塞 practical review-fix。
- Strict verified assurance 必须由 explicit user-facing `assurance=strict-verified` request 和 current-run descriptor validation 共同证明，且 validation result 必须是 `trusted/passCapable`；`strict` strictness 和 `--assurance strict-verified` 本身都不是 proof。
- Public CLI 保留 `check/install/uninstall`。
- Internal `drfx workflow ...` commands 负责 deterministic state 和 validation，不负责 semantic LLM judgment。
- Generated Codex skills and Claude Code commands 必须变成 operational route instructions，而不是 passive embedded reference files。
- Review、triage semantic judgment、target content fixes、diff review judgment 和 final agreement 必须由 LLM coordinator/reviewer/fixer 完成。
- Practical PASS 表示为 `Status: pass` plus `Assurance: practical`，且只允许 persistent `review-and-fix` finalization。
- Practical PASS 需要 persistent `review-and-fix` state；no-state 和 persistent `read-only` runs 即使有 practical reviewer probe，也不能声明 `Status: pass`。
- Clean read-only result 使用 `Status: read-only-clean`，并且 final response 必须说明它不是 workflow PASS。
- Practical runtime probes 是 generated route 的 current-session assertions，不是 strict verified proof；manifest 必须记录 subagent probe、stdin handoff probe 和 fingerprint guard 的状态与 evidence。
- Runtime platform 是独立字段。`Assurance: practical` 表示保障级别；`Runtime platform: codex|claude-code` 表示执行宿主。不得再使用 `codex-practical` 或 `claude-code-practical` 这类 platform-specific assurance values。
- Runtime platform 由 generated entrypoint 显式传入，不做 host auto-detection；Codex skill、Claude Code command 和 Gemini command 的入口不同，入口模板就是平台识别边界。
- Blockers 表示为 `Status: blocked` plus `Blocking reason: <code>`，不把 `blocked: <code>` 写进 manifest status。
- Non-`blocked` terminal/pause details 表示为 `Status reason: <code>` / `statusReason: <code>`；这些 reason 不得写入 `Blocking reason`。
- no-state `read-only` runs 可以使用 deterministic commands 做 validation 和 JSON normalization，并用 command-generated canonical `stateToken` 串联 preflight/review/triage/finalize validation，但不得写 `.docs-review-fix`。`stateToken` 不是 tamper-proof proof，后续 commands 必须按 untrusted input 校验，并执行 unpadded base64url canonical encoding 和 32768-byte encoded length cap。
- Semantic handoff 使用 host runtime 的真实 stdin handle，generated routes 不写 raw model output handoff files；stdin handoff availability 是 runtimeCheck 的 first-class field。
- Semantic handoff 不得把 semantic payload 放入 shell、argv、env、heredoc、pipe literal 或 raw temp file。
- Context files 是 manifests/rule snapshots，不保存 raw target/reference bodies 或 raw prompts。
- Persisted normalized reports 使用 Markdown-only；V2 不维护 JSON sidecars。
- Fix target-only enforcement 使用 git target-only guard；automatic fix 前 target 必须是 tracked、clean、HEAD-backed rollback target。非目标 dirty worktree entries 会阻塞，workflow 不读取或持久化 non-target file content metadata；non-git、untracked target、dirty target、staged target 或 no-HEAD automatic fixing stops as `rollback-unavailable`。
- Fix lock lifecycle 由 `begin-fix`、`refresh-lock`、`end-fix` 和 `abort-fix` 闭合；long-running 或 delegated fix 不能绕过 60 秒 refresh rule，任何 stop point 都必须尝试释放 owner lock。
- Receipts 是 stop-point/audit/round>=2 的 deterministic audit artifact；reports 记录 phase normalized content，receipts 记录 why stopped/what next，二者不能互相替代。
- `SUMMARY.md` 和 `CONTINUITY.md` 都是 optional。Deterministic resume 不依赖它们；`SUMMARY.md` 由 command 从 state 派生，`CONTINUITY.md` 只提供 redacted human handoff。
- Project-local state 必须由真实 `review-and-fix` workflows 创建，而不是只出现在 tests 中。
- Claude Code 可以在满足相同 practical prerequisites 时使用 Practical Mode；缺少 subagent 时降级为 Advisory Mode，缺少 fingerprint guard 时 fail closed 为 fingerprint blocker，缺少 stdin handoff 时 fail closed 为 `unsafe-handoff-file`，这些 outcome 不等于 Claude Practical smoke complete。
- Gemini 保持 advisory-only；`review-and-fix` 通过 no-state preflight token 结束为 unsupported，不是 advisory downgrade。

## 26. Closed Questions

- Workflow commands 是 internal deterministic interface，不是 public user-facing review/fix CLI。
- Practical PASS 使用 `Status: pass` plus `Assurance: practical`，且只允许 persistent `review-and-fix` finalization。
- Strict verified assurance 需要 explicit `assurance=strict-verified` token、`drfx check` current-run descriptor path、platform 和 proof run id，并由 internal workflow command 重新验证为 `trusted` and `passCapable`。
- Blocked states 使用 `Status: blocked` plus `Blocking reason` 字段。
- Practical Mode 需要 live `DRFX_REVIEWER_READY` subagent probe、startup fingerprint probe 和 runtime stdin handoff probe；没有 exact subagent probe success 或 stdin handoff ready 不能写入 `Assurance: practical`，失败必须按固定 downgrade/blocker mapping 记录。
- Claude Code 满足 subagent delegation、fingerprint guard 和 stdin handoff 时可以使用 Practical Mode；缺少 subagent 时降级为 Advisory Mode，缺少 fingerprint guard 或 stdin handoff 时 fail closed。
- V2 使用 Markdown-only normalized reports；不添加 JSON sidecars。
- `downgraded` 是 triage decision，不是 ledger status；ledger 使用降级后的 severity 和现有 status enum。
- `reopened` 是 triage decision 和 ledger status；它只能引用既有 issue ID，并保留 original ID。
- `merged` 是 triage decision 和 ledger status；new duplicate finding 获得自己的 duplicate `issue_id`，ledger status 写 `merged`，`merged_into` 指向另一个既有 surviving issue。
- Lock refresh、abort 和 release behavior 已固定；fix phase 不允许在 active lock 状态下进入 diff review，也不允许在无法 refresh lock 的情况下委托实际 target writes。
- Receipts、`SUMMARY.md` 和 `CONTINUITY.md` 的职责已固定；resume phase selection 不依赖 optional continuity/summary prose。
- no-state `read-only` 不创建 `.docs-review-fix`，只允许 validation/normalization JSON output，并通过 latest canonical review/triage/preflight `stateToken` 让 finalizer 验证 terminal status。
- no-state `read-only` clean result 使用 `read-only-clean`，findings result 使用 `read-only-findings`。
- Generated routes 通过真实 stdin handle 把 semantic reports 交给 workflow commands；persistent state 不保存 raw target/reference bodies、raw prompts 或 raw semantic input。
- Automatic target writes require git rollback with a tracked, clean, HEAD-backed target; non-git、untracked target、dirty target、staged target 或 no-HEAD projects stop before fix with `rollback-unavailable`。
- Automatic target writes require a clean non-target worktree before fix; V2 does not hash or persist non-target file content metadata to prove dirty-file drift.
- Deterministic fixture tests 证明 workflow facade 和 state transitions；真实 model-backed route 需要 mandatory manual Codex Practical smoke，Claude Code smoke 则记录当前 runtime 下的 Practical success 或 fail-closed/advisory outcome。
