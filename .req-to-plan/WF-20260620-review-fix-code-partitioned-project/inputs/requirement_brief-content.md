# Requirement Brief

## Goal
`review-fix-code` must auto review **and** fix an entire project's code, looping to convergence, without being forced to manually split by directory (`scope=`) because of the whole-root size cap. When whole-root exceeds the honest single-pass budget it enters `reviewMode:'partitioned'`: the CLI does only deterministic work (inventory, whole-file byte bin-packing, fingerprint, guard, cache); the model reviews per unit with bounded body + on-demand small-contract reads and emits evidence-backed findings plus a coverage receipt; an aggregator merges, re-reads high-severity findings, proves coverage, and PASS is earned by a gate. Project size becomes unbounded, each single model call stays bounded, and PASS stays provable. This is the earned-PASS mode (isolated read-only reviewer → guarded fix → independent re-review → loop), not advisory edit-as-you-read.

## In-Scope
- SCOPE-IN-001 Whole-root over the single-pass budget enters `reviewMode:'partitioned'` instead of the hard `file-set-too-large` block; the file-count cap becomes one trigger, not a footgun.
- SCOPE-IN-002 Deterministic CLI inventory + whole-file byte bin-packing that never splits a file, plus `projectReviewFingerprint`, file-set guard, and per-unit review cache.
- SCOPE-IN-003 On-demand contract reads: deterministic `require()/import` regex lists a unit's in-root dependencies as read-only references, fetched within `CONTRACT_READ_BUDGET`.
- SCOPE-IN-004 Bounded per-unit reviewer producing evidence-backed findings plus a coverage receipt with `coverage_risk` fixed to `none|high`; cross-module disciplines written as locally-checkable rules.
- SCOPE-IN-005 Aggregate-review (dedup, coverage proof, forced high-severity re-read) wired into the existing triage → fix → diff-review → full-re-review loop, fix bounded to the in-set file union.
- SCOPE-IN-006 Earned-PASS gate: PASS only when every high-risk unit is body-reviewed, findings triaged, no open high/medium, and all units `coverage_risk=none`; otherwise `stopped-with-deferrals` + new `coverage-incomplete` reason.
- SCOPE-IN-007 New persistent `project-review/` state mounted under a valid CODE target manifest using existing `checkpoint` status, honoring reset/archive/resume/stale-state; one-shot `read-only --no-state` returns a no-state plan and never writes `.drfx/targets/`.
- SCOPE-IN-008 Delivered as three independently-mergeable phases (partition plan → bounded read-only unit review → aggregate + fix + earned PASS).

## Out-of-Scope
- SCOPE-OUT-001 Changing the single-shot or scoped paths; under-cap and explicit `scope=` behavior stays byte-identical.
- SCOPE-OUT-002 tree-sitter / AST / import-graph / LSP semantic parsing or any dependency-graph construction.
- SCOPE-OUT-003 Changing the `hashFileContent` sha256 identity namespace or introducing git blob OID; zero fingerprint migration (streaming only guards against single-file OOM).
- SCOPE-OUT-004 Changing the `reviewer-pass-fail` or `fix-report` schemas; coverage rides a separate additive `unit-review-report`.
- SCOPE-OUT-005 A summary-first-primary cross-cutting pass; it exists only as a backstop that must end in `coverage_risk:high` (non-PASS) when unconfirmed.
- SCOPE-OUT-006 Intra-file chunked review; a single file over `MAX_UNIT_BYTES` becomes a coverage blocker, never split-and-stitched.
- SCOPE-OUT-007 Changing the fix-attempt cap (`MAX_FIX_ATTEMPTS = 5`, per-file-set) or `rounds=` semantics; partition restructures only review, not the fix count/convergence.
- SCOPE-OUT-008 Raising or removing the byte cap to allow a larger single-shot review.

## Non-Goals
- Increasing the per-call single-pass context budget (the bound is deliberately preserved; only the project-total block is removed).
- Producing an unprovable "I reviewed the whole project" PASS — that violates the project's "PASS is earned, never assumed" rule.
- Adding any new runtime/package dependency; the feature uses Node built-ins + git + simple regex only.
- Turning `review-fix-code` into an advisory edit-as-you-read flow.

## Assumptions
- ASMP-001 `MAX_UNIT_BYTES` (1,000,000) + `CONTRACT_READ_BUDGET` (500,000) = 1,500,000 is a faithful single reviewer-pass budget, aligned to the current `MAX_WHOLE_ROOT_BYTES`.
- ASMP-002 Cross-module contracts concentrate in a small spine of small files reachable via `require()/import` regex (L2 finding); most invariants are intra-file.
- ASMP-003 Whole-file bin-packing keeps each file intact inside one unit, so intra-file invariants are never cut across units.
- ASMP-004 Existing read-only `references` plus merged-rules injection are a sufficient cross-module net; no new mechanism is required.
- ASMP-005 Per the L1 measurement, partition is needed only when one call must cover src+tests and auto-fix to convergence; pure source review can still be solved by exclusion/`scope=`.

