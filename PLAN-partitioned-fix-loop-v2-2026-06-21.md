# Plan — partitioned fix loop v2

> 本期一个交付，两部分：**Part 1 = Plan B（增量修复闭环）** → **Part 2 = P2（oversize 单文件分块审查）**。
> 分支 `feat/partitioned-fix-loop-v2`，源自 `main@a3d9ba4`。
> 来源：`design/OPTIMIZATION-2026-06-20-partitioned-code-review.md` §12.2（Plan B）+ 审查项「oversize 仍是 coverage blocker」（P2，§8 预留出口）。
> 状态：**方向已批准（2026-06-21 [USER]）**。批准实现前不写代码（`/think` 纪律）。

---

## 0. TL;DR

让 over-cap partitioned project review 从「只读 + 易被卡死」走向「可增量修复 + 超大文件可覆盖」：

- **Part 1 / Plan B**：`aggregate FAIL → triage → begin-fix → fix → end-fix → 增量重审受影响 unit → re-aggregate → earned PASS`。核心杠杆：在 end-fix 已验证 route-owned 的窗口固化新 inventory 指纹，复用 `nextUnit` resume + review cache，**删受影响 unit 的 summary/findings = 标记待重审**。取代 v1（②′）的只读守卫。
- **Part 2 / P2**：把 `> MAX_UNIT_BYTES` 的单文件按**行窗口 + 重叠**确定性切成 chunk-as-sub-unit，逐段 bounded review，全段 none → 文件级 none。让「一个大文件拖死全项目 PASS」可解，PASS 仍守恒。

**顺序原因**：P2 依赖 Plan B 的 `refreshPartitionPlanContent` / membership 原语，故排在 Plan B 之后。

---

## 1. 本期范围与顺序

| | 内容 | 取代/否定 |
|---|---|---|
| Part 1 | Plan B 增量修复闭环 | 撤销 v1（②′）的 begin-fix 只读守卫 |
| Part 2 | P2 oversize 分块审查 | 兑现 design §8「文件内分块审查」预留出口 |

**design §12.2 的待办 ①（record-triage 只读守卫）作废**：① 是「强化只读」，与 Plan B「打开 fix」对立；做 Plan B 即移除只读边界，① 无意义。

---

## 2. Building / Not building

### Building
- **Plan B**：partitioned `end-fix` 增量出口（重算 inventory、刷新 `units.json` 内容指纹、失效受影响 unit + 全 backstop 的 summary、回 unit-review）；`finalize` 对 partitioned fix-round 的验证特判；撤销 ②′ 只读守卫并回改文档/fixtures。
- **P2**：`assemblePartitionPlan` 在 `partitionInventory` 产出的 oversize 独占 unit 上调用 `splitOversizeFile(...)`，把文本 oversize 文件确定性展开为 chunk-unit；`partitionInventory` 本身保持纯分桶/metadata-only。每 chunk 独立 coverage receipt，全 none → 文件级 none；aggregate 在文件级聚合 chunk 覆盖。

### Not building（范围外，触发即 block + reset，退回前一状态；绝不假 PASS）
- fix **增删** file-set 成员文件（只支持改现有文件内容）。
- fix 导致**分桶失效**（某 unit 越 `unitByteBudget`、单文件 oversize 翻转）。
- P2 的**语义级切分**（按 AST/函数边界）——v1 用行窗口，避免 §11 重依赖红线。
- 跨 chunk 全局推理重建、超大二进制/非文本文件审查。
- 跨 target-key 增量、并发多 target。

---

# Part 1 — Plan B：partitioned 增量修复闭环

## P1.1 核心机制（codegraph 核实）

| 计算 | 位置 | 输入 | fix 改 unit-001 成员后 |
|---|---|---|---|
| `computeProjectReviewFingerprint` | `lib/target-context.js:721` | 全 inventory 的 `{path,contentId}` 有序 sha256 | **变**（项目级 drift token） |
| `computeMemberDigest` | `lib/project-review.js:102` | 仅该 unit 成员的 `contentId` 串接 sha256 | 仅 unit-001 **变**，其余不变 |
| `reviewCacheKey` | `lib/project-review.js:307` | memberDigest+rules+suggestedRefs+extraReads | 仅 member/引用命中者变 |

