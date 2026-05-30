# 增强审查与修复技能 — 语义质量提案

- 日期：2026-05-30
- 范围：`shared/prompts/*`、`shared/rubrics/*`、`shared/core.md`（G1–G4）；`lib/workflow/diff-review.js`、`lib/workflow-state.js`、`lib/workflow/finalize.js`（G2）；`lib/fix-guard.js`、`lib/workflow/fix-lifecycle.js`、`lib/snapshot-guard.js`（G5 复用）；对应 `test/*`
- 目标读者：包维护者；批准后可进入 review-fix-plan 转化为实施计划
- 当前版本：`0.2.0`
- 形态：纯提案，本文档**未改动任何代码**
- 修订：2026-05-30 经一轮代码层审查（6 条 finding 全部核实成立）后修订——G1/G3 改为不动机器 schema 的 prompt-only 方案，G4 重新归类为需 context-pack CLI 改动，G2 补全枚举落点，G5 改用"会话内是否已修过"信号（而非 `currentRound`）并修正 git abort 描述

## 1. 背景

0.1.0→0.2.0 的历轮优化集中在**管道层**：snapshot guard opt-in、`lib/workflow.js` 模块拆分、裸路径推荐、双语 README、blocking reason 用户文本分流。这些让 review-and-fix 路径更可用，但**没有触碰 loop 的语义质量**——也就是"审得准不准、修得对不对、会不会空转"。

本轮聚焦语义层。核心论点延续本项目一贯立场：**CLI 判不了语义，所以语义纪律必须压进 prompt/rubric 契约**。G1–G4 这 4 个缺口正是把这个论点应用到它自己最薄的三处（修复有效性、严重度校准、回归感知）加一处结构性缺失（收敛保证）。

**G5 是 2026-05-30 追加的一条独立缺口**：用户实跑 `guard=git` 命中"修完一轮即被 `rollback-unavailable` 阻塞、留下 Unfixed"。它不是语义质量增强，而是默认守卫路径的**正确性破损**，优先级高于 G1–G4，详见 §3 G5。

## 2. 现状勘察结论（已逐项验证）

| 项 | 现状 | 证据 |
|---|---|---|
| 收敛/防震荡机制 | **完全没有** | grep `no-progress\|max-round\|max-fix-attempt\|oscillat\|converge\|recurr` 全仓 `lib/ shared/ templates/ skills/` 零命中 |
| loop/fix-attempt 上限 | 无可靠计数 | `currentRound` 仅在 `lib/workflow/diff-review.js:121` 的 DIFF-FAIL 回 fix 路径 `+1`，覆盖不了 DIFF-OK 后复审再修 |
| diff review 校验范围 | 只验"映射/范围/术语/占位符/脱敏" | `shared/core.md:149-157`；**不含**"fix 是否真的解决 finding" |
| fix 有效性判定 | 不存在 | `shared/prompts/fixer.md:25-39` 只报 Fixed/Not fixed，无 resolves 判定 |
| reviewer severity 锚 | 无定义 | `shared/rubrics/*` + `reviewer.md:34-36` 只说"normal 下 high/medium 阻塞"，未定义何为 high/medium/low |
| reviewer 覆盖信号 | 无 | `reviewer.md:38-54` 输出 schema：PASS 仅 `Summary:`，coordinator 无从判断查了哪些维度 |
| re-review 回归感知 | 无 | 每次 full re-review 是全新 isolated reviewer，context pack（`coordinator.md:16-24`）只带 "Accepted non-blocking low issues"，不带上一轮改动信号 |
| coordinator PASS 独立同意 | 要求存在但缺抓手 | `core.md:67` 要求"独立同意"，但 reviewer 不输出覆盖面，同意流于形式 |
| `guard=git` 多轮修复 | **结构上只能修一轮** | begin-fix 在 `fix-lifecycle.js:97`（`checkGitRollbackAnchor`）与 `:110`（`checkTargetOnlyWorktree`，`allowTarget:false`）两道守卫都卡 dirty 目标；`guard=snapshot` 因逐轮快照免疫（见 §3 G5） |

## 3. 缺口与提案

每条给最小可行版本（brute force 优先），标注精确落点、风险、最脆弱前提。

### G1 — 修复有效性从不被验证（修复侧，最高杠杆）

**问题**
fixer 报 `Fixed: ISSUE-001`（`fixer.md:26-27`），diff review 契约（`core.md:149-157` / `coordinator.md:129-132`）只确认"fix 映射到 accepted issue、无越界、术语/占位符/脱敏 OK"。一个**改在了对的位置但没真正解决 `why_it_matters`** 的 fix 能通过 diff review。它只能等下一次昂贵的 full re-review 兜底——而 re-review 是全新无记忆 reviewer，未必以同口径再抓到，问题可能**静默滑向 PASS**。

