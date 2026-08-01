# VPNCheap issue hub foundation

`VPNCheap 产品问题中心` is one user-owned GitHub Projects V2 view across the 12
governed repositories. The original repository issue is always the sole source of
truth: discussions, assignees, labels, linked code, and open/closed state are not
copied into a second issue.

Issue 标题、正文、分诊证据、关闭评论和隐私边界统一遵循
[`VPNCheap Issue 中文与分诊规范`](vpncheap-issue-language-and-triage-convention.md)。
Project README 保留该稳定入口，便于从 CEO 看板直接回到规范；原仓库 Issue
仍是唯一事实源。

## Deterministic contract

- Events only: `opened`, `reopened`, `transferred`, `closed`, `labeled`,
  `unlabeled`, `assigned`, and `unassigned`. There is no cron or LLM path.
- Pull requests are rejected from both the event envelope and the live GraphQL
  node type.
- Every run re-reads the live issue state and full labels by node ID before
  writing. Out-of-order events therefore converge on current GitHub truth.
- Every supported event for a live open issue fills missing repository-default
  taxonomy labels, including assigned/unassigned bootstrap or caller-late
  replay paths.
- Status precedence: live closed issue → `Done`; otherwise taxonomy conflict →
  `Needs info`; otherwise a new/status-less item → `Inbox`; a live open
  issue on any supported event moves stale `Done` → `Inbox`. Replayed events
  preserve every other existing Status.
- Unknown taxonomy values remain blank. `Runtime` and `Type` allow one known
  value; `Platform` and `Surface` may contain multiple known values. Actual
  cardinality conflicts add `taxonomy-conflict`.
- Linux is a governed platform label. Multi-platform intake repositories never
  default platform or surface; they keep only a defensible runtime default when
  the repository has one. This avoids labeling an unknown report as every
  supported platform.
- `Priority`, `Customer reports count`, and `Last report date` remain blank
  until a human supplies verified planning/customer evidence.
- `Repository`, `Assignees`, and `Labels` are GitHub built-ins. Status and
  Priority are Project fields only; reconciliation refuses duplicate
  `status:*`, `priority:*`, configured option names, or explicit legacy status
  aliases such as `needs-info`.

The complete field, view, label, repository-default, and status-option contract
is declarative in [`governance/issue-hub.json`](../governance/issue-hub.json).

## Foundation reconciliation

The CLI is read-only unless `--apply` is present. It searches by exact owner and
Project title before creating anything, fails on duplicate exact matches, retains
existing single-select option IDs, creates/updates the five saved views, and
reconciles the fixed labels in all 12 repositories without deleting unrelated
labels. It removes only GitHub's untouched auto-generated `View 1` (view number
1, table layout, blank filter) after all five governed views exist; any other
unmanaged view is preserved. It also removes the four known enabled workflows
GitHub creates by default, because auto-close/PR/status/sub-issue automations
would bypass the original-Issue and deterministic-status contract. Any unknown
enabled Project workflow fails reconciliation instead of being deleted.

```sh
GH_TOKEN="$TEAM_PAT" node scripts/issue-hub/reconcile.js
GH_TOKEN="$TEAM_PAT" node scripts/issue-hub/reconcile.js --apply --backfill
```

The token must authenticate as `fengqunX`. For this user-owned Project GitHub
requires a classic PAT with `project` and repository access; a repository
`GITHUB_TOKEN` is insufficient. Keep the PAT process-local. The CLI never prints
it. A failed sync never copies, moves, or closes the original issue. It can leave
some deterministic taxonomy-label changes applied if a later Project API call
fails; rerunning the same event/reconciliation converges the remaining state.

`--backfill` paginates every open issue, excludes pull requests, adds missing
items idempotently, applies repository defaults, and then applies the same live
state precedence as event runs. Rerun the same command after any partial failure.

## Caller workflow (land separately in each repository)

Callers must pin the reusable workflow to the full squash-merge commit SHA. The
called job checks out its own repository at GitHub's `job.workflow_sha`, so the
action code is cryptographically bound to the reviewed workflow revision. Do not
use a branch, tag, or broad `secrets: inherit`.

```yaml
name: Issue hub

on:
  issues:
    types: [opened, reopened, transferred, closed, labeled, unlabeled, assigned, unassigned]

permissions:
  contents: read

jobs:
  sync:
    uses: fengqunX/vpncheap-app/.github/workflows/issue-hub-sync-reusable.yml@FULL_40_CHARACTER_MERGE_SHA
    secrets:
      project_token: ${{ secrets.VPNCHEAP_PROJECT_TOKEN }}
```

The caller workflow must exist on that repository's default branch. The named
secret must contain the team PAT and authenticate exactly as `fengqunX`; the
action verifies this before any issue or Project write. The caller
`GITHUB_TOKEN` is read-only and permissions granted by the caller cannot be
elevated by the reusable workflow.

## Verification and recovery

```sh
node --test tests/issue-hub/*.test.js
actionlint .github/workflows/*.yml
```

CI covers deterministic precedence, taxonomy cardinality, live-state race
handling, PR exclusion, config invariants, and immutable workflow structure.
GitHub's API currently exposes view name/layout/filter/visible fields, but not a
documented grouping/sort mutation. The board layout is created by API; any manual
grouping preference is presentation-only and not part of synchronization
correctness.