**受影响集** = `unitsToReReview(changedFiles, units, summaries)`（`lib/workflow/file-set-unit-review.js:548`）∪ refs path set 变化的 unit。显式四路：(a) changed-member ∪ (b) suggestedRef-hit ∪ (c) stored-extraRead-hit ∪ (d) refsChangedUnitIds。`member_digest` 与 refs path set 均不变，才能保证未受影响 unit 的旧 summary 仍成立。

**安全基石（最关键支点）**：`end-fix` 在 guard 链之后才固化新指纹——`lib/workflow/file-set-fix.js:800` 已校验 `actualChanged === declaredFiles ⊆ monitoredSet`，**已证明** worktree 变化 = 声明的、in-set 的 route-owned fix。故「重算指纹 = 仅含 route-owned fix 的新基线」。partitioned 增量只能、也必须挂在 end-fix 这个唯一「已证明 route-owned」时点；之后任何新外部修改会让 live ≠ plan 指纹，重新 drift-block —— route-owned 与外部修改由此天然区分。

## P1.2 状态机

```
 start(over-cap, review-and-fix) ── 写 units.json(fp F0), mode=review-and-fix
        ▼
 [unit-review 循环] ─nextUnit 游标─► record-review(unit) ─► all-units-reviewed
        ▼                                                        ▼
 record-review(backstops ×7) ───────────────────────────► aggregate-review
                           ┌──────────────────────────────────────┤
                           ▼ PASS                                  ▼ FAIL
                    full-re-review ► finalize=pass     record-triage ► begin-fix
                                                                    │ (active plan 现放行)
                                                                    ▼  [fix] ► end-fix
       ┌─────────────────────────────────────────────────────────────┤
       ▼ membership 变 / 越 budget（范围外）                            ▼ 改内容（范围内）
  block: state-validation-failed                       重算 inventory(F1)
  nextAction: reset & rerun full partition             refreshPartitionPlanContent → 写 units.json(F1)
                                                        删 affected summaries/findings + 全 backstop summaries/findings
                                                        manifest: status=checkpoint / phase=review / fp=F1（与 start 一致）
                                                                    └─► 回 [unit-review 循环]
                                                                        (nextUnit 命中被删 summary 或 cache-key 失效的 unit + backstops)
```
三组件交换数据：`end-fix`(file-set-fix) ↔ `units.json`(project-review IO) ↔ `unit-review/aggregate`(partitioned-review)。无环。

## P1.3 实现步骤（**Part 1 内部**链不可分割，作为一个 mergeable 单元；Part 1/Part 2 仍是 §G.3 的两个独立合并点；括号为可独立 RED 测子单元）