## Acceptance Criteria
- AC-001 Whole-root over cap no longer hard-blocks; it returns a partitioned plan with an inventory and whole-file unit bins (Phase 1).
- AC-002 `partitionInventory` is deterministic and never splits a file; a single file > `MAX_UNIT_BYTES` yields a single-member `oversize_file:true` unit, not a hard cut.
- AC-003 Unit review context contains only that unit's files plus suggested refs (asserted: no out-of-set leakage); a coverage receipt is recorded per unit (Phase 2).
- AC-004 Cache skip requires member + `suggestedRefs` + `extraReads` fingerprints all unchanged; editing a contract file forces re-review of every unit that read it.
- AC-005 Aggregate emits a coverage proof and forced high-severity re-read; PASS only when the gate is satisfied, else `stopped-with-deferrals` + `coverage-incomplete` (Phase 3).
- AC-006 An oversize-file fixture provably never yields a false clean or false PASS.
- AC-007 Fix stays inside the in-set union; `fixAttemptCount` stays per-file-set, cap stays 5, `rounds=` stays project-level — all unchanged.
- AC-008 `npm run syntaxcheck` + `npm test` are green each phase; the `coverage-incomplete` enum is consistent across `workflow-state.js`, `semantic-parsers.js`, `final-response.js`, `shared/core.md`, and generated CODE routes + fixtures.

## Open Questions
- OQ-001 (non-blocking, owner: implementer at Phase 2) The two tunable constants `MAX_UNIT_BYTES` and `CONTRACT_READ_BUDGET` carry verified initial values; Phase 2 may calibrate the numbers against the first real large target but must not change structure. No design decision remains open — §8 residual risks are accepted and deformed to honest non-PASS, §9 values are calibration-only.

## Sources
- `design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` — the full validated plan (north star §0/§2.3, building/not-building §3, key decisions §4, persistence §5, three-phase plan §6, residual risk §8, tunables §9).
- `design/DESIGN-v3.md` — current baseline design (pass).
- Code evidence: `lib/target-context.js:274-276` (cap + "Tunable constants, not load-bearing" comment), `:600-609` (uncapped `walkDirectory`), `:617-620` (`hashFileContent`), `:249-258` (`computeFileSetFingerprint` identity projection), `:30` (git read-only allowlist); `lib/context-pack.js:12` (`CONTENT_POLICY='read-in-memory-only'`); `shared/prompts/coordinator.md:24,67,87` (single reviewer reviews the entire file set; CLI validates only deterministic contracts); `lib/workflow/fix-lifecycle.js:51` and `lib/workflow/file-set-fix.js:56` (`MAX_FIX_ATTEMPTS = 5`).
- Codex `/review` partitioned reviewer pattern (inspiration for per-unit bounded review, not copied implementation).

## Trace
| This ID | Upstream | Status |
|---|---|---|
| SCOPE-IN-001 | plan §1 现状勘察, §4.2 decision 2 | Phase 1 |
| SCOPE-IN-002 | plan §4.2 decision 1, §5 inventory/units | Phase 1 |
| SCOPE-IN-003 | plan §4.2 decision 4, §4.1 references net | Phase 2 |
| SCOPE-IN-004 | plan §4.2 decision 3, §5 unit-review-report | Phase 2 |
| SCOPE-IN-005 | plan §6 Phase 3 aggregate + fix integration | Phase 3 |
| SCOPE-IN-006 | plan §4.2 decision 5, §6 Phase 3 gate | Phase 3 |
| SCOPE-IN-007 | plan §5 project-review state, §6 Phase 1 checkpoint | Phase 1-2 |
| SCOPE-IN-008 | plan §6 (three independently-mergeable phases) | Phases 1-3 |

## Upstream Summary (read-only)
# 优化方案 — `review-fix-code` 解除全项目体量限制(partitioned project review)

- 日期：2026-06-20
- 范围：`lib/target-context.js`、`lib/context-pack.js`、`lib/workflow-state.js`、`lib/semantic-parsers.js`、`lib/final-response.js`、`lib/workflow/*`、`lib/project-review.js`(新)、`bin/drfx.js`、`shared/core.md`、`shared/rubrics/code.md`、`shared/prompts/{reviewer,coordinator}.md`、`lib/generator.js`、`templates/fragments/route-contract.code.*`、`test/`
- 目标读者：包维护者 / 后续实现该计划的工程师或 agent
- 当前版本：`0.6.4`
- 当前基线设计：`design/DESIGN-v3.md`（pass）
- 状态：**已通过两轮验证（L1 体量、L2 跨模块漏检），方案已据验证结果重塑**；核心诉求(北极星)已记入 §0/§2.3；fix-attempt cap 与 `rounds=` **保持现状不变**（per-file-set，见 §4 决策 7）；**全部决策已定、无未决项**（§9 为可调初值，§8 为已接受残余风险）；待批准实现

