import { Buffer } from "node:buffer";
import { z } from "zod";
import { GusError } from "../errors.js";
import { GitHubRequestError, type GitHubTransport } from "./github-request.js";

const commitTreeSchema = z.object({
  commit: z.object({ tree: z.object({ sha: z.string().min(1) }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string().min(1),
      size: z.number().optional(),
    }),
  ),
});
const blobSchema = z.object({
  encoding: z.literal("base64"),
  content: z.string(),
  size: z.number().nonnegative(),
});
const SECRET_COMPONENT =
  /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\.json)?|secrets?)$/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|kdbx)$/i;
type RepositoryTree = z.infer<typeof treeSchema>;
type RepositoryTreeEntry = RepositoryTree["tree"][number];
type RepositoryCommitTree = z.infer<typeof commitTreeSchema>;

export function repositoryFileReader(
  transport: GitHubTransport,
  repositoryPath: string,
): (path: string, ref: string) => Promise<string | null> {
  const trees = new Map<string, RepositoryTree>();
  const commitTrees = new Map<string, string>();

  async function readTree(sha: string): Promise<RepositoryTree> {
    const cached = trees.get(sha);
    if (cached) return cached;
    const tree = await transport.request(
      "GET",
      `${repositoryPath}/git/trees/${encodeURIComponent(sha)}`,
      treeSchema,
    );
    if (tree.truncated)
      throw new GusError(
        "GITHUB_ERROR",
        "GitHub file-tree response was truncated; file safety could not be established.",
      );
    trees.set(sha, tree);
    return tree;
  }

  return async (path, ref) => {
    const components = path.split("/");
    if (
      !ref ||
      path.includes("\\") ||
      path.includes("\0") ||
      components.length > 50 ||
      components.some(
        (component) =>
          !component ||
          component === "." ||
          component === ".." ||
          SECRET_COMPONENT.test(component),
      ) ||
      SECRET_EXTENSION.test(path)
    )
      throw new GusError(
        "PATH_DENIED",
        "GitHub file path is unsafe or may contain credentials.",
      );
    try {
      const cachedTreeSha = commitTrees.get(ref);
      let treeSha: string;
      if (cachedTreeSha) {
        treeSha = cachedTreeSha;
      } else {
        const commit: RepositoryCommitTree = await transport.request(
          "GET",
          `${repositoryPath}/commits/${encodeURIComponent(ref)}`,
          commitTreeSchema,
        );
        treeSha = commit.commit.tree.sha;
        if (/^[a-f0-9]{40,64}$/i.test(ref)) commitTrees.set(ref, treeSha);
      }
      for (let index = 0; index < components.length; index += 1) {
        const component = components[index];
        const tree: RepositoryTree = await readTree(treeSha);
        const entry: RepositoryTreeEntry | undefined = tree.tree.find(
          (candidate) => candidate.path === component,
        );
        if (!entry) return null;
        if (index < components.length - 1) {
          if (entry.type !== "tree" || entry.mode !== "040000")
            throw new GusError(
              "PATH_DENIED",
              "GitHub file path crosses a symlink, submodule, or non-directory.",
            );
          treeSha = entry.sha;
          continue;
        }
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
          throw new GusError(
            "PATH_DENIED",
            "GitHub file must be a regular repository file.",
          );
        if (entry.size !== undefined && entry.size > 2_000_000)
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub file exceeds the supported read limit.",
          );
        const blob = await transport.request(
          "GET",
          `${repositoryPath}/git/blobs/${encodeURIComponent(entry.sha)}`,
          blobSchema,
        );
        if (blob.size > 2_000_000)
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub file exceeds the supported read limit.",
          );
        const encoded = blob.content.replace(/\s/g, "");
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            encoded,
          )
        )
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub file encoding is invalid.",
          );
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(encoded, "base64"),
          );
        } catch {
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub file is not valid UTF-8 text.",
          );
        }
      }
      return null;
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404)
        return null;
      throw error;
    }
  };
}
