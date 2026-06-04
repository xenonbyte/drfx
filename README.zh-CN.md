[English](README.md) | 简体中文

# drfx

`@xenonbyte/drfx` 安装六条 review routes：四条 document routes（SPEC、PLAN、DESIGN、COMMON）和两条 code routes（`review-fix-pr` 用于 pull request diff，`review-fix-code` 用于 source scope review）。所有路由均支持 read-only review 或 review-and-fix loop。

## Requirements

- Node.js 20 或更新版本。
- 至少一个支持的平台：Claude Code、Codex 或 Gemini。
- 自动修复可使用 `guard=git` 搭配 tracked、clean、由 `HEAD` 支撑的目标文件，或使用 `guard=snapshot` 搭配 valid snapshot rollback anchor。

## Install

全局安装 package：

```bash
npm install -g @xenonbyte/drfx
```

检查 CLI：

```bash
drfx --help
drfx check
```

把 generated routes 安装到你使用的 agent platforms：

```bash
drfx install --platform claude,codex,gemini
drfx install --platform claude
drfx install --platform codex
drfx install --platform gemini
```

卸载 manifest-owned generated routes：

```bash
drfx uninstall --platform claude,codex,gemini
```

如果 uninstall 发现用户修改过的 generated files 或 Codex skill directory contents，它会保留这些文件，报告 `partially uninstalled: <platform> (... manifest retained)`，并保留一个缩窄后的 manifest。恢复或删除剩余文件后，可以再次运行 uninstall 移除剩余 package-owned files。

`drfx install --platform` 支持：

- `claude`: 安装 command files 到 `~/.claude/commands`。
- `codex`: 安装 generated skill directories 到 `~/.codex/skills/review-fix-*`。
- `gemini`: 安装 command TOML files 到 `~/.gemini/commands`。Gemini routes 仅支持 advisory read-only。

`drfx check` 报告本地 platform capability status。strict verified route 需要 same-flow capability proof 时，使用 `drfx check --platform <platform> --json`。

## Routes

安装后的 user-facing routes：

```text
review-fix-spec   SPEC documents
review-fix-plan   PLAN documents
review-fix-design DESIGN documents
review-fix-doc    COMMON documents
review-fix-pr     PR diff (base..HEAD file set)
review-fix-code   source scope file set
```