---

## 0. TL;DR

**核心诉求(北极星)**：`review-fix-code` 这个技能应当能**自动 review + fix 一个项目的全部代码，循环直到没有问题(收敛)才结束**——而不是因体量上限被迫**按目录手动拆**多次跑。本方案的全部设计都服务于这一条。

`review-fix-code` 想支持"整个项目、无总大小限制、且质量可证明"，正解**不是**把 `MAX_WHOLE_ROOT_BYTES`（当前 1.5MB）调大或取消，而是：whole-root 超出单次诚实预算时进入 `reviewMode:'partitioned'`——CLI 只做 inventory / **whole-file 字节分桶** / 指纹 / guard / 缓存；model 按 review unit 读有限正文、**按需拉取少数小契约文件**、产出 evidence-backed findings + coverage receipt；aggregator 合并、复核高严重、出覆盖证明，PASS 由 gate 赚取。项目体量无上限，单次 model 调用始终有界，PASS 可证明。

本方案与"直接扩大 cap"的根本区别：保留"单次 review unit 的上下文上限"，只取消"项目总大小阻塞"。

---

## 1. 现状勘察（已核实）

| 项 | 现状 | 证据 |
|---|---|---|
| whole-root 硬上限 | 300 文件 / 1,500,000 bytes，超出 `file-set-too-large` 硬阻塞 | `lib/target-context.js:275-276,724-729`；`describeCodeBlock` `:851` |
| 上限定性 | 注释明确 `Tunable constants, not load-bearing`（调参旋钮，非正确性不变量） | `lib/target-context.js:274` |
| cap 计数时机 | 在所有排除（built-in dirs + `.drfxignore` + git version-ignore）之后 | `walkDirectory` `:600-609` |
| 每文件身份 | `hashFileContent` 整文件 `readFileSync` 后 sha256 | `lib/target-context.js:617-620` |
| context pack 内容 | 只存骨架（file list / scope / ignore / rules），不存正文（`CONTENT_POLICY='read-in-memory-only'`） | `lib/context-pack.js:12` |
| 实际审查方式 | 一个**隔离 read-only reviewer subagent** 一次性审查"**the entire resolved file set**" | `shared/prompts/coordinator.md:24,67` |
| CLI 职责边界 | "the CLI only validates deterministic contracts"——语义判断全留给 model | `shared/prompts/coordinator.md:87` |
| 遍历能力 | `walkDirectory(wholeRootStats=null)` 不计数、不早停；scoped CODE 已走此无上限路径 | `lib/target-context.js:600,691-693` |

**真实瓶颈**：CLI 不持久化正文，但单个 reviewer 在一次语义审查中会装入整套文件正文。1.5MB cap 是在保护 workflow 不要假装完成了不可证明的"全项目审查"。这一诊断成立。

---

## 2. 验证结论（本方案的核心，先验证后改方案）

### 2.1 L1 — 体量假设：本仓库**不需要** partition（用排除/scope 即可）

对本仓库 whole-root CODE 审查实测（tracked == 全部源码，工作树干净）：

| 配置 | bytes | files | 对 cap（300 / 1.5MB） |
|---|---|---|---|
| 无 `.drfxignore` | 3,072,128 | 168 | **byte cap 超 2.05×**；file cap 不触发 → **blocked** |
| 其中 `test/` | 2,102,656 | 76 | — | 撑爆 cap 的唯一驱动 |
| 有 `.drfxignore`（有效排除=仅 `test/`） | 969,472 | 92 | **两项都过** → single-shot 可用 |

`test/` 内部：`test/fixtures (other)` 975,195 / 23；`test/*.test.js` 803,704 / 35；`test/fixtures/generated` 323,757 / 18。

关键事实：
1. `docs/`、`design/`、`.codegraph` 已被 `.gitignore`，CODE review 经 version-ignore 自动排除；`.drfxignore` 里它们冗余，**唯一有效排除是 `test/`**。
2. **300-file cap 从未触发**；真正卡住的只有 byte cap，且**仅因把 2MB 测试套件算进去**。
3. 本仓库当前已运行在"通过"档（`.drfxignore` 排除 `test/` 后 0.97MB），whole-root review 今天即可工作。

**L1 推论**：对单包项目，1.5MB 的"排除后非测试源码"已属偏大；cap 多半因 tests/fixtures 被计入而触发，而那应由排除/scope 解决。**partition 仅在一种情形下才被需要**（见 2.3）。

### 2.2 L2 — 质量假设：跨模块漏检风险**真实**，但契约集中在极少数小文件

(a) 确认存在"运行时不报错、分单元会漏、只有 review 兜底"的跨模块不变量：

