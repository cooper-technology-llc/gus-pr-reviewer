import { GusError } from "../errors.js";
import type { RepositorySource } from "../review/review-ports.js";
import type { BranchAdvice, ReviewSnapshot } from "../review/review-schema.js";
import type { GitStore } from "./git-command.js";
import { isObjectId } from "./repository-paths.js";
import { optionalCommit, type PinnedRepository } from "./repository-storage.js";

type ParentBranch = NonNullable<RepositorySource["parent"]>;

/** Separates the branch's own contribution from its target's prospective merge result. */
export async function buildBranchSnapshot(
  repository: PinnedRepository,
  source: RepositorySource,
): Promise<ReviewSnapshot> {
  const { store, baseSha, headSha, defaultSha } = repository;
  const advisories: BranchAdvice[] = [];
  const mergeBaseSha = await mergeBase(store, baseSha, headSha);
  const parent = await chooseParent(
    repository,
    source,
    mergeBaseSha,
    advisories,
  );
  const comparisonBaseSha =
    parent === null
      ? mergeBaseSha
      : await mergeBase(store, parent.sha, headSha);
  const targetSha =
    parent?.merged === true && defaultSha !== null ? defaultSha : baseSha;
  await describeParent(
    repository,
    source,
    parent,
    comparisonBaseSha,
    advisories,
  );
  const integration = await inspectIntegration(store, targetSha, headSha);
  if (integration.status === "conflict") {
    advisories.push({
      code: "merge-conflict",
      message:
        "Resolve this branch's conflicts with its current target before merging.",
      evidence: `Git merge-tree reported conflicts between ${targetSha} and ${headSha}${integration.conflicts.length === 0 ? "." : ` in ${integration.conflicts.join(", ")}.`}`,
      action: "resolve-conflicts",
    });
  }
  const historyRewritten = await detectHistoryRewrite(
    store,
    source.previousHeadSha,
    headSha,
    advisories,
  );
  const baseChanged =
    source.previousBaseSha !== undefined && source.previousBaseSha !== baseSha;
  if (baseChanged) {
    advisories.push({
      code: "base-changed",
      message:
        "The target snapshot changed since the previous review; previous findings require fresh evidence.",
      evidence: `Previous base ${source.previousBaseSha}; current base ${baseSha}.`,
      action: "none",
    });
  }
  return {
    baseSha,
    headSha,
    mergeBaseSha,
    comparisonBaseSha,
    baseRef: source.baseRef ?? source.base,
    headRef: source.headRef ?? source.head,
    defaultBranch: repository.defaultBranch,
    defaultSha,
    parent,
    integration,
    historyRewritten,
    baseChanged,
    advisories,
  };
}

async function chooseParent(
  repository: PinnedRepository,
  source: RepositorySource,
  mergeBaseSha: string,
  advisories: BranchAdvice[],
): Promise<ParentBranch | null> {
  if (repository.parent !== null && repository.parent !== undefined)
    return repository.parent;
  const matchingParents = repository.candidates.filter(
    (candidate) =>
      candidate.ref === source.baseRef &&
      candidate.ref !== repository.defaultBranch,
  );
  const declaredParent =
    matchingParents.find((candidate) => candidate.sha === repository.baseSha) ??
    (matchingParents.length === 1 ? matchingParents[0] : undefined);
  if (declaredParent !== undefined) return declaredParent;
  const possible: ParentBranch[] = [];
  for (const candidate of repository.candidates) {
    if (candidate.sha === repository.headSha || candidate.sha === mergeBaseSha)
      continue;
    if (
      !(await isAncestor(repository.store, candidate.sha, repository.headSha))
    )
      continue;
    if (await isAncestor(repository.store, candidate.sha, repository.baseSha))
      continue;
    if (
      !possible.some(
        (parent) =>
          parent.sha === candidate.sha && parent.ref === candidate.ref,
      )
    )
      possible.push(candidate);
  }
  const nearest: ParentBranch[] = [];
  for (const candidate of possible) {
    let superseded = false;
    for (const other of possible) {
      if (
        candidate.sha !== other.sha &&
        (await isAncestor(repository.store, candidate.sha, other.sha))
      )
        superseded = true;
    }
    if (!superseded) nearest.push(candidate);
  }
  if (nearest.length === 1) return nearest[0] ?? null;
  if (nearest.length > 1) {
    advisories.push({
      code: "ambiguous-stack-parent",
      message:
        "Multiple incomparable parent branches are contained in this head. Specify the stack parent to isolate this PR's contribution.",
      evidence: nearest
        .map((parent) => `${parent.ref} at ${parent.sha}`)
        .join("; "),
      action: "inspect-stack",
    });
  }
  return null;
}

