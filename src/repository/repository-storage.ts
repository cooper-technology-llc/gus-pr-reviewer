import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GusError } from "../errors.js";
import type {
  RepositoryOptions,
  RepositorySource,
} from "../review/review-ports.js";
import { createGitStore, type GitStore } from "./git-command.js";
import {
  importLocalObjects,
  inspectLocalRepository,
} from "./local-object-import.js";
import { assertRevisionInput, isObjectId } from "./repository-paths.js";

export interface PinnedRepository {
  store: GitStore;
  baseSha: string;
  headSha: string;
  defaultSha: string | null;
  defaultBranch: string;
  parent: RepositorySource["parent"] | null;
  candidates: NonNullable<RepositorySource["parentCandidates"]>;
  omissions: string[];
}

/** Imports trusted transport objects into disposable storage and resolves each input exactly once. */
export async function createRepositoryStorage(
  source: RepositorySource,
  options: RepositoryOptions,
): Promise<PinnedRepository> {
  validateSource(source);
  const directory = await mkdtemp(join(tmpdir(), "gus-repository-"));
  const store = createGitStore(directory, options.signal);
  const omissions: string[] = [];
  try {
    if (source.path !== undefined) {
      const local = await inspectLocalRepository(source.path);
      await store.command([
        "init",
        "--quiet",
        "--bare",
        "--template=",
        `--object-format=${local.objectFormat}`,
        ".",
      ]);
      await importLocalObjects(local, directory, options.signal);
    } else {
      await store.command(["init", "--quiet", "--bare", "--template=", "."]);
      await importRemoteObjects(store, source, omissions);
    }
    const baseSha = await resolveCommit(
      store,
      source.path === undefined ? "refs/gus/base" : source.base,
    );
    const headSha = await resolveCommit(
      store,
      source.path === undefined ? "refs/gus/head" : source.head,
    );
    const defaultSnapshot = await resolveDefaultSnapshot(store, source);
    const { defaultSha, defaultBranch } = defaultSnapshot;
    if (defaultSha === null)
      omissions.push(
        "The default branch snapshot was unavailable; integration uses the pinned PR target.",
      );
    const parent =
      source.parent === undefined
        ? null
        : {
            ...source.parent,
            sha: await resolveCommit(
              store,
              source.path === undefined ? "refs/gus/parent" : source.parent.sha,
            ),
          };
    const candidates: PinnedRepository["candidates"] = [];
    const availableCommits = await candidateCommitInventory(
      store,
      source.parentCandidates ?? [],
    );
    for (const candidate of source.parentCandidates ?? []) {
      if (availableCommits.has(candidate.sha))
        candidates.push({ ...candidate });
      else if (candidate.ref === source.baseRef) {
        const sha = await optionalCommit(store, candidate.sha);
        if (sha === null)
          omissions.push(
            `The declared parent ${candidate.ref} could not be pinned and was not used.`,
          );
        else candidates.push({ ...candidate, sha });
      }
    }
    return {
      store,
      baseSha,
      headSha,
      defaultSha,
      defaultBranch,
      parent,
      candidates,
      omissions,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function resolveCommit(
  store: GitStore,
  revision: string,
): Promise<string> {
  assertRevisionInput(revision);
  const output = await store.command(
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    { maxBytes: 4096 },
  );
  const sha = output.stdout.toString("utf8").trim();
  if (!isObjectId(sha))
    throw new GusError(
      "SNAPSHOT_UNAVAILABLE",
      "Git did not return an immutable commit ID.",
    );
  return sha;
}

export async function optionalCommit(
  store: GitStore,
  revision: string,
): Promise<string | null> {
  try {
    return await resolveCommit(store, revision);
  } catch (error) {
    if (error instanceof GusError && error.code === "GIT_FAILED") return null;
    throw error;
  }
}

function validateSource(source: RepositorySource): void {
  if ((source.path === undefined) === (source.remoteUrl === undefined)) {
    throw new GusError(
      "INPUT_INVALID",
      "Provide exactly one local repository path or HTTPS remote URL.",
    );
  }
  for (const revision of [
    source.base,
    source.head,
    source.defaultBranch || undefined,
    source.defaultRef,
  ]) {
    if (revision !== undefined) assertRevisionInput(revision);
  }
  for (const sha of [source.previousHeadSha, source.previousBaseSha]) {
    if (sha !== undefined && !isObjectId(sha))
      throw new GusError(
        "INPUT_INVALID",
        "Previous snapshots and explicit parents require full commit SHAs.",
      );
  }
  if ((source.parentCandidates?.length ?? 0) > 5000)
    throw new GusError(
      "INPUT_INVALID",
      "Provide at most 5,000 possible stack parents.",
    );
  if (source.parent !== undefined) {
    assertRevisionInput(source.parent.ref);
    assertRevisionInput(source.parent.sha);
  }
  for (const parent of source.parentCandidates ?? []) {
    assertRevisionInput(parent.ref);
    if (!isObjectId(parent.sha))
      throw new GusError(
        "INPUT_INVALID",
        "Stack candidates require full commit SHAs.",
      );
  }
  for (const remote of [source.remoteUrl, source.headRemoteUrl]) {
    if (remote !== undefined) validateRemoteUrl(remote);
  }
  if (
    source.token !== undefined &&
    (source.token.length === 0 || /[\r\n\u0000]/.test(source.token))
  ) {
    throw new GusError(
      "INPUT_INVALID",
      "Invalid repository authentication token.",
    );
  }
  if (
    source.remoteUrl !== undefined &&
    source.headRemoteUrl !== undefined &&
    new URL(source.remoteUrl).origin !== new URL(source.headRemoteUrl).origin
  ) {
    throw new GusError(
      "INPUT_INVALID",
      "Head and base remotes must use the same HTTPS origin.",
    );
  }
}

function validateRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GusError(
      "INPUT_INVALID",
      "Repository remotes must be HTTPS URLs.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new GusError(
      "INPUT_INVALID",
      "Use an HTTPS clone URL without credentials, query parameters, or fragments.",
    );
  }
  return url;
}

async function importRemoteObjects(
  store: GitStore,
  source: RepositorySource,
  omissions: string[],
): Promise<void> {
  const remote = source.remoteUrl;
  if (remote === undefined)
    throw new GusError("INPUT_INVALID", "A remote URL is required.");
  await fetchRevision(store, source, remote, source.base, "base");
  await fetchRevision(
    store,
    source,
    source.headRemoteUrl ?? remote,
    source.head,
    "head",
  );
  const optionalRevisions = [
    ...((source.defaultRef ?? source.defaultBranch) === ""
      ? []
      : [
          {
            revision: source.defaultRef ?? source.defaultBranch,
            alias: "default",
          },
        ]),
    ...(source.previousHeadSha === undefined
      ? []
      : [{ revision: source.previousHeadSha, alias: "previous" }]),
    ...(source.parentCandidates ?? [])
      .filter((parent) => parent.ref === source.baseRef)
      .map((parent, index) => ({
        revision: parent.sha,
        alias: `declared-parent-${index}`,
      })),
  ];
  if (source.parent !== undefined)
    await fetchRevision(store, source, remote, source.parent.sha, "parent");
  for (const { revision, alias } of optionalRevisions) {
    if (alias !== "default" && (await optionalCommit(store, revision)) !== null)
      continue;
    try {
      await fetchRevision(store, source, remote, revision, alias);
    } catch (error) {
      if (!(error instanceof GusError) || error.code !== "GIT_FAILED")
        throw error;
      omissions.push(
        `Optional ${alias} history was not available from the remote.`,
      );
    }
  }
}

async function candidateCommitInventory(
  store: GitStore,
  candidates: PinnedRepository["candidates"],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set<string>();
  const output = await store.command(["rev-list", "--all"], {
    maxBytes: 16 * 1024 * 1024,
  });
  const candidateShas = new Set(candidates.map((candidate) => candidate.sha));
  const available = new Set<string>();
  for (const sha of output.stdout.toString("utf8").split("\n")) {
    if (candidateShas.has(sha)) available.add(sha);
  }
  return available;
}

async function resolveDefaultSnapshot(
  store: GitStore,
  source: RepositorySource,
): Promise<{ defaultSha: string | null; defaultBranch: string }> {
  if (source.defaultBranch !== "" || source.defaultRef !== undefined) {
    const ref =
      source.path === undefined
        ? "refs/gus/default"
        : (source.defaultRef ?? source.defaultBranch);
    return {
      defaultSha: await optionalCommit(store, ref),
      defaultBranch: source.defaultBranch || source.defaultRef || "",
    };
  }
  const output = await store.command(
    ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/"],
    { maxBytes: 1024 * 1024 },
  );
  const heads = output.stdout
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const [ref, target] = line.split("\t");
      if (
        ref === undefined ||
        target === undefined ||
        !ref.endsWith("/HEAD") ||
        !target.startsWith("refs/remotes/")
      )
        return [];
      return [{ ref, target }];
    });
  const selected =
    heads.find((head) => head.ref === "refs/remotes/origin/HEAD") ??
    (heads.length === 1 ? heads[0] : undefined);
  if (selected === undefined) return { defaultSha: null, defaultBranch: "" };
  const prefix = selected.ref.slice(0, -"HEAD".length);
  return {
    defaultSha: await optionalCommit(store, selected.target),
    defaultBranch: selected.target.startsWith(prefix)
      ? selected.target.slice(prefix.length)
      : selected.target,
  };
}

async function fetchRevision(
  store: GitStore,
  source: RepositorySource,
  remote: string,
  revision: string,
  alias: string,
): Promise<void> {
  assertRevisionInput(revision);
  const authentication =
    source.token === undefined
      ? {}
      : {
          authentication: {
            origin: validateRemoteUrl(remote).origin,
            token: source.token,
          },
        };
  await store.command(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--",
      remote,
      `${revision}:refs/gus/${alias}`,
    ],
    { maxBytes: 256000, ...authentication },
  );
}