| 不变量 | 证据 | 运行时兜底 | 分单元会漏 |
|---|---|---|---|
| redaction-everywhere（每个落盘点必须 `redactSensitive`） | 22 调用点散在 9 文件，无中央强制 | 否（漏写=静默泄密） | 会，除非 reviewer 知道该纪律 |
| identity-field-coverage（`computeFileSetFingerprint` 只投影 `{path,status,contentId}`，member 新增影响身份字段却漏加 → drift 静默漏检） | `lib/target-context.js:249-258` | 否 | 取决于构造点/投影是否同 unit |
| git read-only allowlist（新 git 调用须进白名单） | `lib/target-context.js:30` | 部分（越界报错） | 多为同文件，风险低 |

(b) 结构发现（决定设计）：契约集中在一个小 "spine"，且每个 spine 文件都小到能塞进一个 unit——`workflow-state.js` 32KB、`target-context.js` 41KB、`redaction.js` 3.4KB、`manifest.js` 28KB、`semantic-parsers.js` 19KB。因此：
- **大多数不变量是 intra-file 的** → 只要**绝不把单个文件拆到两个 unit**，这类不会被切断。
- **跨 file 耦合只指向少数小契约文件** → unit reviewer **按需拉取**它依赖的那个小文件即可对照，无需"summary-first 猜测 + 复读"。

**L2 推论（推翻上一版最脆弱部分）**：对契约类，不必靠脆弱的"cross-cutting 吃 summary 抓跨模块 bug"（会撞回字节上限、summary 可能丢信号）。更强且更简单的主力机制 = **whole-file 分桶 + 把纪律写成可本地核查的规则 + 按需拉取小契约文件**。summary-first cross-cutting **降级为兜底**，仅处理"无契约文件可依、纯涌现性"的少数属性，且必须以 `coverage_risk:high`=非 PASS 收场，绝不静默 PASS。

### 2.3 北极星需求（operator 原话，本方案的目标）

> `review-fix-code` 应能**自动 review + fix 一个项目的全部代码，循环直到没有问题(收敛)才结束**；当前因体量上限，项目过大就只能**按目录手动 `scope=` 拆**多次跑——本方案要免去这个手动拆分，让一条 whole-root 调用内部自动分片并跑完整收敛循环。

技术等价表述：需要对**整棵树（含测试在内、排除后仍 >1.5MB）在一条调用里跑自动 review-fix 到收敛，并给统一的、可证明覆盖的 verdict**。

边界澄清（与 advisory 区分）：这里要的是 drfx 那套"read-only reviewer 发现 → 守卫下 fix → 独立复审 → 循环到收敛"的**可证明 PASS** 模式，**不是**"同一 agent 随手边读边改"的 advisory 模式（后者拿不到 earned PASS）。

什么时候用不到 partition：
- "review 项目"=只审源码 → 排除/scope 掉 test，single-shot 即可，**无需 partition**。
- 必须一条调用覆盖 src+test 并自动修到收敛 → single-shot 做不到，`scope=` 拆多次跑**丢失统一收敛与覆盖证明** → 这是 partition 唯一真正解决的东西。

本方案在此前提下成立。

---

## 3. 方案边界（Building / Not building）

### Building
whole-root 超单次诚实预算时进入 `reviewMode:'partitioned'`：CLI 做确定性 inventory + whole-file 字节分桶 + 指纹 + guard + 缓存；model 按 unit 审查、按需拉契约文件、产 findings + coverage receipt；aggregator 合并/复核/出覆盖证明，PASS 由 gate 赚取。

### Not building
- 不动 single-shot 与 scoped 路径（under-cap、scoped 行为零变化）。
- 不引入 tree-sitter / AST / import-graph 语义解析。分桶只按**目录 + 字节预算**；依赖提示只用 `require()/import` 的**确定性正则**（JS/TS 适用，其他语言退化为 whole-file + 按需读），绝不构图。
- 不改 `hashFileContent` 身份命名空间（仍 sha256 of worktree content，**零指纹迁移**），只改 streaming 防超大单文件 OOM；**不**用 git blob OID（`ls-files -s` 取 index，漏未暂存编辑；PR 路由正因此用 `worktreeBlobSha`）。
- 不改 `reviewer-pass-fail` / `fix-report` schema；coverage 走独立新增 `unit-review-report`。
- **不建以 summary-first 为主的 cross-cutting**（L2 已否）；它只作降级兜底。
- **不建文件内分块 review**：单个文件大于 `MAX_UNIT_BYTES` 时，本计划不把它切成多段让 model 拼接理解；该情况按 coverage blocker 处理（见 §4.2/§6），不允许假 PASS。

---

## 4. 架构与关键决策

### 4.1 确定性 / 语义边界
- **CLI**：inventory、whole-file 分桶、指纹、guard、缓存、确定性 `require/import` 提示。全部确定性、可指纹化、可缓存。
- **model**：逻辑分组、契约核查、findings、coverage 判断。全部语义。

主力跨模块网（复用现有机制，非新造脆弱件）：
1. merged rules 已注入每个 context pack；把纪律写进 `code.md`。
2. `references`（`readOnly:true`）已是只读读入机制；用它承载"按需契约文件"。

