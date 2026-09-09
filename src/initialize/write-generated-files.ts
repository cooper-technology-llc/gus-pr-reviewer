import {
  lstat,
  mkdir,
  readFile,
  realpath,
  open,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { GusError } from "../errors.js";

export interface GeneratedFile {
  path: string;
  text: string;
  mode?: number;
}
interface PlannedFile extends GeneratedFile {
  absolutePath: string;
  original: Buffer | null;
  originalMode: number | null;
}

/** Preflight generated writes and preset retirements, restoring their original bytes and modes on failure. */
export async function writeGeneratedFiles(
  directory: string,
  files: GeneratedFile[],
  force = false,
  retiredPaths: string[] = [],
): Promise<string[]> {
  await mkdir(resolve(directory), { recursive: true });
  const root = await realpath(resolve(directory));
  const planned: PlannedFile[] = [];
  for (const file of files) planned.push(await planFile(root, file, force));
  const retired: PlannedFile[] = [];
  for (const path of new Set(retiredPaths)) {
    if (
      !/^\.github\/gus\/templates\/presets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(
        path,
      ) ||
      planned.some(
        (file) =>
          file.absolutePath.toLowerCase() === resolve(root, path).toLowerCase(),
      )
    )
      throw new GusError(
        "PATH_DENIED",
        "Only obsolete generated preset files can be retired by a runtime update.",
      );
    const file = await planFile(root, { path, text: "" }, true);
    if (file.original === null)
      throw new GusError(
        "INPUT_INVALID",
        `The generated preset selected for retirement is missing: ${path}`,
      );
    retired.push(file);
  }
  const written: PlannedFile[] = [];
  try {
    for (const file of retired) {
      await rejectSymlinks(root, file.absolutePath);
      await unlink(file.absolutePath);
      written.push(file);
    }
    for (const file of planned) {
      await mkdir(dirname(file.absolutePath), { recursive: true });
      await rejectSymlinks(root, file.absolutePath);
      const handle = await open(
        file.absolutePath,
        constants.O_WRONLY |
          constants.O_NOFOLLOW |
          (file.original === null ? constants.O_CREAT | constants.O_EXCL : 0),
        file.mode ?? 0o644,
      );
      try {
        written.push(file);
        await handle.truncate(0);
        await handle.writeFile(file.text, "utf8");
        if (file.mode !== undefined) await handle.chmod(file.mode);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of written.reverse()) {
      try {
        await restoreOriginalFile(root, file);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0)
      throw new GusError(
        "COMMAND_FAILED",
        "The generated update failed and some files could not be restored. Preserve the directory and inspect the failed paths before retrying.",
        { cause: new AggregateError([error, ...rollbackErrors]) },
      );
    throw error;
  }
  return [...planned, ...retired].map((file) => file.absolutePath);
}

async function restoreOriginalFile(
  root: string,
  file: PlannedFile,
): Promise<void> {
  await rejectSymlinks(root, file.absolutePath);
  if (file.original === null) {
    await unlink(file.absolutePath);
    return;
  }
  const stat = await statIfPresent(file.absolutePath);
  if (stat && !stat.isFile())
    throw new GusError(
      "PATH_DENIED",
      `Cannot restore a generated file over a non-file: ${file.path}`,
    );
  const handle = await open(
    file.absolutePath,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (stat === null ? constants.O_CREAT | constants.O_EXCL : 0),
    file.originalMode ?? 0o644,
  );
  try {
    await handle.truncate(0);
    await handle.writeFile(file.original);
    if (file.originalMode !== null) await handle.chmod(file.originalMode);
  } finally {
    await handle.close();
  }
}

async function planFile(
  root: string,
  file: GeneratedFile,
  force: boolean,
): Promise<PlannedFile> {
  const absolutePath = resolve(root, file.path);
  const pathWithinRoot = relative(root, absolutePath);
  if (
    !pathWithinRoot ||
    pathWithinRoot === ".." ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  )
    throw new GusError(
      "PATH_DENIED",
      "Generated files must stay inside the selected directory.",
    );
  await rejectSymlinks(root, absolutePath);
  const stat = await statIfPresent(absolutePath);
  if (stat && !stat.isFile())
    throw new GusError(
      "INPUT_INVALID",
      `Cannot replace a non-file: ${file.path}`,
    );
  if (stat && !force)
    throw new GusError(
      "INPUT_INVALID",
      `${file.path} already exists. init --force can replace generated files; prompt exports require an empty destination.`,
    );
  return {
    ...file,
    absolutePath,
    original: stat ? await readFile(absolutePath) : null,
    originalMode: stat ? stat.mode & 0o777 : null,
  };
}

async function rejectSymlinks(root: string, path: string): Promise<void> {
  const segments = relative(root, path).split(sep);
  let candidate = root;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    const stat = await statIfPresent(candidate);
    if (stat?.isSymbolicLink())
      throw new GusError(
        "PATH_DENIED",
        "Generated output cannot traverse a symbolic link.",
      );
  }
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