1. **（原语，可独立 TDD）`refreshPartitionPlanContent(oldPlan, newInventory)`**（`lib/project-review.js`，紧邻 `partitionInventory`）：
   - 文件级成员校验：`oldPlan` 展平后的文件路径去重集合（普通 unit 的 `files[].path` + P2 chunk unit 的父文件 path）须与 `newInventory.path` 集合完全一致；新增/删除成员 → `ERR_PARTITION_MEMBERSHIP_CHANGED`。
   - 单元稳定性校验：非 chunk unit 的自身 `files[].path` 集合必须保持不变，不做跨 unit 重分桶；P2 chunk unit 用 `{path, chunkIndex, primaryLineRange, contextLineRange, sourceContentId}` 作为 chunk 身份，不把单个 chunk 的 path 集合拿去和全 inventory 比。
   - 刷新普通 unit 的 `files[].contentId/size`、重算 `member_digest`、刷新 `suggestedRefs`、重算顶层 `projectReviewFingerprint`。
     - **refs 拓扑不可偷懒**：`suggestedRefs` 的 path set 不能只沿用旧值刷新 `contentId`。end-fix 调用方必须用同一套 `readMemberTextForRefs` / `suggestRefsFor` 逻辑在新 inventory 上重算非 chunk unit 的 refs（至少重算 changed-member unit；实现若成本可接受，重算全部普通 unit 更简单安全）。若某 unit 的 refs path set 发生变化，该 unit 必须进入 affected；若 refs 重算失败或发现非 changed unit 的 refs path set 异常漂移，按 `ERR_PARTITION_REFS_CHANGED` / `state-validation-failed` block+reset，绝不复用旧 summary。
     - 因 refs 重算需要读文件正文，保持 `refreshPartitionPlanContent` 的核心校验/刷新逻辑纯函数：调用方传入 `nextSuggestedRefsByUnit`（或等价结构），纯函数只做 membership/digest/fingerprint 校验与替换；不得在纯函数内部直接 IO。
     - **返回契约**：纯函数返回 `{ refreshedPlan, refsChangedUnitIds }`。`refsChangedUnitIds` = 纯函数比较每个非 chunk unit 的 `oldPlan.suggestedRefs` path set 与 `nextSuggestedRefsByUnit` 得出的「refs 拓扑已变」unit 集 —— 步骤 2 ④ 直接消费它，不在 end-fix 侧另算。
   - P2 chunk 兼容：父文件 `sourceContentId` 未变时保留或重算 chunk `contentId/size/member_digest`，不得用文件级 `newInventory.contentId` 覆盖 chunk `contentId`；父文件 `sourceContentId` 已变时 v1 默认抛 `ERR_PARTITION_MEMBERSHIP_CHANGED` 并要求 reset（除非 P2 显式实现重切分支）。
     - **命名注**：此处「父文件内容变需重切」并非成员集变化，复用 `ERR_PARTITION_MEMBERSHIP_CHANGED` 只为 v1 收敛到 reset；实现可改用更贴切的 `ERR_PARTITION_OVERSIZE_RESPLIT_REQUIRED`，行为相同（均 → `endFixBlocked('state-validation-failed')`）。
   - 分桶合法性：任一 unit `member_bytes > unitByteBudget` 或单文件 oversize 翻转 → 抛 `ERR_PARTITION_REBUCKET_REQUIRED`。纯函数无 IO（refs 正文读取由调用方完成）。
2. **`end-fix` 出口分叉（partitioned / 非 partitioned）**（`file-set-fix.js` `runEndFix`）：现有 end-fix 是**单一 diff-review 出口**——删除 815–833 的 `partitionedPlanFreshness` 调用与 stale block；846–866 的 `status:'diff-review'` 转移仅留给非 partitioned。在 declaredFiles 验证后（813 之后）按 `readActivePartitionedPlan` 分叉：
   - **非 partitioned**：现有 diff-review 出口**字节不变**。
   - **partitioned 增量**（自算，**不复用** 835 `resolveLiveFileSet` / 849 `liveFileSetFingerprint`，避免二次 resolve）：① 用 manifest 记录的 `normalizedScopes` / `.drfxignore` digest 口径调用 `resolveCodeInventory`，重算得新 inventory + 指纹 F1；不得落回 whole-root 默认 scope，否则 scoped review 会误判 membership/fingerprint → ② 用新 inventory 重算/刷新 refs，`{ refreshedPlan, refsChangedUnitIds } = refreshPartitionPlanContent(oldPlan, inv, nextSuggestedRefsByUnit)`（抛 `ERR_PARTITION_MEMBERSHIP_CHANGED` / `ERR_PARTITION_REBUCKET_REQUIRED` / `ERR_PARTITION_REFS_CHANGED` → `endFixBlocked('state-validation-failed', reset 指引)`）→ ③ 写回 `units.json` → ④ `affected = unitsToReReview(declaredFiles, oldPlan, targetStateDir) ∪ unitsToReReview(declaredFiles, refreshedPlan, targetStateDir) ∪ refsChangedUnitIds`，删 affected 的 `summaries/<id>.json`+`findings/<id>.json` 与**全部** `summaries/backstop-*.json` / `findings/backstop-*.json` → ⑤ manifest `status:'checkpoint', currentPhase:'review', fileSetFingerprint:F1`（**与 partitioned start 一致**，start.js:233-234 即如此：`checkpoint` 是非 active 的「暂停/待继续」状态，partitioned 待审全程用它；**`currentPhase:'unit-review'` 非法**——`unit-review` 只是 CLI `--phase` 参数，不在 `PHASE_VALUES`，且 active status `review` 按 `ACTIVE_STATUS_PHASES` 必配 `currentPhase:'review'`），nextAction 指 `context --phase unit-review` → ⑥ 沿用 ledger 更新 + fix receipt。
   - **backstop 全删的代价（acknowledge）**：每轮 fix 重审全部 7 个 backstop（保守：内容一变 cross-unit 推理即失效）。多轮 fix 时成本累积，v1 接受换取安全；若实测过重，v2 再按 `spannedUnitIds ∩ affected` 收窄。
   - **多轮 fix 计数**：增量回 review 后 aggregate 若再 FAIL → triage → begin-fix（`fixAttemptCount` 由 begin-fix 递增，cap 5 仍生效；end-fix 增量出口**不重置**计数）。**增量出口不改 `currentRound`**：多轮 fix 的 fix report 与 aggregate-PASS 写的 full-review report 始终同一 `currentRound`，故 §5 的 finalize round 匹配在多轮下仍成立。