**约束：不能新增机器 schema 字段（2026-05-30 核实）**
`lib/semantic-parsers.js:283-317` 的 `parseDiffReview` 极严：DIFF-OK 经 `parseSummary` 要求**恰好 2 行**（`DIFF-OK` + `Summary:`），DIFF-FAIL 字段白名单仅 `issue_id/problem/required_action`（`:72`、`:303-305`）。任何 `Resolved:`/`resolves:` 行或字段都会被拒。所以 G1 **不动机器 schema**，把有效性判断做成 coordinator 的 prompt 纪律。

**最小修法（prompt-only，零 CLI）**
- coordinator 在 diff review 阶段，对每个 claimed-fixed 的 accepted issue **必须**核对该改动是否真正消解原 finding 的 `why_it_matters`，而不仅是"改在了对的位置"。
- 判断标准写进 prompt：若某 fix 未真正解决（cosmetic / 偏移 / 只动了无关措辞），coordinator **用现有 DIFF-FAIL 机器格式**产出，`problem` 写"claimed fix does not resolve original finding <redacted why>"、`required_action` 写下一步——**不新增字段**。
- **CLI 侧零改动**：`lib/workflow/diff-review.js:20-36` 的 `reopenDiffFailedIssues` 已把 DIFF-FAIL 的 issue 从 `fixed` 改回 `reopened`。G1 只是让"未真正解决"的 fix 走既有 DIFF-FAIL 通道，复用现成回滚路径。

**落点**：`shared/core.md`（Diff Review 节，把"有效性核对"加入 diff review 必查项）、`shared/prompts/coordinator.md`（Diff review 段，明确逐 fix 判有效性、未解决走标准 DIFF-FAIL）、`shared/prompts/fixer.md`（Output 增一句"为每个 Fixed 项说明它如何解决原 finding，供 diff review 核对"）。**均为 prompt 文本，不碰 `semantic-parsers.js`。**

**为什么 brute force 正确**：不引入新状态、不改 parser、不改 round 语义。只把 diff review 的 prompt 纪律从"位置核对"升级为"有效性核对"，复用既有 DIFF-FAIL 机器通道，填上当前 fix→re-review 之间的语义真空。

**重型替代（不采纳）**：若坚持机器可校验的 `resolves` 字段，则须同时改 `lib/semantic-parsers.js`（DIFF-OK 放行新段 + DIFF-FAIL 白名单加字段）、normalized diff report、`test/semantic-parsers.test.js`——成本与风险显著上升，本期不做。

**最脆弱前提**：diff review 的 coordinator 能基于 finding 的 `why_it_matters` 客观判断"是否解决"。若 finding 本身写得含糊（`why_it_matters` 空泛），有效性判定也会失真。缓解：reviewer schema 已要求 `why_it_matters: <impact>`（`reviewer.md:50`），G1 把它从"记录"提升为"被消费"，反向激励 reviewer 写具体。

**风险**：低。最坏情况是多一轮 DIFF-FAIL→fix，仍收敛于既有通道。

### G2 — 没有收敛/防震荡上限（loop 鲁棒性，唯一碰状态机）

**问题**
当前没有可靠的 loop/fix-attempt 上限：`currentRound` 只在 DIFF-FAIL 路径递增，不能覆盖常见的 `DIFF-OK → full-re-review → FAIL → begin-fix` 再修路径；`STATUS_VALUES`（`lib/workflow-state.js:8-22`）也无 `stopped-no-progress`。LLM fixer 可能震荡（修 A 引入 B、修 B 又引入 A）或对同一 finding 反复无效"修复"。今天**除用户手动停外，没有任何东西能终止 loop**。一个自动修复 loop 缺收敛保证是结构性风险。

**最小修法（语义检测为主 + CLI 兜底封顶）**
- 语义侧（coordinator 规则，写进 `core.md`/`coordinator.md`）：同一 issue（按稳定 `location` + 类别）在某轮被标记 `fixed` 后，于后续轮被 reviewer 以同口径重新提出 ≥1 次 → 判定为 no-progress；停为新 pause 状态 `stopped-no-progress`，携带复发 findings 的 redacted IDs/locations 与 next action。
- CLI 兜底：新增持久 `fixAttemptCount`（或等价 manifest 字段），初始化为 0，每次成功进入 `begin-fix` 前检查、进入后递增。阈值语义统一为**封顶 5 次 fix attempt**（`fixAttemptCount` 已达 5 时，第 6 次 begin-fix 前检查拒绝、不再写目标，直接落 `stopped-no-progress`；默认 5 可后续做成 `max-fix-attempts=` token，本期写死）。该计数**独立于 `currentRound`**；`currentRound` 继续只服务现有 round/report/snapshot 命名，不作为收敛封顶信号。
- **向后兼容（必须）**：`target-state.js:464` 对 `MANIFEST_FIELDS` 每个字段都 `requireManifestValue`（必填）。`fixAttemptCount` 读取时若旧 manifest 缺该字段须**默认 0**——即**不**加入 `requireManifestValue` 强制集、读取端兜底缺省，保持 manifest schema 仍为 `2`、不引入 migration。否则 `resume` 一份升级前创建的 manifest 会 `state-validation-failed`。
- 新增枚举：`STATUS_VALUES` 加 `stopped-no-progress`；`STATUS_REASONS`（`workflow-state.js:62-75`）加 `no-progress-detected`。finalize 把它当 pause 状态处理（同 `stopped-with-deferrals` 一类：非 PASS，可恢复，记录未解决项）。

