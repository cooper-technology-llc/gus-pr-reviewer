import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface GitFixture {
  directory: string;
  git(...argumentsList: string[]): Promise<string>;
  write(path: string, text: string | Uint8Array): Promise<void>;
  commit(message: string): Promise<string>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const directory = await mkdtemp(join(tmpdir(), "gus-git-fixture-"));
  const git = async (...argumentsList: string[]) => {
    const output = await executeFile(
      "git",
      [
        "-c",
        "user.name=Gus Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...argumentsList,
      ],
      {
        cwd: directory,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return output.stdout.trim();
  };
  await git("init", "--quiet", "--initial-branch=trunk");
  return {
    directory,
    git,
    write: async (path, text) => {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), text);
    },
    commit: async (message) => {
      await git("add", "--all");
      await git("commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}