3. **`begin-fix` 撤销只读守卫**（`runBeginFix`）：移除 ②′ 的 `readActivePartitionedPlan` 拒绝块。
4. **aggregate / 文档回改**：`partitioned-review.js:526` FAIL nextAction 改回承诺 triage→begin-fix；`generator.js` step 6 + `route-contract.code.{claude,codex}.md` phase 3 改回「aggregate + fix + earned PASS」+「fix 后只增量重审受影响 unit + backstops」，同步 fixtures（byte-for-byte）。
5. **`finalize` fix-round 特判**（`file-set-finalize.js` `buildFileSetFinalValidationState`）：现有 `requiredDiffReviewComplete = !hasFixRound ? true : (diffReport && DIFF-OK)`。partitioned 增量 fix 走 unit-review→aggregate→full-re-review、**无 diff-review**，但 aggregate PASS 已触发 `recordAggregatePassAsFullReview` → 现有 `requiredFullReReviewComplete` 满足。
   - **确定形式（已定，避免过度设计）**：partitioned（active units.json）且 `hasFixRound` 时，`requiredDiffReviewComplete = true`（跳过 diff-review），**依赖现有 `requiredFullReReviewComplete` 作为等价保证** —— 增量 unit-review + aggregate 覆盖证明就是 partitioned 版的 diff-review。**不新读 `aggregate.json`**（`buildFileSetFinalValidationState` 当前不读它，保持不读）。
   - 必测：partitioned 增量 fix → full-re-review PASS → `finalize=pass`；read-only/advisory/stale 仍非 PASS；**非 partitioned fix round 仍要求 diff-review（不回归）**。
6. **`design §12` 更新**：标注 Plan B 已实现、begin-fix 只读守卫已移除、① 作废。

## P1.4 最脆弱假设（premise collapse）

**假设**：end-fix 时 worktree 变化 = 已验证 route-owned fix，且 fix 只改内容、不增删成员、不破坏分桶；refs 拓扑变化能被重算后纳入 affected 或 block+reset。
- 成立 → 重算指纹可安全固化为新 plan 基线。
- 不成立（增删/越 budget）→ `refreshPartitionPlanContent` 抛错 → `endFixBlocked` + reset。**变形承接**：范围外退回 v1 行为（block + 手动 rerun），不假 PASS。
- **load-bearing 检验**：若「只改内容」太窄（真实 fix 常增删），价值打折——多数 review-fix 改现有文件，增删退回 reset 可接受；若上线观测频繁增删，再评估 v2.1 局部重分桶。

## P1.5 撤销 ②′ 只读守卫（review 对照）

| ②′ 行为（commit `fade844`） | Plan B 处理 |
|---|---|
| begin-fix 拒绝 active partitioned | 移除（步骤 3） |
| aggregate FAIL nextAction 不承诺 begin-fix | 改回承诺 triage→begin-fix（步骤 4） |
| route-contract phase 3 / step 6 去掉「fix」 | 改回含 fix + 增量说明（步骤 4） |
| end-fix freshness gate = block backstop | 改为增量触发器（步骤 2） |
| design §12 记「只读 v1」 | 更新为「Plan B 已实现」（步骤 6） |