路由名选择 review target。Document routes：不要传 `type=`。Code routes（`review-fix-pr`、`review-fix-code`）：不要传 `target=`、`ref=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

## Quick Start

在 Codex 或 Claude Code 上 review 并自动修复 SPEC 文档：

```text
review-fix-spec docs/spec.md
```

Bare path 是 `target=<path>` 的简写。完整形式仍支持：

```text
review-fix-spec target=docs/spec.md
```

只 review、不编辑：

```text
review-fix-design docs/design.md read-only
```

带 reference documents review：

```text
review-fix-plan docs/plan.md ref=docs/spec.md ref=docs/design.md
```

运行 strict review-and-fix：

```text
review-fix-plan docs/plan.md review-and-fix strict guard=git
```

从 target-local workflow state 继续：

```text
review-fix-doc docs/notes.md read-only resume
```

打印 redacted workflow details 用于调试：

```text
review-fix-design docs/design.md debug
```

显式使用 practical assurance：

```text
review-fix-spec docs/spec.md review-and-fix assurance=practical guard=snapshot
```

使用 advisory read-only review：

```text
review-fix-design docs/design.md ref=docs/requirements.md read-only assurance=advisory
```

运行 document route 修复循环（最多 3 轮）：

```text
review-fix-plan docs/plan.md rounds=3
```

## Code Review Routes

Review pull request diff（本地 git，不 fetch）：

```text
review-fix-pr base=main
```

Review-and-fix PR diff，显式使用 snapshot guard：

```text
review-fix-pr base=main guard=snapshot
```

Read-only PR review：

```text
review-fix-pr base=main read-only
```

显式 PR resume：

```text
review-fix-pr base=main resume
```

PR review with repair loop（最多 2 轮）：

```text
review-fix-pr base=main rounds=2
```

Review 整个 project root（省略 `scope=` 表示全项目）：

```text
review-fix-code
```

Scoped code review（一个或多个根目录）：

```text
review-fix-code scope=lib scope=test
```

Read-only code review 单目录：

```text
review-fix-code scope=lib read-only
```

显式 snapshot guard code review：

```text
review-fix-code scope=lib guard=snapshot
```

显式 CODE resume：

```text
review-fix-code scope=lib resume
```

## Invocation Syntax

### Document routes (review-fix-spec / plan / design / doc)

Supported tokens:

- Bare `<path>` 是推荐 target 形式，等同于 `target=<path>`。
- `target=<path>` 是完整 target 形式。在 `review-and-fix` mode 中，这是 route 唯一可编辑的文件。
- `ref=<path>` 添加 read-only reference document。可重复传 `ref=`。
- `read-only` 只 review 和 triage，不编辑。
- `review-and-fix` 执行 review、triage、fix、diff review 和 full re-review。
- `normal` 使用默认 strictness。
- `strict` 让 low-severity findings 阻断，除非它们被显式接受为 non-blocking。
- `assurance=practical` 使用适合 Codex 和 Claude Code 常规自动修复的 live platform checks。
- `assurance=strict-verified` 要求 same-flow `drfx check --platform <platform> --json` proof。
- `assurance=advisory` 仅允许 read-only advisory review。
- `resume` 从 target-local state 继续。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `debug` 打印 redacted workflow audit details。默认输出保持 concise。
- `root=<path>` 设置用于 containment 和 state layout 的 project root。
- `ledger=<path>` 选择 target state directory 内的 custom issue ledger path。
- `guard=git|snapshot` 选择 rollback 和 target-only guard family。`guard=git` 是默认值；Git rollback anchor 不可用时，`guard=snapshot` 使用 file snapshots。路由永远不会静默切换 guard mode。

### review-fix-pr

Syntax:

```text
review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<path>] [debug]
```

- `base=<branch>` 为必填。diff 为 `base..HEAD`，使用本地 git 解析，no fetch、push 或 ref mutation。
- `read-only` 或 `review-and-fix`（Claude Code 和 Codex 默认 `review-and-fix`；Gemini 上为 advisory read-only）。
- `guard=git` 为默认值；Git rollback anchor 不可用时使用 `guard=snapshot`。路由永远不会静默切换 guard mode。
- `resume` 显式从已保存的 state 继续。拒绝 stale state，不存在静默复用。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `root=<path>` 设置 project root。
- 不接受 `target=`、`ref=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

### review-fix-code

