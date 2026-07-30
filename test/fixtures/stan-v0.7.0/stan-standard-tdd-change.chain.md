---
name: stan-standard-tdd-change
description: Backward-compatible explicit-assurance non-trivial coding flow with plan review, TDD gate, implementation, QA, and final diff review.
---

## stan-architect
phase: Plan
label: Plan scoped code change
as: plan
output: plan.md
progress: true

Use `plan-code-change` to create a concise plan with ACs, likely files, risks, TDD gate, validation, and open questions.

Task:
{task}

## stan-reviewer
phase: Plan review
label: Review plan before mutation
reads: plan.md
as: plan_review
output: plan-review.md
progress: true

Use `review-plan`. Consume supplied structured validation actions; do **not** run shell commands or validation under this read-only capability. Return PASS or BLOCKED with evidence and required fixes before any mutation.

Task:
{task}

Plan:
{outputs.plan}

## stan-test-engineer
phase: TDD gate
label: Write gate tests
reads: plan.md,plan-review.md
as: gate_tests
output: gate-tests.md
progress: true
acceptance: {"level":"checked","criteria":[{"id":"tdd-red-gate","must":"The focused regression test demonstrates the current defect before implementation.","evidence":["tests-added","commands-run"],"severity":"required","allowedCommandOutcomes":["expected-red","expected-failure"]}],"evidence":["tests-added","commands-run","residual-risks"]}

If plan review is `BLOCKED`, do not mutate; return `BLOCKED` with the required plan fixes. If plan review passed, use `write-gate-tests` to add/update tests first. Mutate only tests, fixtures, snapshots, or minimal test helpers unless explicitly authorized, run the selected gate command, and emit structured validation actions (actor, normalized command/evidence identity, duplicate/reference/reason).

Task:
{task}

Plan:
{outputs.plan}

Plan review:
{outputs.plan_review}

## stan-dev
phase: Implement
label: Implement approved plan
reads: plan.md,plan-review.md,gate-tests.md
as: implementation
output: implementation.md
progress: true

If plan review or gate tests are `BLOCKED`, do not mutate production code; return `BLOCKED` with the missing prerequisite. Otherwise use `implement-code-change` with one writer. Follow the approved plan and gate tests, run selected validation, and summarize changed files plus structured validation actions (actor, normalized command/evidence identity, duplicate/reference/reason).

Task:
{task}

Plan:
{outputs.plan}

Gate tests:
{outputs.gate_tests}

## stan-qa-evaluator
phase: QA
label: Validate implementation
reads: plan.md,gate-tests.md,implementation.md
as: qa
output: qa.md
progress: true

If implementation is `BLOCKED`, return `BLOCKED` with the unresolved prerequisite. Otherwise consume structured test/static validation actions and evaluate AC coverage, skipped checks, and regressions. As a read-only QA role, do **not** run shell commands or rerun validation; return `NEEDS-FOLLOWUP` when parent/test-engineer/dev must run a new command with an allowed reason. Return PASS or BLOCKED.

Task:
{task}

Implementation:
{outputs.implementation}

## stan-reviewer
phase: Final review
label: Final diff review
reads: plan.md,gate-tests.md,implementation.md,qa.md
as: final_review
output: final-review.md
progress: true

If QA is `BLOCKED`, return `BLOCKED` until fixes are applied. Otherwise use `review-diff-before-final`. Consume structured validation actions; confirm scope, AC coverage, evidence, and no accidental edits without running shell commands or duplicate validation. Return `NEEDS-FOLLOWUP` if parent/test-engineer/dev evidence is required. Return PASS or BLOCKED, and include a parent-facing reminder to run `refresh-project-state` before final handoff when material work changed state; do not write `.pi/state/current.md` from this read-only review step.

Task:
{task}

QA:
{outputs.qa}