---

# Part 2 — P2：oversize 单文件分块审查（接在 Plan B 之后）

## P2.0 审查结论（已用代码核实）

**不是 bug，是有意设计的诚实 coverage blocker**（design §8 预留出口）：

| 环节 | 位置 | 行为 |
|---|---|---|
| 分桶 | `lib/project-review.js:139` | `size > MAX_UNIT_BYTES`(1MB) → 独占 bin、`oversize_file:true` |
| 取上下文 | `lib/workflow/file-set-unit-review.js:264` | oversize body **永不加载**，强制 `oversize:true, coverageRisk:'high'` |
| 记录 | `file-set-unit-review.js:378` | CLI **强制** `reviewed:false, coverage_risk:high, skipped_reason:'single-file-over-budget'` + `coverageBlocker:true` high finding |
| 聚合 | `partitioned-review.js` | oversize 永远 high → `uncoveredUnitIds` → `stopped-with-deferrals` + `coverage-incomplete`，绝不 PASS |

## P2.1 问题与价值

项目里只要有 1 个 >1MB 单文件（生成代码/数据/超长模块），整个 over-cap 项目就永远 `coverage-incomplete`、拿不到 PASS——即使其余几百文件全 none。P2 让超大文件**可被分块覆盖**，同时守住「PASS is earned」。现有 `.drfxignore`/`scope=` 规避手段保留；P2 是在不排除前提下让它可审。

## P2.2 推荐方案：行窗口分块 + chunk-as-sub-unit（已定 v1）

- **切分（行 + 字节双约束）**：oversize 文件按窗口切分——一窗到 `CHUNK_LINES` 行**或** ~`MAX_UNIT_BYTES` 字节（**先到先断**），相邻窗 `CHUNK_OVERLAP_LINES` 行重叠（避免切断定义后两段都看不全）。**字节上限是硬约束，且按 `contextLineRange` 的 UTF-8 字节数计算**：primary + overlap 的实际切片必须 `<= chunkByteBudget`，防止 minified/压缩长行文件或 overlap 扩张后仍 oversize。确定性策略：先确定 primary window，再在不超 budget 的前提下尽量加入前后 overlap；若 overlap 会超 budget，先缩 overlap，不缩 primary；若任一 primary 单行编码后 > `chunkByteBudget`，切无可切。每 chunk `chunkContentId = sha256(contextLineRange 切片文本)`，同输入同切分（确定性）。极端情形（任一单行编码后 > `chunkByteBudget`）**不生成 chunk**，保留 legacy `oversize_file:true` high blocker（诚实非 PASS），不递归、不字节切行。
- **切分入口 / IO 边界**：新增 `splitOversizeFile({ projectRoot, file, chunkLines, overlapLines, chunkByteBudget })`，只由已有 `assemblePartitionPlan({ inventory, projectReviewFingerprint, userExcludes, projectRoot })` 调用；`partitionInventory` 继续只接收 inventory、只做纯分桶。`splitOversizeFile` 只读取 in-root 文本文件正文，返回 chunk metadata（不持久化正文）；UTF-8/text validation 失败、二进制/非文本判断失败、或任一单行超 budget 均退回 `oversize_file:true` high blocker，不假装可覆盖。
- **双层口径（关键，否则 fingerprint 与 chunk 口径会打架）**：partitioned plan 维护两层——**文件级 inventory**（path + 文件级 contentId，喂 `computeProjectReviewFingerprint`，drift 检测口径**不变**）+ **chunk 级 units**（由 `assemblePartitionPlan` 展开切片）。oversize 文件在 inventory 仍是**一个文件 entry**，在 units.json 展开成 N 个 chunk-unit。`inventoryRows` 必须从文件级 inventory 生成（每个 source path 一行），不得从 `units[].files` 直接 flatten，否则 N 个 chunk 会把同一 path 重复写入 inventory rows 并破坏文件级身份口径；需要 flatten 时必须按 `sourcePath/path` 去重并保留文件级 `contentId`。
- **chunk-as-sub-unit schema**：每 chunk-unit
  `{ unit_id, oversize_chunk:true, sourcePath:path, sourceContentId:fileContentId, files:[{ path, primaryLineRange:[s,e], contextLineRange:[cs,ce], size:context切片字节, contentId:chunkContentId }], chunkIndex, chunkCount, member_digest: sha256(chunkContentId) }`。
  注意 `files[].path` 仍是**原文件路径**（N 个 chunk-unit 共享同一 path）。
  - `unitContext`：oversize_chunk unit 只加载 `contextLineRange` 切片正文，并标注「<path> 第 k/N 段，主体行 `primaryLineRange`，上下文行 `contextLineRange`，overlap 仅供理解、不作为重复 finding 主体」，走正常 bounded review。**需扩展 `buildFileSetContextPack` 支持按行切片加载**（现读整文件）——这是 P2 的主要新增机制点。
  - `recordUnitReview`：走**正常** receipt 路径（reviewed/coverage_risk 据实），不再固定 high。
  - **`unitsToReReview` 交互**：N 个 chunk-unit 共享 path，改该文件 → path 级**全命中**（全 chunk 重审）。这与「oversize-fix 走 membership/reset 边界」（§P2.4）一致——增量场景多数不触发 chunk-unit；即便触发，path 级全重审是安全保守值（cache 的 chunk 级 contentId 仍只对真正变化的 chunk 生效，不会误复用）。
  - aggregate / `nextUnit` resume：chunk 即 unit，走 **P1.2 同一状态机**，零特判。