**落点（2026-05-30 核实补全——状态/原因枚举分散在多处，漏一处即在解析/校验/receipt 路径炸）**

新状态 `stopped-no-progress` 与新原因 `no-progress-detected` 必须在**所有**枚举副本同步：
- `lib/workflow-state.js:8-22 STATUS_VALUES` + `:62-75 STATUS_REASONS`（持久 manifest 校验）。
- `lib/semantic-parsers.js:12-22 FINAL_STATUSES` + `:46-58 STATUS_REASONS`（final-response 机器块解析，否则 finalize 提交即 `final-validation-failed`）。
- `lib/target-state.js:7 ALLOWED_STATUSES`（manifest 读写校验）。
- `lib/workflow/helpers.js:1335 finalizationRequiresReceipt`（加入该状态，使 finalize 写 receipt）。
- `lib/receipts.js:8 RECEIPT_STOP_REASONS`（核对/按需新增 finalize receipt 的 stop reason）。
- `shared/long-task.md:50` Status 列表 + `shared/core.md`（Terminal And Pause States 节）。

加封顶/复发判定与状态落地：`lib/workflow/start.js`（初始化计数字段）、`lib/workflow/fix-lifecycle.js`（begin-fix 检查/递增 attempt）、`lib/workflow-state.js`/`lib/target-state.js`（manifest 字段读写校验）、`lib/workflow/finalize.js` 与/或 `lib/workflow/diff-review.js`（复发检测与终态落地）。

文案与终态列表：`shared/prompts/coordinator.md`（Loop/Terminal 段）、四套 `skills/*/SKILL.md` 终态列表、三套 `templates/*` 终态列表。

测试：新增 `test/`（见 §6）。

**为什么不做"diff issue-graph 引擎"**：检测复发只需"同 location+类别在 fixed 后重现"这一启发式，加 fix-attempt 封顶兜底即可。构建完整 issue 依赖图属于过度设计，违反"smallest safe change"。

**最脆弱前提**：reviewer 跨轮对"同一问题"的 location 措辞稳定到能被识别为复发。若 reviewer 每轮换措辞，语义检测会漏判——这正是 fix-attempt 封顶作为**确定性兜底**存在的理由：即使语义检测漏了，封顶 5 次后第 6 次 fix attempt 也会硬停。

**风险**：中（唯一改状态机）。缓解：新状态走与 `stopped-with-deferrals` 同构的 finalize 分支，最大化复用；新增端到端测试断言"复发触发停机"与"封顶触发停机"。

### G3 — reviewer 的 PASS 未校准、不可审计（审查侧）

**问题**
两个子问题：
- (a) severity 无锚定。`reviewer.md:34-36` 只规定"normal 下 high/medium 阻塞 PASS"，但没定义**什么是 high/medium/low**，导致跨 run 严重度漂移。
- (b) `PASS / Summary: none`（`reviewer.md:39-40`）让 coordinator 无从判断 reviewer 究竟查了哪些 rubric 维度。浅 reviewer 的 PASS 与深 reviewer 的 PASS 在输出上无法区分，而 `core.md:67` 要求的 coordinator"独立同意"此刻无抓手。

**约束：reviewer 机器输出不能加 `Coverage:` 行（2026-05-30 核实）**
`lib/reviewer-report.js:177-190` 的 `parseReviewerResult` 极严：PASS 必须**恰好 2 行**（`PASS` + `Summary:`），FAIL 第二行必须是 `Findings:`。任何独立 `Coverage:` 行都会让 record-review 解析失败。所以 G3 分两半处理：

**G3-a 严重度锚（纯 rubric，零解析影响）**
- 在 `shared/rubrics/common.md` 顶部加一段 severity 锚（每级一行），四套 type rubric 复用 COMMON 的定义不重复：
  ```text
  Severity anchors:
  - high: blocks the document's stated purpose, or makes execution/acceptance unsafe or impossible.
  - medium: materially weakens correctness/completeness but a competent next actor can still proceed with caution.
  - low: clarity/consistency/structure improvement that does not block use in normal mode.
  ```
  severity 锚不进机器输出，只是 reviewer/coordinator 判级时的参照，`parseReviewerResult` 不受影响。

