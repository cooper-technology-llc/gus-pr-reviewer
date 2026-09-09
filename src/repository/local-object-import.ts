import { constants, type ReadStream, type WriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { GusError } from "../errors.js";
import { assertRevisionInput, isObjectId } from "./repository-paths.js";

export interface LocalRepository {
  gitDirectory: string;
  commonDirectory: string;
  objectFormat: "sha1" | "sha256";
}

/** Reads Git's storage layout without running Git against the source configuration. */
export async function inspectLocalRepository(
  path: string,
): Promise<LocalRepository> {
  const directory = await realpath(path);
  const dotGit = join(directory, ".git");
  let gitDirectory = directory;
  const dotGitStat = await lstat(dotGit).catch(() => undefined);
  if (dotGitStat?.isSymbolicLink())
    throw new GusError(
      "PATH_DENIED",
      "A symbolic .git directory is not supported.",
    );
  if (dotGitStat?.isDirectory()) gitDirectory = dotGit;
  if (dotGitStat?.isFile()) {
    const pointer = (await readRegularFile(dotGit, 4096)).trim();
    if (!pointer.startsWith("gitdir: ") || pointer.includes("\n")) {
      throw new GusError(
        "INPUT_INVALID",
        "The repository's .git file is not a valid worktree pointer.",
      );
    }
    gitDirectory = resolve(directory, pointer.slice(8));
  }
  await assertDirectory(gitDirectory);
  const commonPath = join(gitDirectory, "commondir");
  const commonPointer = await lstat(commonPath).catch(() => undefined);
  let commonDirectory = gitDirectory;
  if (commonPointer !== undefined) {
    const value = (await readRegularFile(commonPath, 4096)).trim();
    if (value.length === 0 || value.includes("\n"))
      throw new GusError("INPUT_INVALID", "Invalid Git common directory.");
    commonDirectory = resolve(gitDirectory, value);
  }
  await assertDirectory(commonDirectory);
  await assertDirectory(join(commonDirectory, "objects"));
  const config = await readRegularFile(join(commonDirectory, "config"), 256000);
  return {
    gitDirectory,
    commonDirectory,
    objectFormat: /^\s*objectformat\s*=\s*sha256\s*$/im.test(config)
      ? "sha256"
      : "sha1",
  };
}

/** Copies objects and validated refs only; hooks, config, alternates, and worktree files stay behind. */
export async function importLocalObjects(
  source: LocalRepository,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 60000;
  const sourceObjects = join(source.commonDirectory, "objects");
  let copiedBytes = 0;
  let copiedFiles = 0;
  for (const entry of await readdir(sourceObjects, { withFileTypes: true })) {
    checkImportBudget(signal, deadline);
    if (entry.name !== "pack" && !/^[a-f0-9]{2}$/.test(entry.name)) continue;
    const sourceDirectory = join(sourceObjects, entry.name);
    await assertDirectory(sourceDirectory);
    const destinationDirectory = join(destination, "objects", entry.name);
    await mkdir(destinationDirectory, { recursive: true });
    for (const object of await readdir(sourceDirectory, {
      withFileTypes: true,
    })) {
      checkImportBudget(signal, deadline);
      const isObject =
        entry.name === "pack"
          ? /^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev)$/.test(
              object.name,
            )
          : /^[a-f0-9]{38}(?:[a-f0-9]{24})?$/.test(object.name);
      if (!isObject) continue;
      const sourcePath = join(sourceDirectory, object.name);
      const stat = await lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new GusError(
          "PATH_DENIED",
          "Git object storage must contain regular files.",
        );
      copiedBytes += stat.size;
      copiedFiles += 1;
      if (copiedBytes > 2 * 1024 ** 3 || copiedFiles > 200000) {
        throw new GusError(
          "BUDGET_EXCEEDED",
          "Local Git storage exceeds the 2 GiB / 200,000 object import limit. Use the remote review source instead.",
        );
      }
      await copyRegularFile(
        sourcePath,
        join(destinationDirectory, object.name),
        signal,
      );
    }
  }
  for (const namespace of ["heads", "remotes"]) {
    await copyRefs(
      join(source.commonDirectory, "refs", namespace),
      join(destination, "refs", namespace),
      signal,
      deadline,
    );
  }
  const packedPath = join(source.commonDirectory, "packed-refs");
  if (await lstat(packedPath).catch(() => undefined)) {
    const packed = await readRegularFile(packedPath, 8 * 1024 * 1024);
    const validated = packed.split("\n").filter((line) => {
      if (line.startsWith("#") || line.startsWith("^") || line.length === 0)
        return false;
      const separator = line.indexOf(" ");
      const sha = line.slice(0, separator);
      const ref = line.slice(separator + 1);
      if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/"))
        return false;
      assertRevisionInput(ref);
      if (!isObjectId(sha))
        throw new GusError("INPUT_INVALID", "Invalid packed Git reference.");
      return true;
    });
    if (validated.length > 0)
      await writeFile(
        join(destination, "packed-refs"),
        `${validated.join("\n")}\n`,
        { mode: 0o600 },
      );
  }
  const head = (
    await readRegularFile(join(source.gitDirectory, "HEAD"), 4096)
  ).trim();
  validateRefContents(head);
  await writeFile(join(destination, "HEAD"), `${head}\n`, { mode: 0o600 });
}

async function copyRefs(
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<void> {
  const directoryStat = await lstat(source).catch(() => undefined);
  if (directoryStat === undefined) return;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new GusError(
      "PATH_DENIED",
      "Git reference directories cannot be symbolic links.",
    );
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    checkImportBudget(signal, deadline);
    assertRevisionInput(entry.name);
    const sourcePath = join(source, entry.name);
    if (entry.isDirectory()) {
      await copyRefs(
        sourcePath,
        join(destination, entry.name),
        signal,
        deadline,
      );
    } else {
      const value = (await readRegularFile(sourcePath, 4096)).trim();
      validateRefContents(value);
      await writeFile(join(destination, entry.name), `${value}\n`, {
        mode: 0o600,
      });
    }
  }
}

function validateRefContents(value: string): void {
  if (isObjectId(value)) return;
  if (value.startsWith("ref: refs/")) {
    assertRevisionInput(value.slice(5));
    return;
  }
  throw new GusError(
    "INPUT_INVALID",
    "Git reference contains an unsupported value.",
  );
}

async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new GusError(
        "PATH_DENIED",
        "Git metadata is not a bounded regular file.",
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: FileHandle | undefined;
  let inputStream: ReadStream | undefined;
  let outputStream: WriteStream | undefined;
  try {
    output = await open(destination, "wx", 0o600);
    inputStream = input.createReadStream();
    outputStream = output.createWriteStream();
    await pipeline(inputStream, outputStream, { signal });
  } finally {
    inputStream?.destroy();
    outputStream?.destroy();
    await Promise.all([input.close(), output?.close()]);
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new GusError(
      "PATH_DENIED",
      "Git storage directories cannot be symbolic links.",
    );
}

function checkImportBudget(
  signal: AbortSignal | undefined,
  deadline: number,
): void {
  if (signal?.aborted)
    throw new GusError("ABORTED", "Repository import cancelled.");
  if (Date.now() > deadline)
    throw new GusError(
      "BUDGET_EXCEEDED",
      "Local repository import exceeded one minute.",
    );
}