Syntax:

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume] [rounds=<n>] [root=<path>] [debug]
```

- `scope=<path>` 指定要 review 的 source root（repeatable，可重复传入多个 `scope=`）。省略 scope 表示整个 project root。
- 强制排除：`.git`、`.docs-review-fix`、`node_modules`、build outputs 及类似 infrastructure 目录始终排除在 reviewed file set 之外。
- `read-only` 或 `review-and-fix`（Claude Code 和 Codex 默认 `review-and-fix`；Gemini 上为 advisory read-only）。
- `guard=git` 为默认值；Git rollback anchor 不可用时使用 `guard=snapshot`。路由永远不会静默切换 guard mode。
- `resume` 显式从已保存的 state 继续。拒绝 stale state，不存在静默复用。
- `rounds=<n>` 设置最大修复循环次数（正整数）。与 `read-only` 不兼容。
- `root=<path>` 设置 project root。
- 不接受 `target=`、`ref=`、`base=`、`strict`、`normal`、`assurance=` 或 `ledger=`。

`guard=snapshot` monitoring details:

- 它监控 target、显式 `ref=` documents、普通 project files，以及无关 file symlinks（作为 opaque entries）。
- 常见 infrastructure directories（`.git`、`node_modules`、`.pnpm-store`、`.yarn`、`.cache`、`dist`、`build`、`coverage`）默认排除在监控范围之外，除非 target 或 reference 位于其中。
- 若有目录被排除，guard 报告 `monitorScope: project-tree-files-and-references-excluding-infrastructure`。
- Directory symlinks 不被支持，会阻断 guard。
- Opaque file-symlink entries 通过 symlink metadata 和 `readlink` target text 检测变化，但无法检测通过 symlink 写入其 resolved target 的修改。

Parsing 是 strict 的：

- 允许单个 unlabeled target path。
- 如果使用 `target=`，unlabeled paths 会被拒绝。
- Duplicate `target=` 和 duplicate `root=` 会被拒绝。
- Unknown `key=value` tokens 和 unknown dash options 会被拒绝。
- 含空格的 paths 必须作为一个 shell-quoted token 传入。
- Natural-language input 只有在 target 和 reference roles 明确时才被接受。

对 valid target invocations，Codex 和 Claude Code routes 会把缺失的 mode 默认为 `review-and-fix`，把缺失的 assurance 默认为 `practical`。显式 `assurance=advisory` 且未传 mode 时，在 Codex 和 Claude Code 上选择 `read-only`。Gemini routes 默认缺失 mode 为 `read-only`，缺失 assurance 为 `advisory`。

Help-style 或 invalid invocations 只解释用法，不得读取文件、运行 `drfx workflow`、创建 state、运行 probes，或声明 review results。

## Modes

`read-only`:

- 读取 target 和 references。
- 运行 semantic review 和 triage。
- 不编辑文件。
- 报告 `Clean:` 或 `Issues:`。

`review-and-fix`:

- 读取 target 和 references。
- 运行 review、triage、fix、diff review 和 full re-review。
- 只编辑 target document。
- 有修改时报告 `Fixed:`。
- accepted issues 仍存在时报告 `Unfixed:`。

Gemini 支持 advisory read-only review。Gemini 不支持 `review-and-fix` 或 `assurance=strict-verified`。

Code routes（`review-fix-pr`、`review-fix-code`）在 Gemini 上为 advisory-only：`review-and-fix` 不支持，`rounds=<n>` 不接受，workflow PASS 不可用，自动修复永远不会运行。如需 code route 自动修复，请使用 Claude Code 或 Codex。

`read-only` 路径在任何平台上都不声明 PASS，也不创建 auto-fix state。

## Output

默认输出设计为简短，并且方便另一个 AI agent 使用。

Clean read-only review:

```text
Clean: docs/spec.md has no blocking issues.
```

Read-only review with findings:

```text
Issues:
- Location: docs/spec.md:42
  Problem: The acceptance criteria do not define the empty-state behavior.
  Why it matters: Implementers can ship incompatible behavior.
  Suggested fix: Add explicit empty-state acceptance criteria.
Next: Apply fixes manually or rerun on Codex/Claude Code in review-and-fix mode.
```

Successful review-and-fix:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Files changed:
- docs/spec.md
```

Review-and-fix with remaining issues:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Unfixed:
- Location: docs/spec.md:88
  Problem: The rollout owner is still unspecified.
  Next: Add the accountable owner or defer with reason, owner, and next action.