**G3-b 覆盖信号（折进现有 `Summary:` 自由文本，不加机器行）**
- reviewer 把"已审查的 rubric 维度组"用一句 terse 文本写进**现有的** `Summary:` 行（PASS 的 `Summary:` 与 FAIL 的 finding 文本都是 redacted 自由文本，parser 不限制其内容），例如 `Summary: covered requirements/scope/io/edge/risks/reference; no blocking issues`。不新增 `Coverage:` 机器行。
- coordinator 的"独立同意"（`coordinator.md` Loop step 10 / `core.md:67`）补一句：从 `Summary:` 读取覆盖陈述，若未覆盖该类型 rubric 的必查组则要求 reviewer 补审而非直接 PASS。

**落点**：`shared/rubrics/common.md`（severity 锚 + 各类型必查组清单）、`shared/prompts/reviewer.md`（Instructions 要求在 `Summary:` 内陈述覆盖面、引用 severity 锚——**不改 Output schema 行数**）、`shared/prompts/coordinator.md`（同意步核对 Summary 内覆盖陈述）。**均为 prompt/rubric 文本，不碰 `reviewer-report.js`。**

**为什么 brute force 正确**：纯文本契约，不改 parser、不改机器输出行数，由 `test/shared-assets.test.js` 文本断言验收；既有 `test/reviewer-report.test.js` 断言不受影响。

**重型替代（不采纳）**：若要 `Coverage:` 成为独立机器可校验字段，则须改 `lib/reviewer-report.js`（PASS 放行第 3 行 + FAIL 第二行兼容）、normalized reviewer report、no-state/persistent record-review 测试——本期不做。

**风险**：低，但需防"prompt 膨胀压低遵从度"——见 §5。

### G4 — re-review 对回归是盲的（审查侧）

**问题**
每次 full re-review 是全新 isolated reviewer，**对上一轮改了什么毫无信号**，无法定向抓"修 ISSUE-003 时把第 4 节改矛盾了"这类 fix 引入的回归。它从零再推导整篇，既费 token 又可能漏掉只有定向才看得见的回归。

**约束：context pack 由 CLI 生成，G4 不是纯 prompt（2026-05-30 核实）**
reviewer context pack 是 `lib/context-pack.js:97 buildContextPack` 产出的 `contextPackSkeleton`，由 `lib/workflow/persistent-context.js:71 runPersistentContext` 填充。它**目前没有**"上一轮变更"字段，`runPersistentContext` 也**不读**上一轮 fix/diff 报告。靠 coordinator 凭 chat 记忆补该信息会违反 core.md「Runtime Independence：context pack 须自足、不依赖 chat history」（resume 路径会丢）。所以 G4 必须落到 CLI。

**最小修法（context-pack CLI + prompt）**
- `lib/context-pack.js`：`buildContextPack` 新增可选字段 `changedSinceLastReview`（redacted：`sectionsTouched` + `fixedIssueIdsLastRound`），缺省 `null`。
- `lib/workflow/persistent-context.js`：reviewer 阶段且**会话内已发生过 fix**时（判定信号见下），从上一轮的 fix/diff 报告读出改动区与 fixed issue IDs，填入该字段；首个 review 不填。
- gate 信号**不用 `currentRound`**（见 G5 Finding 1：DIFF-OK→re-review 路径它不递增）；用"target 是否已被本会话修改"：`manifest.lastKnownContentSha256 !== manifest.initialContentSha256`，或存在上一轮 fix 报告。
- reviewer 指令（`reviewer.md` Instructions）加一句：仍通读全文判 PASS，但**额外重点复查该字段所列改动区域是否引入回归或新矛盾**；不得因此缩小审查范围。
- 与既有 isolation 哲学一致：context pack 本就携带 `acceptedNonBlockingLowIssueIds`（`context-pack.js:116`），再带"上一轮改了哪"是同源做法，不破坏"全文 + read-only"两条铁律。

**落点**：`lib/context-pack.js`（新字段）、`lib/workflow/persistent-context.js`（按 prior-fix 信号填充）、`shared/prompts/reviewer.md`（Instructions）、`shared/prompts/coordinator.md` + `shared/core.md`（说明该提示仅在已有上一轮 fix 时出现且不缩小审查范围）、`test/context-triage.test.js` 或新增 context-pack 测试。

**为什么仍是最小**：不改 isolation 模型、不改状态机、不加 manifest 字段（复用 `initial`/`lastKnown` 指纹）。首个 review 完全不受影响（字段为 `null`），仅在确有上一轮 fix 时注入定向提示。属"context-pack 字段 + prompt"级改动，不是状态机改动。

**最脆弱前提**：携带"改动区域"提示不会诱导 reviewer 把审查**窄化**到只看改动区。缓解：指令显式写"仍须通读全文，改动区是额外重点而非唯一范围"，并由 `test/shared-assets.test.js` 断言该约束句存在。