- **为何 chunk-as-unit 而非 unit 内 chunk 循环**：前者复用现有 unitContext/recordUnitReview/aggregate/cache/resume，几乎零新机制；代价是 units.json schema 加 chunk 字段（向后兼容）。

## P2.3 关键决策

1. 切分 = **行 + 字节双约束**（一窗到 `CHUNK_LINES` 行或 ~`MAX_UNIT_BYTES` 字节，先到先断）；行对齐保证可读、不切断多字节字符，字节上限保证每个**已生成** chunk ≤ budget。若任一单行本身超 budget，文件不进入 chunk 路径，退回 legacy oversize high blocker。
2. 重叠 `CHUNK_OVERLAP_LINES` 行；reviewer 据「本段主体行」判，overlap 仅作上下文，不重复记 finding。P2 必须新增 chunk-aware finding normalization/dedup（稳定 key 至少包含 path + canonical `primaryLineRange` + issue class），不能假定现有 aggregate 已有去重；现有 full-object 去重不足以兜住 overlap 文案差异。**不新增 reviewer `category` 字段**，因为当前 `parseReviewerResult` 只接受固定字段；issue class 由协调器从现有字段（如 severity + normalized issue/suggested_fix 文本 hash，或显式内部 normalizedFindingKey）派生并写入 aggregate 内部结构，不要求 reviewer 输出新字段。
3. schema 扩展：unit 增可选 `oversize_chunk/sourcePath/sourceContentId/chunkIndex/chunkCount`，chunk member 增 `primaryLineRange/contextLineRange`；非 chunk unit 不变（向后兼容）。
4. **PASS 守恒**：文件级 none 当且仅当**每个** chunk-unit reviewed 且无 high；缺任一段 → 文件仍 blocker。
5. 单个超大函数 > 一窗：v1 接受被切断（overlap + 诚实标注），reviewer 可对该段标 high 触发诚实非 PASS；语义切留 v2。

## P2.4 与 Plan B 的交互（同期，故可一并处理）

