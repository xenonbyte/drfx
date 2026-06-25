# Workflow Run: WF-20260101-real-r2p-shape

<!--
  This fixture mirrors the ACTUAL r2p run.md serializer shape (status token +
  markdown-table Active Artifacts + the surrounding sections r2p emits),
  modeled on real r2p output with neutral content. It is the faithful-shape
  counterpart to the simplified bullet-list fixture in approved/run.md, and it
  is the regression anchor proving parseRunMdGate accepts real r2p output.
-->

## Status
closed_at_plan_checkpoint

## Current Stage
closed

## r2p Version
0.4.0

## Tier Lock
base: standard
modifiers:

## Tier Estimate
base: standard
modifiers:

## Approved Checkpoints
| Stage | Artifact | Version | Approved At | Downstream Authorization | Bundle ID |
|---|---|---|---|---|---|
| raw_requirement | 00-raw-requirement.md | 1 | 2026-01-01T00:00:00.000000+00:00 | requirement_brief |  |
| requirement_brief | 03-requirement-brief.md | 1 | 2026-01-01T00:00:00.000000+00:00 | risk_discovery |  |
| risk_discovery | 04-risk-discovery.md | 1 | 2026-01-01T00:00:00.000000+00:00 | design |  |
| design | 05-design.md | 1 | 2026-01-01T00:00:00.000000+00:00 | spec |  |
| spec | 06-spec.md | 1 | 2026-01-01T00:00:00.000000+00:00 | plan |  |
| plan | 07-plan.md | 1 | 2026-01-01T00:00:00.000000+00:00 | close_workflow_run |  |

## Bundle Authorizations
| Bundle ID | Stages | Authorized At | Revoked At | Consumed Stages |
|---|---|---|---|---|

## Active Artifacts
| Stage | Artifact | Version | Status |
|---|---|---|---|
| raw_requirement | 00-raw-requirement.md | 1 | approved |
| requirement_brief | 03-requirement-brief.md | 1 | approved |
| risk_discovery | 04-risk-discovery.md | 1 | approved |
| design | 05-design.md | 1 | approved |
| spec | 06-spec.md | 1 | approved |
| plan | 07-plan.md | 1 | approved |

## Stale / Superseded Artifacts
| Artifact | Reason | Replaced By | Required Action |
|---|---|---|---|

## Open Routes
| Route ID | From Stage | Owner Stage | Required Action | Status |
|---|---|---|---|---|

## User Confirmations
| Confirmation | Stage | Source | Recorded In |
|---|---|---|---|

## Resume Context
| Field | Value |
|---|---|
| Last Completed Operation | close_at_plan_checkpoint |
| Next Allowed Operation | run_close |
| Active Item | plan |
| Required Reread Targets |  |
| Resume Reason | plan checkpoint approved |

## Reopen Lineage
(none)