**风险**：低-中（含 context-pack CLI 改动）。缓解：新字段缺省 `null`，首个 review 行为零变化；新增 context-pack 测试覆盖"有/无上一轮 fix"两态。

### G5 — `guard=git`（默认守卫）结构上只能修一轮（正确性缺陷，最高优先级）

> 本条是 2026-05-30 用户实跑命中的 bug，不是质量增强而是默认路径的**正确性破损**，优先级高于 G1–G4。

**问题**
`guard=git`（默认）在**每一轮** fix 开始时（`lib/workflow/fix-lifecycle.js:97` 的 begin-fix）都调用 `checkGitRollbackAnchor`，而该函数（`lib/fix-guard.js:253-261`）要求目标相对 HEAD **完全干净**（无 staged / 无 worktree 改动），否则抛 `rollback-unavailable`。

- 首个 fix：目标 == HEAD 干净 → 通过 → 写入修复 → 目标变 dirty。
- 第二次 fix：begin-fix 再次调 `checkGitRollbackAnchor` → 目标已 dirty → **`rollback-unavailable` 阻塞**。

结论：**`guard=git` 在结构上只能完成一次 fix**。任何需要 >1 次 fix 的复审（常见情况）都在第二次 fix 死亡并留下 Unfixed。这与 loop "review→triage→fix→diff→re-review→repeat until PASS" 的核心设计直接矛盾。

**非对称性（关键证据）**
`guard=snapshot` 不受影响：`checkSnapshotRollbackAnchor`（`snapshot-guard.js:193-205`）只校验目标身份，`captureSnapshot`（`:207-226`）每轮把当前目标体快照到 `snapshots/round-NNN/target.body` —— **逐轮锚点**。`fix-lifecycle.js:89-101` 的分派印证了这个分叉：snapshot 走 `captureSnapshot(round)`，git 走 `checkGitRollbackAnchor`（无逐轮锚点、要求 clean HEAD）。

**为什么 0.2.0 漏了它**
`OPTIMIZATION-2026-05-27.md` 把 git 约束当成"初始状态门槛"（非 git/ignore/dirty/旁路）并用 `guard=snapshot` opt-in 解决；未发现 `checkGitRollbackAnchor` 是**每轮**执行的，git 模式的多轮路径从未被端到端覆盖（e2e 多轮用例走的是 snapshot 或一轮即 PASS）。

**绝不是"第二轮自动切 `guard=snapshot`"**
静默把 `guardMode` 从 git 切到 snapshot 会违反 D1「不静默回退」（`OPTIMIZATION-2026-05-27.md` §7）——等于把守卫保证从"全仓 porcelain + 未推送提交保护"悄悄降级成"仅目标邻域快照"。G5 全程保持 `guardMode=git`，只**借用** `captureSnapshot` 机制做逐轮锚点，**保留** git porcelain 非目标检测。（旁证：单看阻塞，literal 切 snapshot 确实不再卡 dirty 目标，但 round1 走 git、round2 走 snapshot 会造成跨轮回滚故事不一致，故不可采纳。）

**begin-fix 在 git 模式下有两道守卫，必须同时按后续-fix 信号分流（2026-05-30 核实补充）**
`lib/workflow/fix-lifecycle.js:88-115` 的 begin-fix，git 分支按序跑两道，**两道都会卡第二次 fix 的 dirty 目标**：

1. 第 97 行 `checkGitRollbackAnchor` → dirty 目标 → 抛 `rollback-unavailable`（先抛，用户当前命中的就是这道）。
2. 第 110 行 `checkTargetOnlyWorktree`（`allowTarget:false`）→ dirty 目标自身被 `inspectStatusEntries` 当成"非目标变更"（`fix-guard.js:210-211`）→ 返回 `unexpected-worktree-change`。

所以只修第①道，第②道会立刻接力把第二次 fix 再次阻塞。G5 必须对后续 fix 同时改两道。

**判定"首个 fix vs 后续 fix"不能用 `currentRound`（2026-05-30 核实，关键）**
`currentRound` 全仓只在 `start.js:123`(=1) 与 `diff-review.js:121`(DIFF-FAIL 时 +1) 写入。最常见的第二次修复路径 `DIFF-OK → full-re-review → record-review FAIL → record-triage → begin-fix` **不经过 DIFF-FAIL，currentRound 仍为 1**。所以 G5 的守卫切换**不能**按 `currentRound>1` 判断，否则第二次 begin-fix 仍被当成首个 fix、跑 strict clean-HEAD、再次阻塞。

正确信号：**target 是否已被本会话修改过** = `manifest.lastKnownContentSha256 !== manifest.initialContentSha256`（首个 fix 前两者相等；任何一次 end-fix 后 lastKnown 即更新）。该信号与 `currentRound` 无关，覆盖所有再次 fix 路径。