async function describeParent(
  repository: PinnedRepository,
  source: RepositorySource,
  parent: ParentBranch | null,
  comparisonBaseSha: string,
  advisories: BranchAdvice[],
): Promise<void> {
  if (parent === null) return;
  if (parent.merged) {
    advisories.push({
      code: "merged-stack-parent",
      message:
        repository.defaultBranch === ""
          ? `The stack parent ${parent.ref} is merged. Confirm the repository's current target branch, then update this branch and retarget the PR if necessary.`
          : `The stack parent ${parent.ref} is merged. Update this branch onto the current ${repository.defaultBranch} and retarget the PR if necessary.`,
      evidence: `Parent ${parent.pullRequest === null ? parent.ref : `PR #${parent.pullRequest}`} was reported merged at ${parent.sha}; contribution is compared with ${comparisonBaseSha}. A squash or rebase merge can change commit identities, so this does not prove every inherited change is already equivalent.`,
      action: "update-branch",
    });
    return;
  }
  if (comparisonBaseSha !== parent.sha) {
    advisories.push({
      code: "stack-parent-advanced",
      message: `The parent branch ${parent.ref} changed after this branch split. Update from the parent using your repository's stack workflow before final integration review.`,
      evidence: `Parent tip ${parent.sha}; shared parent/head ancestor ${comparisonBaseSha}. Only the child contribution is reviewed against that ancestor.`,
      action: "update-branch",
    });
  }
  const baseRef = source.baseRef ?? source.base;
  if (
    baseRef !== parent.ref &&
    repository.baseSha !== parent.sha &&
    !(await isAncestor(repository.store, parent.sha, repository.baseSha))
  ) {
    advisories.push({
      code: "stack-target-mismatch",
      message: `This branch contains the unmerged parent ${parent.ref}. Target that parent PR branch while the stack is open, or explicitly confirm that the combined stack is intended.`,
      evidence: `The contribution baseline is ${comparisonBaseSha}; the PR currently targets ${baseRef} at ${repository.baseSha}.`,
      action: "retarget",
    });
  }
}

async function inspectIntegration(
  store: GitStore,
  targetSha: string,
  headSha: string,
): Promise<ReviewSnapshot["integration"]> {
  try {
    const output = await store.command(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        targetSha,
        headSha,
      ],
      { allowedExitCodes: [0, 1], maxBytes: 4 * 1024 * 1024 },
    );
    const fields = output.stdout.toString("utf8").split("\0");
    const treeSha = fields.shift()?.trim() ?? "";
    if (!isObjectId(treeSha))
      throw new GusError("GIT_FAILED", "Git merge-tree returned no tree ID.");
    const conflicts: string[] = [];
    for (const path of fields) {
      if (path.length === 0) break;
      conflicts.push(path);
    }
    return {
      status: output.exitCode === 0 ? "clean" : "conflict",
      treeSha,
      targetSha,
      conflicts,
      explanation:
        output.exitCode === 0
          ? "Git produced a clean prospective merge tree in isolated storage. This is source integration evidence, not executed tests or deployment proof."
          : "Git reported merge conflicts. The integration tree can contain conflict markers and must not be treated as runnable or correct.",
    };
  } catch (error) {
    if (
      !(error instanceof GusError) ||
      error.code === "ABORTED" ||
      error.code === "BUDGET_EXCEEDED"
    )
      throw error;
    return {
      status: "unavailable",
      treeSha: null,
      targetSha,
      conflicts: [],
      explanation:
        "The installed Git could not construct an isolated merge tree. Git 2.38 or newer with merge-tree --write-tree is required; no integration conclusion is available.",
    };
  }
}

async function detectHistoryRewrite(
  store: GitStore,
  previousSha: string | undefined,
  headSha: string,
  advisories: BranchAdvice[],
): Promise<boolean> {
  if (previousSha === undefined || previousSha === headSha) return false;
  const previous = await optionalCommit(store, previousSha);
  if (previous !== null && (await isAncestor(store, previous, headSha)))
    return false;
  advisories.push({
    code:
      previous === null ? "previous-history-unavailable" : "history-rewritten",
    message:
      previous === null
        ? "The previous reviewed commit is unavailable. Treat review history as discontinuous and revalidate prior findings from the current snapshots."
        : "The branch history was rewritten. Revalidate prior findings against the current contribution instead of interpreting the old-to-new tree diff as newly authored changes.",
    evidence:
      previous === null
        ? `Previous commit ${previousSha} is not in the imported history.`
        : `${previousSha} is not an ancestor of ${headSha}.`,
    action: "none",
  });
  return true;
}

async function mergeBase(
  store: GitStore,
  left: string,
  right: string,
): Promise<string> {
  const output = await store.command(["merge-base", "--all", left, right], {
    maxBytes: 4096,
  });
  const bases = output.stdout.toString("utf8").trim().split("\n");
  const base = bases[0];
  if (bases.length !== 1 || base === undefined || !isObjectId(base)) {
    throw new GusError(
      "SNAPSHOT_UNAVAILABLE",
      "A unique merge base could not be determined; do not guess the PR contribution for unrelated or criss-cross history.",
    );
  }
  return base;
}

async function isAncestor(
  store: GitStore,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const output = await store.command(
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { allowedExitCodes: [0, 1], maxBytes: 4096 },
  );
  return output.exitCode === 0;
}
