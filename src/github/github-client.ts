import type { z } from "zod";
import { GusError } from "../errors.js";
import {
  branchSchema,
  createdReviewSchema,
  issueSchema,
  permissionSchema,
  pullRequestSchema,
  repositorySchema,
  reviewRecordSchema,
  userSchema,
} from "./github-api-schemas.js";
import type {
  GitHubClient,
  GitHubClientOptions,
  GitHubPullRequest,
} from "./github-port.js";
import { createGitHubTransport, GitHubRequestError } from "./github-request.js";
import { listReviewThreads, resolveReviewThread } from "./github-threads.js";
import { repositoryFileReader } from "./repository-file.js";

/** Creates a repository-scoped GitHub client with bounded requests and sanitized failures. */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
    options.repository,
  );
  const owner = match?.[1];
  const name = match?.[2];
  if (
    !owner ||
    !name ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  )
    throw new GusError(
      "INPUT_INVALID",
      "Repository must have the form owner/name.",
    );
  const repositoryPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const transport = createGitHubTransport(options);

  function convertPullRequest(
    pullRequest: z.infer<typeof pullRequestSchema>,
  ): GitHubPullRequest {
    return {
      repository: options.repository,
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? "",
      author: pullRequest.user.login,
      url: pullRequest.html_url,
      state: pullRequest.state,
      draft: pullRequest.draft,
      isFork:
        pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name,
      baseRef: pullRequest.base.ref,
      baseSha: pullRequest.base.sha,
      headRef: pullRequest.head.ref,
      headSha: pullRequest.head.sha,
      headCloneUrl: pullRequest.head.repo?.clone_url ?? "",
      headOwner:
        pullRequest.head.repo?.owner.login ??
        pullRequest.head.user?.login ??
        "",
      merged: pullRequest.merged || pullRequest.merged_at != null,
    };
  }

  return {
    async getRepository() {
      const repository = await transport.request(
        "GET",
        repositoryPath,
        repositorySchema,
      );
      const branch = await transport.request(
        "GET",
        `${repositoryPath}/branches/${encodeURIComponent(repository.default_branch)}`,
        branchSchema,
      );
      return {
        owner: repository.owner.login,
        name: repository.name,
        defaultBranch: repository.default_branch,
        defaultSha: branch.commit.sha,
        cloneUrl: repository.clone_url,
        url: repository.html_url,
      };
    },
    async getPullRequest(number) {
      return convertPullRequest(
        await transport.request(
          "GET",
          `${repositoryPath}/pulls/${positiveNumber(number)}`,
          pullRequestSchema,
        ),
      );
    },
    async getAuthenticatedLogin() {
      try {
        return (await transport.request("GET", "user", userSchema)).login;
      } catch (error) {
        if (
          error instanceof GitHubRequestError &&
          [401, 403, 404].some((status) => status === error.status)
        )
          return null;
        throw error;
      }
    },
    async getPermission(login) {
      try {
        const permission = await transport.request(
          "GET",
          `${repositoryPath}/collaborators/${encodeURIComponent(login)}/permission`,
          permissionSchema,
        );
        return permission.role_name &&
          ["write", "maintain", "admin"].includes(permission.role_name)
          ? permission.role_name
          : permission.permission;
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404)
          return "none";
        throw error;
      }
    },
    getFile: repositoryFileReader(transport, repositoryPath),
    async listPullRequests(options) {
      const query = new URLSearchParams({ state: options?.state ?? "open" });
      if (options?.head) query.set("head", options.head);
      return (
        await transport.paginate(
          `${repositoryPath}/pulls?${query}`,
          pullRequestSchema,
        )
      ).map(convertPullRequest);
    },
    async listReviews(number) {
      const reviews = await transport.paginate(
        `${repositoryPath}/pulls/${positiveNumber(number)}/reviews`,
        reviewRecordSchema,
      );
      return reviews
        .filter(
          (review) =>
            review.submitted_at !== null && review.state !== "PENDING",
        )
        .map((review) => ({
          id: review.id,
          author: review.user?.login ?? "[deleted]",
          body: review.body ?? "",
          commitId: review.commit_id ?? "",
          url: review.html_url,
          submittedAt: review.submitted_at ?? "",
        }));
    },
    async listThreads(number) {
      return listReviewThreads(transport, owner, name, positiveNumber(number));
    },
    async listIssues() {
      const issues = await transport.paginate(
        `${repositoryPath}/issues?state=all`,
        issueSchema,
      );
      return issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          url: issue.html_url,
        }));
    },
    async createReview(number, input) {
      const review = await transport.request(
        "POST",
        `${repositoryPath}/pulls/${positiveNumber(number)}/reviews`,
        createdReviewSchema,
        {
          body: input.body,
          commit_id: input.commitId,
          event: "COMMENT",
          comments: input.comments,
        },
      );
      return { id: review.id, url: review.html_url };
    },
    async createIssue(input) {
      const issue = await transport.request(
        "POST",
        `${repositoryPath}/issues`,
        issueSchema,
        input,
      );
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.html_url,
      };
    },
    async resolveThread(id) {
      await resolveReviewThread(transport, id);
    },
  };
}

function positiveNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new GusError(
      "INPUT_INVALID",
      "Pull request number must be a positive integer.",
    );
  return number;
}