### 4.2 Key decisions
1. **whole-file 字节分桶**（纯确定性）：按目录子树自然序 bin-pack，每普通 unit ≤ `MAX_UNIT_BYTES`（初值见 §9）；**永不拆分单个文件**。单文件超预算 → 自成 `oversize_file:true` 的 over-budget unit，**不把正文塞进 reviewer context**，立即记录 `coverage_risk:high` / `skipped_reason:single-file-over-budget`，最终只能得到 `stopped-with-deferrals` + `coverage-incomplete`，除非操作者先拆小该文件或未来另立文件内分块设计。`unit_id = unit-NNN` + member 内容 digest（缓存键）。
2. **触发即分片，不再硬阻塞**：whole-root 超 `MAX_WHOLE_ROOT_BYTES`（或 files）→ 进 partitioned，而非 `file-set-too-large`。file-count cap 由此**自动从"误杀 footgun"降级为触发器之一**。
3. **纪律写成可本地核查的规则**（进 `shared/rubrics/code.md` partitioned 段）：redaction-at-write-boundary、identity-field-coverage、allowlist-only-git、status/phase legality。
4. **按需契约读取**：unit context 用确定性 `require/import` 正则把该 unit 依赖的 in-root 文件列为**建议只读引用**；reviewer 在 `CONTRACT_READ_BUDGET`（初值见 §9）内拉取；额外读入记进 coverage receipt；`coverage_risk` 枚举固定为 `none|high`，任何越界、metadata-only 或无法确证的情况都写 `high`。
5. **earned PASS gate**：全部 high-risk unit 已 body-review + cross-cutting 兜底完成 + findings 全 triage + 无未决 high/medium + 所有 unit `coverage_risk=none`。任一不满足 → `stopped-with-deferrals` + `coverage-incomplete`，**绝不 PASS**。
6. 三阶段各自可独立合并；`project-review/` 为 target-local 状态，沿用现有清理规则；**无数据迁移**。
7. **fix-attempt cap 与 `rounds=` 保持现状、不因 partition 改变**（operator 决定）：CODE target 仍是**一个 file-set、一个 `fixAttemptCount`**；`MAX_FIX_ATTEMPTS = 5` 仍是**项目级**兜底（= 最多 5 个 whole-project fix 轮次，每轮修掉当前全部 accepted issues 再复审，**非 per-unit、非 per-issue**）；`rounds=<n>` 仍是项目级可选 loop 上限；recurring-finding → `stopped-no-progress` 规则不变。partition 只重构 **review** 的分块方式，不改 **fix** 的计数与收敛口径。

---

## 5. 持久化 schema（target 目录下新增 `project-review/`）

```text
.drfx/targets/<target-key>/project-review/
  inventory.jsonl    # 每行 {path,size,ext,contentId,unit_id};无正文
  units.json         # {reviewMode,unitByteBudget,
                     #  units:[{unit_id,member_count,member_bytes,member_digest,files[],suggestedRefs:[{path,contentId}],oversize_file?}],
                     #  crosscuttingBackstops:[固定列表],
                     #  projectReviewFingerprint}
  summaries/<unit_id>.json  # coverage receipt + reviewCacheKey + extraReads[{path,contentId}] + interface/contracts-touched 摘要(Phase 2)；oversize unit 只记录 skipped_reason/coverage_risk，不记录正文
  findings/<unit_id>.json   # 该 unit 的 reviewer-pass-fail findings(Phase 2)
  aggregate.json            # 合并/去重/coverage/verdict(Phase 2 基础;Phase 3 加复核)
```

- `project-review/` **必须挂在有效 CODE target-state manifest 下**，不得成为无 manifest 的游离目录。Phase 1 只产 plan 时，persistent `review-and-fix` / `resume` / `reset` / `ledger=` 路径的 manifest 写成 `Status: checkpoint`、`Status reason: checkpoint-requested`、`Current phase: review`，`Next action` 指向继续 Phase 2 unit review；它不是 active review/fix loop，但仍使用现有 target-key、reset、archive、resume、stale-state 校验和清理规则。一次性 `read-only --no-state` 路径仍不得写 `.drfx/targets/`：它只返回 no-state partition plan（或明确 unsupported/blocker），不创建 `project-review/`。
- `crosscuttingBackstops` 固定派生自 `code.md` priority surfaces：`security-redaction / state-machine-invariant / install-uninstall-fs-safety / cli-parser-template-consistency / cross-platform-symlink / tests-fixtures / public-contract-backcompat`（仅 prompt 标识，非 CLI 逻辑）。
- `projectReviewFingerprint` = 按路径排序的 `{path, contentId}` 清单 sha256（任一文件内容或路径变 → 聚合失效；单 unit `member_digest` 仍用于增量缓存入口）。
- `reviewCacheKey` = `member_digest` + merged-rules fingerprint + `suggestedRefs` 的 `{path,contentId}` 有序 sha256；复用旧 `summaries/<unit_id>.json` 前还必须重算其中 `extraReads[{path,contentId}]`，任一建议引用或实际额外读取文件变更都强制该 unit 重新 review。
- `oversize_file:true` 只允许出现在单成员 unit；其 coverage receipt 固定为 `reviewed:false`、`coverage_risk:high`、`skipped_reason:single-file-over-budget`，并由 aggregate gate 映射为 `coverage-incomplete`。

