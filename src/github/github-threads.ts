import type { z } from "zod";
import { GusError } from "../errors.js";
import {
  resolvedThreadSchema,
  threadCommentPageSchema,
  threadPageSchema,
} from "./github-api-schemas.js";
import type { GitHubThread } from "./github-port.js";
import type { GitHubTransport } from "./github-request.js";

const COMMENT_FIELDS =
  "nodes { body author { login } pullRequestReview { databaseId } } pageInfo { hasNextPage endCursor }";
type ReviewThreadPage = z.infer<typeof threadPageSchema>;
type ReviewThreadRepository = NonNullable<
  ReviewThreadPage["data"]["repository"]
>;
type ReviewThreadConnection = NonNullable<
  ReviewThreadRepository["pullRequest"]
>["reviewThreads"];
type ReviewThreadCommentPage = z.infer<typeof threadCommentPageSchema>;

export async function listReviewThreads(
  transport: GitHubTransport,
  owner: string,
  name: string,
  number: number,
): Promise<GitHubThread[]> {
  const threads: GitHubThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const response: ReviewThreadPage = await transport.graphql(
      `query($owner:String!,$name:String!,$number:Int!,$cursor:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100,after:$cursor){ nodes { id isResolved comments(first:100){ ${COMMENT_FIELDS} } } pageInfo { hasNextPage endCursor } } } } }`,
      { owner, name, number, cursor },
      threadPageSchema,
    );
    const connection: ReviewThreadConnection | undefined =
      response.data.repository?.pullRequest?.reviewThreads;
    if (response.errors?.length || !connection)
      throw new GusError(
        "GITHUB_ERROR",
        "GitHub review threads could not be loaded completely.",
      );
    for (const thread of connection.nodes) {
      const comments = [...thread.comments.nodes];
      let commentPage = thread.comments.pageInfo;
      for (let index = 0; commentPage.hasNextPage; index += 1) {
        if (!commentPage.endCursor || index >= 49)
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub thread comments exceeded pagination limits.",
          );
        const next: ReviewThreadCommentPage = await transport.graphql(
          `query($id:ID!,$cursor:String){ node(id:$id){ ... on PullRequestReviewThread { comments(first:100,after:$cursor){ ${COMMENT_FIELDS} } } } }`,
          { id: thread.id, cursor: commentPage.endCursor },
          threadCommentPageSchema,
        );
        if (next.errors?.length || !next.data.node)
          throw new GusError(
            "GITHUB_ERROR",
            "GitHub thread comments could not be loaded completely.",
          );
        comments.push(...next.data.node.comments.nodes);
        commentPage = next.data.node.comments.pageInfo;
      }
      threads.push({
        id: thread.id,
        resolved: thread.isResolved,
        comments: comments.map((comment) => ({
          body: comment.body,
          author: comment.author?.login ?? "[deleted]",
          reviewId: comment.pullRequestReview?.databaseId ?? null,
        })),
      });
    }
    if (!connection.pageInfo.hasNextPage) return threads;
    if (
      !connection.pageInfo.endCursor ||
      connection.pageInfo.endCursor === cursor
    )
      throw new GusError(
        "GITHUB_ERROR",
        "GitHub thread pagination did not advance.",
      );
    cursor = connection.pageInfo.endCursor;
  }
  throw new GusError(
    "GITHUB_ERROR",
    "GitHub review threads exceeded pagination limits.",
  );
}

export async function resolveReviewThread(
  transport: GitHubTransport,
  id: string,
): Promise<void> {
  const result = await transport.graphql(
    "mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }",
    { id },
    resolvedThreadSchema,
  );
  if (
    result.errors?.length ||
    result.data.resolveReviewThread?.thread.id !== id
  )
    throw new GusError(
      "GITHUB_ERROR",
      "GitHub did not confirm thread resolution.",
    );
}