Files changed:
- docs/spec.md
```

目标缺少 rollback anchor 时的 blocked run:

```text
Blocked: docs/spec.md cannot be auto-fixed because it lacks a clean rollback anchor.
Next: Commit or restore the target, rerun with read-only, or use guard=snapshot when Git rollback is unavailable.
```

其他 guard blockers 使用不同 wording：`target-only-guard-unavailable` 表示 target-only guard 不可用或无法解析；`unexpected-worktree-change` 表示 non-target worktree changes 让自动修复不安全。

`debug` 可能包含 redacted state paths、blocker codes、runtime probe status 和 workflow audit details。它不得打印 raw target bodies、raw prompts、subagent transcripts、secrets 或 unredacted sensitive logs。

## Review Rules

### Document routes

所有 document routes 先应用 COMMON rubric。Specialized routes 会额外添加一个 type-specific rubric：

- `review-fix-spec`: COMMON plus SPEC。
- `review-fix-plan`: COMMON plus PLAN。
- `review-fix-design`: COMMON plus DESIGN。
- `review-fix-doc`: COMMON only。

Built-in rubrics:

- COMMON: purpose、coherence、actionability、assumptions、constraints、risks、project alignment、terminology、placeholders 和 external facts。
- SPEC: requirements、product behavior、API behavior、scope、actors、permissions、integrations、acceptance criteria、edge cases 和 verifiability。
- PLAN: implementation steps、prerequisites、tooling、verification、rollback、failure handling、data safety、compatibility 和 handoff readiness。
- DESIGN: UX、UI、product workflows、system or architecture design、states、transitions、contracts、data flow、accessibility、responsiveness、localization、constraints 和 risks。

### Code routes

Code routes（`review-fix-pr`、`review-fix-code`）使用自包含的 rubric，没有 COMMON layer：

- `review-fix-pr`：correctness、regression、safety、tests、contracts、maintainability 和 platform。
- `review-fix-code`：correctness、architecture、state-and-io、safety、tests、contracts、maintainability 和 platform。

Code review 只对 actionable 问题报告：纯 style 偏好、无风险 refactor 和 over-abstraction 意见不属于 blocking findings。

### Reference Conformance

`ref=` documents 是 consistency sources，不是 mandatory upstream chains。

- SPEC 不要求 DESIGN reference。
- PLAN 不要求 SPEC reference。
- `Design Coverage Import` 是 optional，除非 SPEC 声称完整覆盖 reference、custom rules 要求它，或缺失会导致 SPEC 不可验证。
- `SPEC-to-task mapping` 是 optional，除非 PLAN 声称完整覆盖 reference、custom rules 要求它，或缺失会让 PLAN 不安全或不可验证。
- 缺少 trace tables、stable IDs 或 coverage tables 默认不是 blocking。

Blocking reference findings 包括 conflicts、被描述为 reference-backed 的 unsupported new requirements、target 既定目的所需但遗漏的 reference constraints，或会违反 reference 的 execution steps。

Reviewer findings 包含足够 triage 的细节：severity、location、problem、why it matters、suggested fix、confidence，以及相关 sensitive-content metadata。

## Custom Rules

Supported V3 custom rule files:

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
~/.docs-review-fix/rules/PLAN.md
~/.docs-review-fix/rules/DESIGN.md
~/.docs-review-fix/rules/PR.md
~/.docs-review-fix/rules/CODE.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/DESIGN.md
.docs-review-fix/rules/PR.md
.docs-review-fix/rules/CODE.md
```

每个 custom rule file 都是 plain Markdown fragment。不需要包一层 heading。

对 typed review，loader 只读取 user-global 和 project-local rules 中的 `COMMON.md` 加当前 document type 文件。`SPEC` review 不读取 `PLAN.md` 或 `DESIGN.md`；`PLAN` review 不读取 `SPEC.md` 或 `DESIGN.md`；`DESIGN` review 不读取 `SPEC.md` 或 `PLAN.md`；COMMON document review 只读取 `COMMON.md`。

Code routes（`review-fix-pr`、`review-fix-code`）没有 COMMON layer。`PR` review 只读取 `PR.md`；`CODE` review 只读取 `CODE.md`。Code routes 的 user-global 和 project-local rule files 遵循与 document routes 相同的两层布局。

Legacy `RULE.md` 是 stale configuration。如果存在 `~/.docs-review-fix/RULE.md` 或 `.docs-review-fix/RULE.md`，workflow start 会在写入 target state 前以 `state-validation-failed` 阻断。

Unknown Markdown files under `rules/`，例如 `Spec.md`、`SPEC-RULE.md` 或 `REQUIREMENTS.md`，会在 normal mode 下输出 warning 并继续。在 strict mode 下，它们会在 target state 写入前阻断。

Rule precedence（document routes）：

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global COMMON rules
5. user-global document-type rules
6. project-local COMMON rules
7. project-local document-type rules

Rule precedence（code routes — 无 COMMON layer）：

1. workflow hard constraints
2. built-in code-route rubric（PR 或 CODE）
3. user-global PR.md 或 CODE.md rules
4. project-local PR.md 或 CODE.md rules

Project-local rules 比 user-global rules 更具体。Custom rules 不能覆盖 workflow hard constraints。

## State and Resume

Persistent state 是 target-local：

```text
.docs-review-fix/targets/<target-key>/
```

Target key 由相对 project root 的 normalized target path 派生：一个 readable slug 加 12-character SHA-256 prefix。它基于 path，不基于 content。

Project-local layout:

```text
.docs-review-fix/
  rules/
    COMMON.md
    SPEC.md
    PLAN.md
    DESIGN.md
  index.md
  targets/
```

