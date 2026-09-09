// Real child processes prove output budgets and cancellation terminate Git rather than merely abandoning its promise.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config/config-schema.js";
import { createGitFixture } from "./git-test-fixtures.js";
import { createRepositoryStorage } from "./repository-storage.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function storage() {
  const fixture = await createGitFixture();
  directories.push(fixture.directory);
  await fixture.write("large.txt", "tracked line\n".repeat(10000));
  const sha = await fixture.commit("large blob");
  const repository = await createRepositoryStorage(
    { path: fixture.directory, base: sha, head: sha, defaultBranch: "trunk" },
    { config: defaultConfig },
  );
  directories.push(repository.store.directory);
  return repository;
}

describe("bounded Git child processes", () => {
  it("rejects oversized output without returning a truncated blob", async () => {
    const repository = await storage();
    await expect(
      repository.store.command(["show", `${repository.headSha}:large.txt`], {
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const afterwards = await repository.store.command([
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    expect(afterwards.stdout.toString("utf8").trim()).toBe(repository.headSha);
  });

  it("kills an in-flight child when the tool's signal aborts", async () => {
    const repository = await storage();
    const controller = new AbortController();
    const command = repository.store.command(["log", "--all", "--format=%H"], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(command).rejects.toMatchObject({ code: "ABORTED" });
    const afterwards = await repository.store.command([
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    expect(afterwards.exitCode).toBe(0);
  });
});