**为什么不能简单"放宽 clean-HEAD 检查"**
clean-HEAD 在**首个 fix** 有真实安全价值：它保证回滚锚点 HEAD 不会覆盖用户**预先存在的未提交编辑**。若直接删掉该检查，目标的预存未提交改动在回滚时会被抹掉。所以正确修法必须**按上述信号区分首个 fix 与后续 fix**：

- 首个 fix（`lastKnown == initial`）git 模式：保留两道守卫（`checkGitRollbackAnchor` 的 tracked + clean HEAD，`checkTargetOnlyWorktree` 的 allowTarget:false 全 worktree 干净），保护预存编辑、建立可信提交基线。
- 后续 fix（`lastKnown != initial`，dirty 正是我方上一轮产物）git 模式：
  - 锚点：跳过 clean-HEAD，改校验当前指纹 == manifest `Last known content sha256`（long-task.md:56，证明 dirty 完全来自我方、无外部篡改；workflow 本就用该指纹做 `externally-changed` 检测）。
  - 非目标检测：用 `inspectActualChangedFiles`（`allowTarget:true`，放行目标自身、仍以 `unexpected-worktree-change` 拦真正的非目标改动）替代 `checkTargetOnlyWorktree`。
- 两种 fix 都额外 `captureSnapshot`（复用 `snapshot-guard.js`），git 模式自此获得**逐 fix 回滚锚点**，与 snapshot 模式统一。
- abort-fix：**当前 git 分支根本不恢复目标**（`fix-lifecycle.js:391-428` 只有 `guardMode === 'snapshot'` 才 `restoreSnapshot`，git 既不 restore 也不 `git checkout`）。G5 **为 git abort 新增逐 fix snapshot restore 行为**——这是行为**扩展**（git abort 从"不回滚"变成"按逐 fix 快照回滚"），不是替换既有 `git checkout`。

**最小修法落点**
- `lib/fix-guard.js`：`checkGitRollbackAnchor` 加 `priorFix`（bool）/ `expectedFingerprint` 参数（首个 fix strict clean-HEAD；后续 fix 改指纹匹配）。begin-fix 的非目标检测按同一信号在 `checkTargetOnlyWorktree`（首个 fix）与 `inspectActualChangedFiles`（后续 fix）间切换——两者均已存在，无新函数。
- `lib/workflow/fix-lifecycle.js:88-115 runBeginFix`：按 `lastKnownContentSha256 !== initialContentSha256` 选择**两道**守卫，并在两种 fix 都 `captureSnapshot`。
- `lib/workflow/fix-lifecycle.js:391-428 runAbortFix`：**新增 git 分支的逐 fix snapshot restore**（当前仅 snapshot 分支 restore）。
- `captureSnapshot`/`restoreSnapshot` 的 `round` 入参仍可沿用 `currentRound`，但需注意它在 DIFF-OK→再 fix 路径不递增、会覆写同号快照——首个/后续判定**只看指纹信号**，快照号沿用现状即可（覆写的是上一份 pre-fix 体，回滚语义仍为"回到本次 fix 前"）。
- 无新增 manifest 字段（复用 `guardMode` + `initial`/`lastKnown` 指纹）、无新增状态、无新增 guard 函数。
- 新增测试：`guard=git` 完整跑 ≥2 次 fix 至 PASS，**且第二次 fix 走 `DIFF-OK→full-re-review→FAIL→begin-fix` 路径**（currentRound 仍为 1，验证不靠 round 判定）；该次 begin-fix 既不 `rollback-unavailable` 也不 `unexpected-worktree-change`；其间外部改目标 → 仍 `externally-changed`；改**非目标**文件 → 仍 `unexpected-worktree-change`；git abort 从逐 fix 快照还原；首个 fix 行为零变化（既有 git fixtures 全绿）。

**为什么 brute force 正确**：复用既有 `captureSnapshot`/`restoreSnapshot` 与既有 `initial`/`lastKnown` 指纹，不新建机制、不加状态、不加 manifest 字段。本质是"git 模式 = 首个 fix clean-HEAD 基线 + porcelain 非目标检测 + 逐 fix 快照锚点"，把 git 与 snapshot 两模式收敛到只差"非目标检测方法"。

**最脆弱前提**：git 用户接受"逐 fix 回滚锚点是 `.docs-review-fix` 下的体快照"而非纯 `git checkout`。缓解：首个 fix 仍要求 clean HEAD，HEAD 始终是整段会话的有效手动回滚点；逐 fix 快照是**附加**的更细锚点，不替代 git 历史。

**临时绕过（修复发布前用户即可用）**：① 改用 `guard=snapshot` 重跑（已发布、免疫）；② 提交第一轮修复后 `resume` 续修，每轮一次。