---

## 6. 三阶段实现计划

> 每阶段独立可合并：Phase N 合并后系统处于可用状态，即使 N+1 永不落地。

### Phase 1 — `file-set-too-large` 改为 partitioned plan（确定性、只读输出）
**独立价值**：目标项目不再被硬阻塞，拿到 inventory + whole-file 分桶 plan（即便手动逐 unit 审也可用）。

改动：
- `lib/target-context.js`：新增 `resolveCodeInventory({cwd,scopes,commandLog})`，复用 `walkDirectory(null)` 全量遍历 → `{path,size,ext,contentId(streaming sha256)}`；新增 `projectReviewFingerprint`。
- 新模块 `lib/project-review.js`：纯函数 `partitionInventory(inventory,{unitByteBudget})`（whole-file 分桶）、`suggestRefsFor(unitFiles)`（确定性 `require/import` 正则，仅产 in-root 路径）、`project-review/` 读写。
- `lib/workflow/file-set-context.js` / `start.js`：CODE whole-root 命中超限 → persistent 路径创建 manifest-backed checkpoint state，构建并写 plan，返回 `{status:'partitioned-review',reviewMode,targetStateDir,reviewPlanPath:'project-review/units.json',unitCount,nextAction}`；manifest 用现有 `checkpoint` + `checkpoint-requested`，**不新增 `STATUS_VALUES`**，但 reset/archive/resume/stale-state 必须按普通 target state 生效。一次性 `read-only --no-state` 路径只返回 no-state partition plan 或显式 unsupported/blocker，保持不落盘契约。
- `shared/rubrics/code.md`：加 partitioned 段（unit PASS≠project PASS；Key decision 3 四条纪律；跨 unit finding 必须命名具体依赖边/caller path）。
- `lib/generator.js` + `templates/fragments/route-contract.code.{claude,codex,gemini}.md` + `test/fixtures/generated/*`：同步说明。

测试：`partitionInventory` 确定性 & whole-file 不拆；单文件 > `MAX_UNIT_BYTES` 生成单成员 `oversize_file:true` unit 且不硬切；`suggestRefsFor` 只产 in-root 路径且带 contentId；全量遍历不被 cap 截断；`.drfxignore` / version-ignore / scope-wins 仍生效；`partitioned-review` JSON；partition checkpoint 的 reset/archive/resume/stale-fingerprint 行为；read-only no-state 超限不创建 `.drfx/targets/`；`npm run syntaxcheck` + `npm test`；手动对 >cap fixture 跑 `drfx workflow start review-fix-code` 得 plan。

### Phase 2 — bounded unit-review + 兜底 cross-cutting（只读项目审查）
**独立价值**：能跑只读分片审查，得到 coverage 化的 `read-only-findings` / `read-only-clean`。

改动：
- `lib/context-pack.js`：`buildFileSetContextPack` 支持 unit 子集 + 注入 `suggestedRefs` 为只读 references；加 `reviewMode/unit_id`。
- `bin/drfx.js` + 新 `lib/workflow/file-set-unit-review.js`：
  - `drfx workflow context review-fix-code <mode> --phase unit-review --unit <id> --json` → 仅该 unit 正文 + merged rules + 建议契约引用。
  - `drfx workflow record-review ... --phase unit-review --unit <id> --result-stdin --json` → 写 `findings/<id>.json` + `summaries/<id>.json`（coverage receipt：reviewed / skipped+reason / extraReads[{path,contentId}] / `coverage_risk:none|high` + contracts-touched 摘要）；`reviewCacheKey` 与 extraReads 指纹都未变时才可跳过（增量）。