- Plan B 的 `refreshPartitionPlanContent` 假设「成员集不变」。fix 一个 oversize 文件改变行数 → **重切 chunk → chunk 成员集可能变** → 命中 `ERR_PARTITION_MEMBERSHIP_CHANGED`。
- **v1 默认**：oversize 文件被 fix → 退回 block + reset（重跑完整 partition 重切 chunk）。诚实可接受边界。
- **混合项目默认**：只改普通文件且 oversize 父文件 `sourceContentId` 未变 → chunk metadata 保持有效；`refreshPartitionPlanContent` 只刷新普通 unit 与顶层 fingerprint。若 oversize 父文件变更，即使 chunk 数未变，v1 仍按 reset 处理，避免用文件级 contentId 覆盖 chunk contentId。
- **可选增强（因同期）**：P2 实现时可把「oversize chunk 重切」做成 `refreshPartitionPlanContent` 的**显式分支**（重切而非纯 reset）。v1 默认仍 reset，重切作为 P2 内可选增强。

## P2.5 最脆弱假设

**假设**：行窗口 + 重叠分块对超大文件能给可信逐段覆盖。
- 成立（生成/数据/顺序模块）→ 逐段读完即可信覆盖。
- 不成立（强耦合巨型逻辑、跨段强耦合）→ reviewer 对无法在本段内确认的属性据实标 `coverage_risk:high` → 文件级仍 blocker → 诚实非 PASS。**绝不**因「分了块」假装覆盖。

---

# 全局：测试 / 风险 / DoD / Handoff

## G.1 测试矩阵

**Part 1（Plan B）**
- Happy：aggregate FAIL → triage → begin-fix（放行）→ fix（改 unit-001）→ end-fix → 仅 unit-001 + backstops summary 被删、其余保留 → unit-review 只重审这些 → re-aggregate PASS → finalize=pass。
- Happy：fix 命中 unit-002 的 suggestedRef（指向 unit-001 文件）→ unit-001、unit-002 都进 affected。
- Error/范围外：fix 增删成员 → `ERR_PARTITION_MEMBERSHIP_CHANGED` → block+reset；越 budget/oversize 翻转 → `ERR_PARTITION_REBUCKET_REQUIRED` → block；end-fix 后外部修改 → guard 先拦；fix-attempt cap=5 仍生效。
- Edge：`refreshPartitionPlanContent` 纯函数（内容变→digest/fp 刷新且成员集稳定；refs 由调用方重算并注入；越 budget→错误）；fix 改 import/require path set → refsChanged unit 被重审或 block+reset，不复用旧 `suggestedRefs`；scoped CODE review 的增量 refresh 复用 manifest `normalizedScopes` / exclusions 口径，不落回 whole-root；未受影响 unit summary 在 re-aggregate 被采信；read-only/advisory/Gemini partitioned 仍不可进 fix loop；byte-for-byte 快照同步；finalize 对 partitioned fix round 不再误要求 diff-review，非 partitioned fix round 仍要求（不回归）。
- Edge：partitioned end-fix 增量出口写 `status:'checkpoint', currentPhase:'review'`（与 partitioned start 一致、合法 `PHASE_VALUES`/`ACTIVE_STATUS_PHASES`），`context --phase unit-review` 能继续；拒绝非法的 `currentPhase:'unit-review'`。
- Edge：P2 chunk unit 已存在但父文件未变时，普通文件 fix 不得破坏 chunk `contentId/size/member_digest`；父文件变更时必须 block+reset 或走显式重切分支。

**Part 2（P2）**
- Happy：over-cap 项目含 1 个可切分 oversize 文本文件 → 切 N chunk → 逐 chunk none → 文件级 none → 项目 earned PASS。
- Error：任一 chunk reviewed:false/high → 文件级 blocker → `coverage-incomplete`（不假 PASS）。
- Edge：切分确定性（同输入同 chunk 边界 + chunkContentId）；所有已生成 chunk 的 `contextLineRange` UTF-8 字节数 ≤ budget，overlap 超 budget 时确定性缩 overlap；chunk schema 向后兼容（非 chunk units.json 不破）；`inventoryRows` 对 oversize source path 仍一文件一行，不因 N 个 chunk 重复；UTF-8/text validation 失败、二进制/单行超 budget 退回 legacy oversize high；overlap finding 去重稳定且不要求 reviewer 输出 `category` 新字段；oversize 文件被 fix → 重切 → membership-changed → block+reset（或可选重切分支）。