## 4. 关键决策

| ID | 决策 | 理由 |
|----|------|------|
| D1 | G1/G3 为 prompt/rubric-only（**刻意不加机器 schema 字段**，避开严格 parser）；G4 需 context-pack CLI 改动 + prompt；均零状态机 | 严格 parser（`semantic-parsers.js`/`reviewer-report.js`）拒绝新机器行，故 G1/G3 折进既有 DIFF-FAIL 与 `Summary:` 自由文本；G4 的 context pack 由 CLI 生成、必须落 CLI |
| D2 | G1 复用既有 `reopenDiffFailedIssues` 通道，不新增状态 | "未真正解决"本质就是一种 diff 失败，归入现成路径最小改动 |
| D3 | G2 用"语义复发检测 + fix-attempt 封顶兜底"双保险，不建 issue-graph | 启发式 + 确定性兜底足够；完整依赖图属过度设计；计数信号独立于 `currentRound`，覆盖 DIFF-OK→re-review→再 fix 路径 |
| D4 | G2 新状态 `stopped-no-progress` 走与 `stopped-with-deferrals` 同构的 finalize 分支 | 二者都是"非 PASS、可恢复、记录未解决项"，复用最大化 |
| D5 | G3 severity 锚只在 COMMON 定义一次，type rubric 引用不重复 | 避免四处漂移；COMMON 本就是所有类型的基底 |
| D6 | G4 改动提示 gate 在"会话内已有上一轮 fix"（`lastKnown != initial`，**非 `currentRound`**）且显式禁止窄化审查范围 | currentRound 在 DIFF-OK→再 fix 路径不递增（见 G5 Finding 1）；首个 review 保持精简；防止"定向"退化成"只看改动区" |
| D7 | fix-attempt 封顶本期写死默认 5，不引入 `max-fix-attempts=` token | 先验证收敛价值，token 化留待后续按需；遵守 smallest safe change；`currentRound` 仅保留现有 round/report/snapshot 命名语义 |
| D8 | G5 区分首个 fix（clean-HEAD 保护预存编辑）与后续 fix（指纹匹配 + 逐 fix 快照），判定用 `lastKnown != initial`（**非 `currentRound`**），不简单删 clean-HEAD | 直接放宽会让回滚抹掉用户预存未提交编辑；currentRound 不可靠（见 G5 Finding 1）；区分后 git 模式既能多 fix 又不降级安全 |
| D9 | G5 复用 `captureSnapshot`/`restoreSnapshot` 把 git 与 snapshot 锚点统一，仅保留 porcelain 非目标检测差异 | 不新建机制、不加状态/manifest 字段；git 模式独有价值（全仓非目标检测）保留 |

## 5. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| prompt 膨胀压低遵从度（reviewer 机械陈述覆盖面 / coordinator 机械判有效性而非真思考） | 中 | 每项控制在数行；覆盖陈述折进 `Summary:` 一句、用维度组非逐条散文；G4 提示仅在"已有上一轮 fix"时出现；新增断言只验"约束句存在"不验冗长 |
| G2 状态机改动引入回归 | 中 | 新状态同构复用 `stopped-with-deferrals` 分支；改动前后跑全量 `npm test`；新增端到端断言覆盖复发与封顶两条停机路径 |
| G1 有效性判定因 finding 含糊而失真 | 低 | 反向激励 reviewer 写具体 `why_it_matters`；判定失真最坏只是多一轮标准 DIFF-FAIL，仍收敛 |
| G4 定向提示诱导 reviewer 窄化审查 | 低 | 指令显式"仍须通读全文"；断言该约束句存在 |
| 宿主 LLM 原生能力才是真瓶颈，契约改动边际收益递减 | 中 | 本项目整体论点即"语义纪律靠 prompt"；若该论点对现有 rubric 成立，对本期三处薄弱点同样成立；G2 的确定性兜底不依赖宿主能力 |
| G5 改动破坏既有 git fixtures 断言（355+ 用例多基于 git 守卫首个-fix 路径） | 中 | 首个 fix 行为零变化（仍 clean-HEAD），改动只新增后续-fix 分支；改动前后跑全量 `npm test`；新增多-fix e2e 断言为净增 |
| G5 后续-fix 指纹校验误判正常 dirty 为 `externally-changed` | 低 | 复用 workflow 既有 `Last known content sha256` 比对逻辑，与现有 externally-changed 检测同源，不新增判定路径 |

## 6. 验证策略