- **从 Phase 1 checkpoint 恢复并推进状态**：`context --phase unit-review` 先校验目标处于本 file-set 的 partition checkpoint（`Status: checkpoint` / `checkpoint-requested`）且 `projectReviewFingerprint` 未漂移（漂移 → 复用现有 stale-state / `blocked` 处理，不静默续审）；通过后按 `units.json` 顺序发下一个"无有效 `summaries/<unit_id>.json`"的 unit。Phase 2 全程 `Current phase` 仍为 `review`（partitioned review 即 review 阶段的分块，**不新增 `PHASE_VALUES`**；`unit-review` 只是 context 的子 phase 标志，非 manifest phase）；逐 unit 完成度由 `summaries/` + `reviewCacheKey` 记录，故中断后 resume 自然从下一个未审 unit 继续。全部 unit 完成后交 aggregate 收口。
- oversize unit 处理：`context --phase unit-review --unit <id>` 对 `oversize_file:true` 返回 metadata-only context 和 `nextAction:'record oversize coverage blocker'`；不派发正文 reviewer。`record-review` 接受受限的 `unit-review-report` payload，写 `reviewed:false`、`skipped_reason:single-file-over-budget`、`coverage_risk:high`；aggregate 因此不得 clean/PASS。
- `lib/semantic-parsers.js`：新增 `unit-review-report` schema（additive，不动现有），并固定 `coverage_risk` 枚举为 `none|high`。
- cross-cutting **兜底**：`--phase crosscutting --backstop <id>`，context = 仅 summaries；仅用于无契约文件可依的涌现性属性；拿不到确证 → 必须写 `coverage_risk:high`（非 PASS），不得静默通过。
- `shared/prompts/{reviewer,coordinator}.md`：加 unit-review + 按需契约读取 + 兜底循环说明。
- `lib/project-review.js`：**基础 aggregate**——拼接 findings + coverage receipt，verdict 仅 `read-only-findings`，或（零 findings 且全 unit `coverage_risk=none`）`read-only-clean`。

测试：unit context 有界（只含该 unit + 建议引用，断言无越界）；oversize unit 不含正文、只产 metadata-only coverage blocker；按需读入记入 receipt；缓存跳过必须同时满足 member、suggestedRefs、extraReads 指纹不变；修一个契约文件会强制所有读取过它的 unit 复审；从 Phase 1 checkpoint resume 只续审无有效 summary 的 unit、`projectReviewFingerprint` 漂移时按 stale/blocked 处理；兜底 pack 断言无正文；`unit-review-report` parser；只读 verdict 诚实性（任一 unit `coverage_risk≠none` → 不得 clean）。

### Phase 3 — aggregate-review 复核 + fix 集成 + earned PASS
**独立价值**：覆盖证明 + 高严重复核 + 可证明 PASS + 自动 fix。

改动：
- `bin/drfx.js` + `lib/project-review.js`：`drfx workflow aggregate-review <targetStateDir> --json` 增强——去重（location+category）；coverage receipt（discovered / body-reviewed / extra-read / skipped+reason / high-risk-units-fully-reviewed / residual risk）；每个 P0/P1/high 强制 aggregator 复读 location + caller/callee + test/config/contract 切片才入终报。
- `lib/workflow-state.js` + `lib/semantic-parsers.js` + `lib/final-response.js` + `shared/core.md`：三个 final/status validation allowlist 和共享路由契约都加 `coverage-incomplete`；`final-response` 允许 `Final status: stopped-with-deferrals` + `Status reason: coverage-incomplete`，要求 `Deferrals or blockers` 写明 coverage deferral 的 owner 和 next action，但不要求伪造 reviewer issue ID。更新后必须通过 generator 同步生成/嵌入的 CODE 路由文本与 fixtures，避免 skill 内嵌合同仍列旧枚举。
- fix 集成：聚合后接入**现有** triage / fix / diff-review / full-re-review；fix guard（`buildFileSetFixerGuard`，`lib/workflow/helpers.js:834`）写边界 = inventory 文件并集，天然 in-set；修后重审受影响 unit、其 `suggestedRefs` 命中的 unit、以及 summaries 中 `extraReads` 命中的 unit，再 re-aggregate；PASS 仅经 Key decision 5 的 gate。
- oversize unit gate：任一 `oversize_file:true` unit 未被正文 review 时，aggregate 直接产 `stopped-with-deferrals` + `coverage-incomplete`，next action 是拆小该文件、显式排除它，或等待独立的文件内分块方案；不得进入自动 fix 或报告 PASS。
- **fix-attempt 计数与收敛口径保持现状（见 §4 决策 7）**：fix 阶段按**项目级轮次**跑（一次 begin-fix/end-fix 修掉当前全部 accepted issues，over 整个 file-set 并集），`fixAttemptCount` 仍 per-file-set、cap 仍 5、`rounds=` 仍项目级；`lib/workflow/file-set-fix.js` 的计数逻辑**无需改动**。
- `shared/prompts/coordinator.md`：aggregator gate 段。

测试：metadata-only / extra-read-overflow / oversize-file high-risk → `stopped-with-deferrals` + `coverage-incomplete`（从不 PASS）；finalize 接受 `Status reason: coverage-incomplete` 的 `stopped-with-deferrals`，但拒绝 PASS 携带该 reason；`shared-assets.test.js` 覆盖 `shared/core.md`、生成 CODE 路由、嵌入 skill 文本中的 `coverage-incomplete` 枚举一致性；高严重复核；契约文件改动会触发依赖 unit 复审；fix 不越 in-set；gate 满足才 PASS；全生命周期 lifecycle 测试。

---

## 7. 规模 / 回滚 / 迁移

