# Contributor instructions for AI agents

Read [the contribution workflow](docs/contributing.md) for commands and validation.
For interactive product work, default to edit → human tries the running app →
adjust in the agreed worktree. Do not gate each feedback round on E2E, native
builds, or full validation. `just iterate` is optional; reserve `just scan` for
an agreed batch before review/integration or relevant native/dependency/build
changes. Track deferred checks: **ready to try** is not **validated**. Check
auth/signing, persistence/migrations, protocol semantics, and destructive writes
before live use.

Files marked `FOUNDATION` require explicit human guidance before editing and
stricter review. Escalate needed changes rather than editing without authorization.

## Engineering standard

Before editing, state the intended outcome and non-goals. Read the owning code,
callers, and relevant design docs; preserve documented product decisions and
ownership boundaries. Resolve answerable questions from evidence; ask before
deviating from agreed scope or product behavior.

Target **9/10+ for minimalness, elegance, and correctness**: the smallest complete
solution, clear ownership, and no known material defects. Prefer existing patterns
and subtraction. No opportunistic refactors, speculative abstractions, or new
features disguised as fixes. Before expanding into another shared subsystem or
adding alternate-adapter support, show the human the scope change and smallest
complete alternative. Require a current caller or explicit approval for adapter
parity. Review necessity separately from correctness; passing tests do not justify
scope growth. Split at real ownership boundaries, not by deleting safety coverage.

Keep files cohesive and group modules and tests by owner. Treat size as a review
signal, not a quota. Extract stable boundaries only when they simplify the
requested change.

Minimal does not mean happy-path-only. Handle relevant boundary inputs, failures,
recovery, and lifecycle transitions; consider concurrency, persistence, security,
and performance where the change affects them. Do not add machinery for
hypothetical requirements.

Validate the affected user contract, not just isolated helpers. Add regression
coverage for changed behavior and relevant failure paths; exercise real integration
boundaries where practical. Follow the contribution workflow's iteration and batch
gates, rather than adding full validation to every edit.

Self-review before handoff; seek independent review for risky changes before
integration. Report what changed, evidence tied to the checked snapshot, and
remaining risks or deferred checks. Green CI is evidence, not proof of user behavior.

Keep reviews convergent: consolidate actionable findings and clear exit criteria.
Block on concrete correctness, security, or agreed-contract defects; unrelated
hardening is follow-up. Reopen scope only when new evidence warrants it.

## Commit attribution and DCO

Every PR commit requires `Signed-off-by`. Use `git commit --signoff` with your
verified effective `git config user.name` / `user.email`; stop if missing or
incorrect. Preserve actual authorship; requesting or reviewing work does not
justify substituting the human's identity or adding their sign-off.

DCO, cryptographic signing, and co-author credit are separate; hooks do not supply
DCO. Audit **every commit against the PR base**, including after rebases or
cherry-picks. Preserve valid trailers; add only certifications you can make.
After repairs, verify the hosted **DCO Check** at the new head.

## Before pushing

- Use the agreed feature worktree and pinned `bin/` tools. Follow
  [hook setup](docs/contributing.md#pre-commit-checks) once per worktree;
  preserve custom hooks and never bypass failures.
- Refresh remote refs; confirm destination, base, and head. Review `git status`,
  the full PR diff, and `git diff --check` against the base. Include only intended
  files: no credentials, local configuration, or raw agent/session data.
- Follow the [validation workflow](docs/contributing.md#interactive-product-iteration).
  Documentation-only changes need content, link, and diff checks, not source
  builds. Keep incomplete work in draft with deferred checks listed; hook success
  or a draft push does not establish validation.
- Push the actual PR head ref. Never rewrite others' commits; authorized rewrites
  require `--force-with-lease`. Verify the remote head matches reported checks.
- Inspect current hosted checks and repository rules, including external checks.
  Resolve relevant failures before declaring readiness; obtain required reviewer
  and code-owner approval. This preflight is not automatic permission to merge.
