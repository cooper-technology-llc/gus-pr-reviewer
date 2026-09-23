// API fixtures prove pagination completeness, safe transport behavior, and repository-file trust boundaries.
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./github-client.js";

function reviewRecord(id: number) {
  return {
    id,
    user: { login: "gus[bot]" },
    body: "review",
    commit_id: "sha",
    html_url: `https://github.com/reviews/${id}`,
    submitted_at: "2026-01-01",
  };
}

describe("GitHub client", () => {
  it("reads every review page", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json(
        urls.length === 1
          ? Array.from({ length: 100 }, (_, index) => reviewRecord(index))
          : [reviewRecord(100)],
      );
    };
    const reviews = await createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    }).listReviews(7);
    expect(reviews).toHaveLength(101);
    expect(urls[1]).toContain("page=2");
  });
  it("fails explicitly when pagination cannot be completed within its bound", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests += 1;
      return Response.json(
        Array.from({ length: 100 }, (_, index) => reviewRecord(index)),
      );
    };
    await expect(
      createGitHubClient({
        repository: "acme/widgets",
        token: "test-token",
        fetch,
      }).listReviews(7),
    ).rejects.toThrow("pagination exceeded");
    expect(requests).toBe(50);
  });
  it("uses Enterprise GraphQL and reads all comment pages", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      if (urls.length === 1)
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            body: "first",
                            author: { login: "gus[bot]" },
                            pullRequestReview: { databaseId: 1 },
                          },
                        ],
                        pageInfo: {
                          hasNextPage: true,
                          endCursor: "next-comment",
                        },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      return Response.json({
        data: {
          node: {
            comments: {
              nodes: [
                {
                  body: "reply",
                  author: { login: "alice" },
                  pullRequestReview: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    };
    const threads = await createGitHubClient({
      repository: "acme/widgets",
      apiUrl: "https://git.example/api/v3",
      token: "test-token",
      fetch,
    }).listThreads(7);
    expect(urls).toEqual([
      "https://git.example/api/graphql",
      "https://git.example/api/graphql",
    ]);
    expect(threads[0]?.comments).toHaveLength(2);
  });
  it("does not retry failed writes or reveal response secrets", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests += 1;
      return new Response("private-token-from-server", { status: 500 });
    };
    const client = createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    });
    await expect(
      client.createReview(7, { body: "review", commitId: "sha", comments: [] }),
    ).rejects.toThrow("HTTP 500");
    expect(requests).toBe(1);
  });
  it("rejects URL credentials and non-loopback plain HTTP", () => {
    expect(() =>
      createGitHubClient({
        repository: "acme/widgets",
        token: "token",
        apiUrl: "https://user:password@github.example/api/v3",
      }),
    ).toThrow("credentials");
    expect(() =>
      createGitHubClient({
        repository: "acme/widgets",
        token: "token",
        apiUrl: "http://github.example/api/v3",
      }),
    ).toThrow("HTTPS");
  });
  it("checks the supplied revision and never dereferences symlinks", async () => {
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.includes("/commits/"))
        return Response.json({ commit: { tree: { sha: "tree-sha" } } });
      if (path.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [
            {
              path: "AGENTS.md",
              type: "blob",
              mode: "120000",
              sha: "link-sha",
            },
          ],
        });
      throw new Error("A symlink must never be read.");
    };
    const client = createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    });
    await expect(client.getFile("AGENTS.md", "exact-commit")).rejects.toThrow(
      "regular repository file",
    );
    expect(paths[0]).toContain("/commits/exact-commit");
    expect(paths).toHaveLength(2);
    await expect(client.getFile("../AGENTS.md", "sha")).rejects.toThrow(
      "unsafe",
    );
    await expect(client.getFile(".env.production", "sha")).rejects.toThrow(
      "unsafe",
    );
  });
  it("lists closed and open issues together so closed follow-ups remain deduplicated", async () => {
    let requested = "";
    const fetch: typeof globalThis.fetch = async (input) => {
      requested = String(input);
      return Response.json([]);
    };
    await createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    }).listIssues();
    expect(requested).toContain("state=all");
  });
  it("creates a completed check run on the head SHA", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        id: 11,
        html_url: "https://github.com/acme/widgets/runs/11",
      });
    };
    const output = { title: "t", summary: "s", text: "x", annotations: [] };
    const created = await createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    }).createCheckRun({
      name: "Gus review",
      headSha: "head-sha",
      conclusion: "neutral",
      detailsUrl: "https://github.com/acme/widgets/actions/runs/9",
      output,
    });
    expect(created).toEqual({
      id: 11,
      url: "https://github.com/acme/widgets/runs/11",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/repos/acme/widgets/check-runs",
        body: {
          name: "Gus review",
          head_sha: "head-sha",
          status: "completed",
          conclusion: "neutral",
          details_url: "https://github.com/acme/widgets/actions/runs/9",
          output,
        },
      },
    ]);
  });
  it("updates a review body with a single PUT and surfaces a 403 as a status", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    let status = 200;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
      });
      return status === 200
        ? Response.json({
            id: 3,
            html_url: "https://github.com/acme/widgets/pull/7#review-3",
          })
        : new Response("forbidden", { status });
    };
    const client = createGitHubClient({
      repository: "acme/widgets",
      token: "test-token",
      fetch,
    });
    await client.updateReview(7, 3, "Superseded.");
    expect(requests).toEqual([
      { method: "PUT", path: "/repos/acme/widgets/pulls/7/reviews/3" },
    ]);
    status = 403;
    await expect(client.updateReview(7, 3, "Superseded.")).rejects.toThrow(
      "HTTP 403",
    );
    expect(requests).toHaveLength(2);
  });
});