- **既有测试全绿**为硬门槛：`npm test`（当前基线见 `package.json` 的 `node --test`）。G1/G3 prompt-only 不改既有断言；G4 新增的 context-pack 字段缺省 `null`，须确认既有 context-pack 断言不被破坏。
- **新增/调整测试**：
  - `test/shared-assets.test.js`：断言 rubric 含 severity 锚与各类型必查组、reviewer Instructions 要求在 `Summary:` 内陈述覆盖面、diff review prompt 要求逐 fix 有效性核对、G4 的"仍须通读全文"约束句存在、`stopped-no-progress` 出现在 core/SKILL/模板终态列表。
  - `test/reviewer-report.test.js` / `test/semantic-parsers.test.js`：确认 reviewer 输出仍**恰好** PASS 两行 / FAIL `Findings:`、diff review 仍只 DIFF-OK 两行 / DIFF-FAIL 三字段——G1/G3 **未新增任何机器行**（防回归断言）。
  - `test/context-triage.test.js`（或新增 context-pack 测试）：有上一轮 fix（`lastKnown != initial`）→ context pack 含 `changedSinceLastReview`；首个 review（`lastKnown == initial`）→ 字段为 `null`。
  - `test/workflow-state-v2.test.js` + `test/finalize-resume.test.js` + `test/semantic-parsers.test.js`：`stopped-no-progress` + `no-progress-detected` 在 manifest 校验、final-response 解析、resume/receipt 路径均合法，且 finalize 当 pause 处理。
  - 新增端到端断言（仿 `test/workflow-e2e.test.js`）：(a) 复发或 `fixAttemptCount` 超 5 → `stopped-no-progress`，且覆盖 `DIFF-OK→full-re-review→FAIL→begin-fix` 路径中 `currentRound` 仍为 1 但 attempt 递增；(b) 无效 fix → coordinator 产出**标准 DIFF-FAIL** → issue 回 `reopened`（无新机器字段）。
  - G5（仿 `test/workflow-e2e.test.js` / `test/fix-guard.test.js`）：`guard=git` 完整跑 ≥2 次 fix 至 PASS，**第二次 fix 走 `DIFF-OK→full-re-review→FAIL→begin-fix` 路径**（`currentRound` 仍为 1，验证不靠 round 判定）；该 begin-fix 既不 `rollback-unavailable` 也不 `unexpected-worktree-change`；其间外部改目标 → 仍 `externally-changed`；改**非目标**文件 → 仍 `unexpected-worktree-change`；git abort 从逐 fix 快照还原；**首个 fix 行为零变化**（既有 git fixtures 断言全绿）。
- **手动 smoke**：对一份故意"改不对"的 SPEC 跑一轮，确认 diff review 抓到无效 fix；对一份故意"反复震荡"的目标确认封顶 5 次后第 6 次 fix attempt 硬停；在 git 仓库里对一份需 ≥2 轮的 PLAN 跑 `guard=git`，确认第二轮不再阻塞。

## 7. 实施顺序（建议，获批后进入 review-fix-plan）

0. **G5**（git 多 fix 锚点修复）——**最高优先级**：默认路径正确性破损，先修。单独一批、单独 patch/minor 发布，跑全量回归 + 新增"DIFF-OK→再 fix"多轮 e2e。
1. **G1**（diff review 有效性 prompt 纪律）——最高质量杠杆、prompt-only、零 parser 改动，先验证收益。
2. **G3**（severity 锚 + `Summary:` 内覆盖陈述）——纯 rubric/prompt，与 G1 同批文本改动。
3. **G4**（re-review 回归提示）——**含 context-pack CLI 改动 + prompt**（非纯文本），可与 G1/G3 同批但需带 context-pack 测试。
4. **G2**（收敛守卫）——唯一碰状态机枚举全集（与 G5 不同处），单独一批、单独发布，跑全量回归。

G5 是 bug 修复，应**先于**质量增强发布（建议 `0.2.1`）；G1+G3 为 prompt-only、G4 含轻量 context-pack CLI 改动，三者可合并为一次"技能质量" minor（G4 部分非纯契约，需 context-pack 测试护栏）；G2 因新增终态枚举全集单独 minor 并在 CHANGELOG 标注。每步各跑 `node --test` 与 `npm pack --dry-run`。

## 8. 不在本次范围

- 不引入多 reviewer / 多视角并行审查（成本/复杂度不匹配当前用户量）。
- 不改 SPEC/PLAN/DESIGN/COMMON 四套 rubric 的**审查维度内容**，只加 severity 锚与覆盖维度组清单（写入 rubric、由 reviewer 折进 `Summary:`，**非机器行**）。
- 不改 isolation 模型、fingerprint guard、lock、**guard 模式选择语义**、manifest 既有字段语义。（G5 仅改 git 模式内部逐轮锚点/非目标检测，不改用户如何选 guard、不静默切换模式、不新增 manifest 字段。）
- G2 不做 `max-fix-attempts=` 用户 token（本期写死默认 5）。
- 不引入新外部依赖；不新增平台适配。
- 不改 reviewer / fixer / coordinator 的**角色边界**（reviewer 仍只读、fixer 仍只改 target、coordinator 仍是唯一 PASS 权威）。