`rules/` 是 shared project configuration。`index.md` 存在时是 project-level index material。`targets/<target-key>/` 是 single-target workflow state。

Default target state layout:

```text
.docs-review-fix/targets/<target-key>/
  MANIFEST.md
  ISSUES.md
  CONTINUITY.md
  SUMMARY.md
  LOCK/
    lease.json
  stale-locks/
  rounds/
```

`MANIFEST.md` 记录 target path、document type、strictness、mode、target key、ledger path、status、current round、file fingerprints、references 和 timestamps。

默认 ledger 是 `.docs-review-fix/targets/<target-key>/ISSUES.md`。Custom `ledger=` path 必须留在 target directory 内，并且不能指向 reserved paths，例如 `LOCK/`、`stale-locks/`、`rounds/`、`MANIFEST.md`、`CONTINUITY.md` 或 `SUMMARY.md`。

`resume` 使用 target-local files，不使用 chat history。Resume 没有 runtime objective/session/platform memory dependency。Resume 会派生 target key，读取 `MANIFEST.md`，读取 ledger，在存在时加载 `CONTINUITY.md`，重建当前 merged rules，检查 fingerprints，并且只在 state 仍有效时继续。

## Write Safety

Reference documents 是 read-only。Fixes 必须只修改 target document。

Automatic target writes 要求：

- `review-and-fix` mode；
- 使用 `guard=git` 时，需要 Git worktree `HEAD` 加 tracked clean target；或使用 `guard=snapshot` 时，需要 valid snapshot rollback anchor；
- target-only guard 能证明 writes 在所选 guard mode 下保持 target-only；
- 没有 unsafe non-target changes 会让所选 guard mode 的 guard results 变得 ambiguous。

Fix 之前，route 会锁定 target state directory，并重新检查 target fingerprint。Concurrent edits、external changes、stale unsafe locks 或 possible target replacement 都会在写入被信任前停止 workflow。

Sensitive values 不得打印或存入 ledgers、receipts、manifests、summaries、prompts 或 final responses。使用 `[REDACTED:<kind>]`，例如 `[REDACTED:api-token]`、`[REDACTED:private-key]`、`[REDACTED:cookie]` 或 `[REDACTED:credential]`。

对 sensitive findings，保存 location anchors 和 secret kind，不保存 raw values、partial prefixes、suffixes、hashes、checksums、raw logs 或 transcript excerpts。

## Troubleshooting

`Blocked: target or worktree is not write-eligible.`

Commit 或 restore target document，然后解决 unsafe non-target worktree changes。等 `git status --short` 显示 target clean，且剩余 worktree state 对 target-only guard 安全后再重跑。

Guard blocker wording:

- `rollback-unavailable`: target 缺少 clean rollback anchor。Commit 或 restore target，重跑 read-only，或在 Git rollback 不可用时使用 `guard=snapshot`。
- `target-only-guard-unavailable`: target-only guard 不可用或无法解析。恢复 guard inputs，或在 guard data 可读取后重跑。
- `unexpected-worktree-change`: non-target worktree changes 让自动修复不安全。Commit、stash 或 restore unrelated changes 后重试。

`Blocked: state-validation-failed.`

移除 stale `RULE.md` files。`.docs-review-fix/rules/` 和 `~/.docs-review-fix/rules/` 下的 unknown Markdown files 在 normal mode 下 warning，但会阻断 strict runs。

`Unsupported: review-and-fix or strict-verified is unavailable on Gemini.`

使用 Gemini 进行 advisory read-only review，或使用 Codex/Claude Code 自动修复。对于 code routes（`review-fix-pr`、`review-fix-code`），Gemini 在所有平台上均为 advisory-only：`review-and-fix` 不支持，workflow PASS 不可用，不会编辑任何文件。如需 code route 自动修复，请使用 Claude Code 或 Codex。

`Unfixed:` appears after review-and-fix.

Route 已安全修复可修复项，并正在报告仍然存在的 accepted issues。Deferrals 包含 reason、owner 和 next action。

`resume` refuses to continue.

Target state 不再匹配当前 file fingerprints、target path、references、rules 或 lock state。解决报告的 blocker 后，开始 fresh run。