## G.2 风险 / 回滚 / 规模

- **规模**：Part 1 ~8+ 文件（`file-set-fix`/`project-review`/`partitioned-review`/`file-set-finalize`/`generator`+4 fixtures+`design`+大测试）；Part 2 再 +5-7（多有重叠：`project-review` 切分+chunk schema、`file-set-unit-review` 的 oversize_chunk 分支、context-pack 切片注入、文档/fixtures、测试）。**本期 > 8 文件，已显式 acknowledge。**
- **最高风险**：Part 1 步骤 5 触碰 PASS 闸（`finalize`）——必须测出 partitioned 增量 fix **能** earned PASS 且 read-only/advisory/stale **仍非** PASS；P2 切分确定性 + chunk schema 向后兼容。
- **回滚**：全部 additive，藏在 partitioned + active-plan / `oversize_chunk` 分支后；单 target single-shot / 非 partitioned 零改动。**Part 1 与 Part 2 独立提交、独立可 revert**：Part 1 revert = 回 ②′ 只读；Part 2 revert = 回「oversize = 单 blocker」，互不影响。无数据迁移（sha256 命名空间不变）。

## G.3 Definition of Done（两个独立可合并 phase）

> **Phase 独立性（/think 红线）**：Part 1 与 Part 2 是**两个独立可合并点**。Part 1（Plan B）合并后 partitioned 已能增量 fix、系统**完整可用**；Part 2（P2）是其上的独立增量。**同期开发，但提交/合并粒度拆开**：Part 1 先成 mergeable 点，Part 2 后；若 P2 延期或卡住，**Part 1 可单独合并上线**。

- **Part 1 DoD（Plan B，独立合并）**：`npm test` + `npm run syntaxcheck` 全绿；over-cap partitioned 在「改内容」型 fix 下走通 `aggregate FAIL → fix → 增量重审 → re-aggregate → earned PASS`；增删/越 budget/refs 拓扑异常退回 block+reset；scoped CODE 增量 refresh 不漂移到 whole-root；read-only/advisory/stale 仍非 PASS；②′ 守卫与文档回改并 fixtures 同步。贴边测试：原语→`project-review.test.js`；end-fix 增量→`workflow-fileset-lifecycle.test.js`；CLI 全链→`cli-partitioned-review.test.js`；finalize→`workflow-fileset-lifecycle.test.js`；文档→`shared-assets.test.js`。
- **Part 2 DoD（P2，独立合并）**：含可切分 oversize 文本文件时分块审查可达 earned PASS；**所有已生成 chunk 的 context slice ≤ budget（行+字节双约束）**，单行超 budget 退回 legacy high blocker；`inventoryRows` 保持文件级一 path 一行；强耦合大文件仍可由 reviewer 标 high 触发诚实非 PASS；chunk schema 向后兼容（非 chunk units.json 不破），finding dedup 不要求 reviewer schema 新字段。贴边测试：切分→`project-review.test.js`；oversize_chunk lifecycle→`workflow-fileset-lifecycle.test.js`；CLI→`cli-partitioned-review.test.js`。

## G.4 Handoff

- **分支**：`feat/partitioned-fix-loop-v2`（已切，源 `main@a3d9ba4`）。
- **本文件位置**：repo 根（`design/`、`docs/` 均被 `.gitignore`，repo 根 `*.md` 不被忽略，故 plan 随分支走）。
- **实现顺序**：Part 1 步骤 1（`refreshPartitionPlanContent` + 测试）按 TDD 起步 → Part 1 全绿 → Part 2。P2 默认常量先固定为 `CHUNK_LINES=800` / `CHUNK_OVERLAP_LINES=40` / `chunkByteBudget=MAX_UNIT_BYTES`；真实 oversize 目标只用于后续性能校准，不阻塞本期实现。
- **验证命令**：`node --test test/project-review.test.js test/workflow-fileset-lifecycle.test.js test/cli-partitioned-review.test.js test/shared-assets.test.js` → 全绿后 `npm test` + `npm run syntaxcheck`。
- **后续**：本期两部分完成后 `/check`，再按收尾流程合并 main / 删分支。
