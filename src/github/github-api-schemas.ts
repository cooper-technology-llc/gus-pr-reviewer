import { z } from "zod";

export const userSchema = z.object({
  login: z.string(),
  type: z.string().optional(),
});
const repositoryReferenceSchema = z.object({
  full_name: z.string(),
  clone_url: z.url(),
  owner: userSchema,
});
export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  user: userSchema,
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().default(false),
  merged: z.boolean().default(false),
  merged_at: z.string().nullable().optional(),
  base: z.object({
    ref: z.string(),
    sha: z.string().min(1),
    repo: repositoryReferenceSchema,
  }),
  head: z.object({
    ref: z.string(),
    sha: z.string().min(1),
    repo: repositoryReferenceSchema.nullable(),
    user: userSchema.nullable().optional(),
  }),
});
export const repositorySchema = z.object({
  name: z.string(),
  owner: userSchema,
  default_branch: z.string(),
  clone_url: z.url(),
  html_url: z.url(),
});
export const branchSchema = z.object({
  commit: z.object({ sha: z.string().min(1) }),
});
export const permissionSchema = z.object({
  permission: z.string(),
  role_name: z.string().optional(),
});
export const reviewRecordSchema = z.object({
  id: z.number().int(),
  user: userSchema.nullable(),
  body: z.string().nullable(),
  commit_id: z.string().nullable(),
  html_url: z.url(),
  submitted_at: z.string().nullable(),
  state: z.string().optional(),
});
export const createdReviewSchema = z.object({
  id: z.number().int(),
  html_url: z.url(),
});
export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url(),
  pull_request: z.unknown().optional(),
});
export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const threadCommentSchema = z.object({
  body: z.string(),
  author: userSchema.nullable(),
  pullRequestReview: z
    .object({ databaseId: z.number().int().nullable() })
    .nullable(),
});
export const threadCommentsSchema = z.object({
  nodes: z.array(threadCommentSchema),
  pageInfo: pageInfoSchema,
});
export const threadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: threadCommentsSchema,
});
export const threadPageSchema = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviewThreads: z.object({
              nodes: z.array(threadSchema),
              pageInfo: pageInfoSchema,
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
});
export const threadCommentPageSchema = z.object({
  data: z.object({
    node: z.object({ comments: threadCommentsSchema }).nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
});
export const resolvedThreadSchema = z.object({
  data: z.object({
    resolveReviewThread: z
      .object({
        thread: z.object({ id: z.string(), isResolved: z.literal(true) }),
      })
      .nullable(),
  }),
  errors: z.array(z.unknown()).optional(),
});