- **规模**：大型功能 + 1 新模块，跨 `target-context / project-review(新) / context-pack / workflow-state / semantic-parsers / final-response / lib/workflow/* / bin/drfx / shared/{core,rubrics,prompts} / generator+templates+fixtures` + 大测试增量（现 806）。L2 重塑后比初版更小（主力机制复用现有 references / merged-rules，去掉了 summary-first 为主的复杂度）。
- **回滚**：三阶段全 additive，藏在超限分支与新子命令后，single-shot / scoped 零改动；`project-review/` 可清理；仅 1 个 additive 枚举值。回滚 = revert。
- **迁移**：**无**。刻意保留 sha256 身份命名空间，既有持久化 CODE 指纹不变。

---

## 8. 残余风险（已识别、已接受、已变形为诚实非 PASS）

**纯涌现性、不绑定任何契约文件的全系统属性**（如"这 N 个模块的错误处理策略是否整体自洽"），兜底 cross-cutting 吃 summary 仍可能漏。这是 L2 唯一无法离线消除的残余。

**已为其变形（这不是未决问题，是已接受并已缓解的风险）**：此类一律以 `coverage_risk:high` → `stopped-with-deferrals` 收场——**失败 = 诚实非 PASS，不是假 PASS**。契约类（redaction / identity / allowlist / status——本仓库实测的主要风险）已由 whole-file unit + 规则化纪律 + 按需契约读取覆盖，不依赖该假设。

> **不阻塞本计划**：设计已保证该残余只会表现为 `coverage_risk` 升高→非 PASS（而非假 PASS）。Phase 2 只读跑时顺带观测 `coverage_risk` 分布，仅用于 §9 数值微调，不改变方案结构。

**单文件超预算**同样不是假 PASS 风险：本计划不实现文件内分块，因此它被明确归类为 coverage blocker。该文件会被 inventory/fingerprint/guard 捕获，但不会被声称已正文审查；聚合结论必须是 `coverage-incomplete`，直到文件被拆小、排除，或另一个已批准设计补上文件内分块审查。

---

## 9. 可调默认值（已定初值，Phase 2 仅做校准，无未决问题）

无未决决策。以下为带初值的可调常量，与现有 `MAX_WHOLE_ROOT_BYTES` 同属"Tunable constants, not load-bearing"：

- `MAX_UNIT_BYTES = 1_000_000`：普通 unit 自身正文上限；单文件超过该值时不拆分，标记为 oversize coverage blocker。
- `CONTRACT_READ_BUDGET = 500_000`：按需契约读取的额外预算；超出 → `coverage_risk:high` → 非 PASS。
- **依据**：二者之和 1,500,000 = 已验证的单次"忠实读完"预算（对齐 `MAX_WHOLE_ROOT_BYTES`）——一个 reviewer 一次 pass 读 unit 正文 + 必要契约文件 + merged rules 仍在预算内。
- Phase 2 在首个真实大目标上按观测**仅微调数值、不改结构**；不阻塞落地。

---

## 10. 验证命令 / Definition of Done

- 每阶段：`npm run syntaxcheck` + `npm test` 全绿；新增行为有 `*.test.js` 贴边覆盖（分桶/解析→新建或 `target-context.test.js`；状态→`workflow-state` / `target-state.test.js`；route 文本→`shared-assets.test.js`；CLI→`cli.test.js`；file-set 生命周期→`workflow-fileset-lifecycle.test.js`）。
- 公共行为变化时同步 `README.md` / `README.zh-CN.md`（技术字面保持英文）。
- 完成判据：whole-root 超限不再硬阻塞而是产出 partition plan（P1）；可跑只读分片审查并得 coverage 化只读结论（P2）；aggregator 出覆盖证明、高严重复核、gate 满足才 PASS、否则 `stopped-with-deferrals` + `coverage-incomplete`（P3）；单文件超预算 fixture 必须证明不会假 clean/PASS。

---

## 11. 不建议的做法（连同理由，避免回潮）

- **不**把 1.5MB 调成 10/50MB：注意力稀释、stdin handoff / 调试输出 / token 成本变脆，且仍不可证明全项目审查。
- **不**完全取消 cap 继续 single-shot：回到"我已 review 全项目"的不可证明假 PASS，违反 `PASS is earned`。
- **不**引入大型静态分析依赖（tree-sitter / LSP / 全量 AST）：跨语言维护成本高，本方案用 Node 内置 + git + 简单正则即可。
- **不**改现有 reviewer schema 塞 coverage 字段：会扩散 `lib/semantic-parsers.js` blast radius；coverage 走独立 `unit-review-report`。
<!-- /r2p-read-only -->

## Project Context (read-only)
# Project Context Pack

- repo_root: `/Users/xubo/x-studio/document-review-fix`
- languages: {'JavaScript': 36148}
- package_managers: npm
- test_commands: ['npm test']
- entrypoints: ['lib/workflow/index.js']
- config_files: none
- dependencies (0): none
- source_dirs: ['bin', 'design', 'docs', 'lib', 'scripts', 'shared', 'skills', 'templates', 'test']
<!-- /r2p-read-only -->
