[English](README.md) | 简体中文

# document-review-fix

`@xenonbyte/document-review-fix` 为 SPEC、PLAN、DESIGN 和 COMMON Markdown 文档安装 review routes。路由可以执行 read-only review，也可以执行只修改目标文档的 review-and-fix loop。

## Requirements

- Node.js 20 或更新版本。
- 至少一个支持的平台：Claude Code、Codex 或 Gemini。
- 自动修复要求目标文档位于 Git worktree 内，并且是 tracked、clean、由 `HEAD` 支撑的文件；也可在适合时使用 `guard=snapshot`。

## Install

```bash
npm install -g @xenonbyte/document-review-fix
drfx --help
drfx check
drfx install --platform claude,codex,gemini
```

`drfx install --platform` 支持：

- `claude`: 安装到 `~/.claude/commands`。
- `codex`: 安装到 `~/.codex/skills/review-fix-*`。
- `gemini`: 安装到 `~/.gemini/commands`。Gemini routes 仅支持 advisory read-only。

## Routes

```text
review-fix-spec   SPEC documents
review-fix-plan   PLAN documents
review-fix-design DESIGN documents
review-fix-doc    COMMON documents
```

路由名固定 document type。不要传 `type=`。

## Quick Start

```text
review-fix-spec docs/spec.md
```

Bare path 是 `target=<path>` 的简写，完整形式仍支持：

```text
review-fix-spec target=docs/spec.md
```

更多示例：

```text
review-fix-design docs/design.md read-only
review-fix-plan docs/plan.md ref=docs/spec.md ref=docs/design.md
review-fix-plan docs/plan.md review-and-fix strict guard=git
review-fix-spec docs/spec.md review-and-fix assurance=practical guard=snapshot
review-fix-doc docs/notes.md read-only resume
```

## Invocation Syntax

- Bare `<path>` 是推荐 target 形式，等同于 `target=<path>`。
- `target=<path>` 是完整 target 形式。
- `ref=<path>` 添加 read-only reference document，可重复。
- `read-only` 只 review 和 triage，不编辑。
- `review-and-fix` 执行 review、triage、fix、diff review 和 full re-review。
- `normal` 使用默认 strictness。
- `strict` 让 low findings 阻断，除非显式接受为 non-blocking。
- `assurance=practical|strict-verified|advisory` 选择 runtime assurance。
- `guard=git|snapshot` 选择 rollback 和 target-only guard family。
- `resume` 从 target-local state 继续。
- `debug` 打印 redacted workflow audit details。
- `root=<path>` 设置 project root。
- `ledger=<path>` 设置 target state 目录内的 issue ledger。

Codex 和 Claude Code 对有效 target invocation 默认使用 `review-and-fix assurance=practical`。`assurance=advisory` 且未显式传 mode 时选择 `read-only`。Gemini 默认 `read-only assurance=advisory`。

## Output

默认输出保持简短，不打印 raw workflow JSON、prompt text、subagent transcripts、internal issue IDs 或 final-response machine block。

Guard blocker wording：

- `rollback-unavailable`: target 缺少 clean rollback anchor。
- `target-only-guard-unavailable`: target-only guard 不可用或无法解析。
- `unexpected-worktree-change`: non-target worktree changes 让自动修复不安全。

## Review Rules

所有路由先应用 COMMON rubric，再应用类型 rubric：

- `review-fix-spec`: COMMON plus SPEC。
- `review-fix-plan`: COMMON plus PLAN。
- `review-fix-design`: COMMON plus DESIGN。
- `review-fix-doc`: COMMON only。

### Reference Conformance

`ref=` documents 是 consistency sources，不是 mandatory upstream chains。SPEC 不要求 DESIGN reference，PLAN 不要求 SPEC reference。`Design Coverage Import` 和 `SPEC-to-task mapping` 只有在 target 声称完整覆盖、custom rules 要求、或缺失会导致目标文档不可验证时才阻断。

## Custom Rules

支持的 custom rule files：

```text
~/.docs-review-fix/rules/COMMON.md
~/.docs-review-fix/rules/SPEC.md
~/.docs-review-fix/rules/PLAN.md
~/.docs-review-fix/rules/DESIGN.md
.docs-review-fix/rules/COMMON.md
.docs-review-fix/rules/SPEC.md
.docs-review-fix/rules/PLAN.md
.docs-review-fix/rules/DESIGN.md
```

Typed review 只读取 `COMMON.md` 加当前 document type 文件。Unknown Markdown files under `rules/` 在 normal mode 下输出 warning 并继续；在 strict mode 下会在 target state 写入前阻断。Legacy `RULE.md` 是 stale configuration，会阻断 workflow start。

## State and Resume

Persistent state 是 target-local：

```text
.docs-review-fix/targets/<target-key>/
```

`resume` 使用 target-local files，不依赖 chat history 或 runtime memory。

## Write Safety

Reference documents 是 read-only。Fixes 只能修改 target document。自动写入需要 clean rollback anchor、可用 target-only guard，以及不会让 guard 变得 ambiguous 的 worktree 状态。

## Troubleshooting

- `rollback-unavailable`: commit/restore target，改用 read-only，或在 Git rollback 不可用时使用 `guard=snapshot`。
- `target-only-guard-unavailable`: 恢复 guard inputs，或在 guard data 可读取后重试。
- `unexpected-worktree-change`: commit、stash 或 restore unrelated changes 后重试。
- `state-validation-failed`: 移除 stale `RULE.md`；strict runs 还需要移除 unknown Markdown files under `rules/`。
- Gemini 不支持 `review-and-fix` 或 `assurance=strict-verified`，请用 Codex/Claude Code 自动修复。
