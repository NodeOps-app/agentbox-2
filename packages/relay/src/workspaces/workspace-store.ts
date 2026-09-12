import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  hashProjectPath,
  projectDirSegment,
  registerProject,
  withFileLock,
} from '@agentbox/config';
import { WORKSPACES_DIR, type Workspace, type WorkspaceRecord } from './types.js';

/**
 * Short lock windows: these files sit on the hub's dashboard poll path, so a
 * lock left by a killed process must not hold a read for the default 15s. The
 * write itself is atomic (temp+rename), so the worst case of proceeding without
 * the lock is a lost update, never a corrupt file. Mirrors META_LOCK in
 * @agentbox/config's project-meta writer, for the same reason.
 */
export const WORKSPACE_LOCK = { staleMs: 2_000, acquireTimeoutMs: 5_000 };

/** Directory names never scanned for projects. */
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

/** The on-disk dir for a workspace. The mnemonic suffix is decorative. */
export function workspaceDir(id: string, root?: string): string {
  return join(WORKSPACES_DIR, root ? projectDirSegment(root) : id);
}

export function workspaceFile(dir: string): string {
  return join(dir, 'workspace.json');
}

export function tasksFile(dir: string): string {
  return join(dir, 'tasks.json');
}

export function managerFile(dir: string): string {
  return join(dir, 'manager.json');
}

export function managerExitFile(dir: string): string {
  return join(dir, 'manager.exit');
}

/**
 * Resolve the dir holding a workspace by id. The dir name carries a decorative
 * mnemonic we cannot reconstruct from the id alone (the root may be gone), so
 * this scans for the entry whose leading 16 hex chars match — the same rule
 * `listProjectsConfigured` uses for the project registry.
 */
export async function resolveWorkspaceDir(id: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(WORKSPACES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  for (const name of entries) {
    const m = /^([0-9a-f]{16})(?:-.+)?$/.exec(name);
    if (m && m[1] === id) return join(WORKSPACES_DIR, name);
  }
  return null;
}

/** Absolute, realpath'd, no trailing slash — the string the id is hashed from. */
export async function canonicalWorkspaceRoot(absPath: string): Promise<string> {
  const resolved = await realpath(absPath).catch(() => absPath);
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

/** Does this folder look like a project root (what a box would be built from)? */
async function looksLikeProject(dir: string): Promise<boolean> {
  const [git, yaml] = await Promise.all([
    stat(join(dir, '.git')).catch(() => null),
    stat(join(dir, 'agentbox.yaml')).catch(() => null),
  ]);
  // `.git` is a directory in a normal clone and a FILE in a worktree/submodule,
  // so presence is the test, not its type.
  return git !== null || yaml !== null;
}

/**
 * Project roots inside a workspace: the folder itself when it is one, plus every
 * immediate subfolder that is. Depth 1 only — a deeper walk would pick up
 * vendored checkouts and fixture repos, and a monorepo's packages are one
 * project, not many.
 */
export async function scanWorkspaceProjects(root: string): Promise<string[]> {
  const out: string[] = [];
  if (await looksLikeProject(root)) out.push(root);
  let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const subs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.') || SCAN_SKIP.has(e.name)) continue;
    const dir = join(root, e.name);
    if (await looksLikeProject(dir)) subs.push(dir);
  }
  subs.sort((a, b) => a.localeCompare(b));
  out.push(...subs);
  return out;
}

export async function readWorkspace(id: string): Promise<WorkspaceRecord | null> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return null;
  try {
    const raw = await readFile(workspaceFile(dir), 'utf8');
    return JSON.parse(raw) as WorkspaceRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null; // malformed: treat as absent, like loadQueue's skip
  }
}

/** Every registered workspace. Malformed entries are skipped, never thrown on. */
export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(WORKSPACES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: WorkspaceRecord[] = [];
  for (const name of entries) {
    if (!/^[0-9a-f]{16}(?:-.+)?$/.test(name)) continue;
    try {
      const raw = await readFile(workspaceFile(join(WORKSPACES_DIR, name)), 'utf8');
      out.push(JSON.parse(raw) as WorkspaceRecord);
    } catch {
      // skip malformed / partially-created
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function writeWorkspace(rec: WorkspaceRecord): Promise<void> {
  const dir = (await resolveWorkspaceDir(rec.id)) ?? workspaceDir(rec.id, rec.root);
  await mkdir(dir, { recursive: true });
  const final = workspaceFile(dir);
  const tmp = `${final}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  await rename(tmp, final);
}

/** Locked read-modify-write of one workspace record. */
export async function updateWorkspace(
  id: string,
  fn: (rec: WorkspaceRecord) => WorkspaceRecord | Promise<WorkspaceRecord>,
): Promise<WorkspaceRecord | null> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return null;
  return withFileLock(
    workspaceFile(dir),
    async () => {
      const current = await readWorkspace(id);
      if (!current) return null;
      const next = { ...(await fn(current)), updatedAt: new Date().toISOString() };
      await writeWorkspace(next);
      return next;
    },
    WORKSPACE_LOCK,
  );
}

export interface AddWorkspaceDeps {
  /** Seam so a test registers nothing in the real project registry. */
  register?: (absPath: string) => Promise<void>;
}

const defaultAddDeps: Required<AddWorkspaceDeps> = {
  register: (p) => registerProject(p),
};

/**
 * Register a folder as a workspace. Idempotent: re-adding an existing root
 * rescans it rather than failing, so a client can call this to refresh.
 *
 * Every discovered project is registered in the PROJECT registry too, so it
 * appears in `GET /projects` and can host a box without a second step.
 */
export async function addWorkspace(
  absPath: string,
  opts: { name?: string } = {},
  deps: AddWorkspaceDeps = {},
): Promise<WorkspaceRecord> {
  const register = deps.register ?? defaultAddDeps.register;
  const root = await canonicalWorkspaceRoot(absPath);
  const id = hashProjectPath(root);
  const projectPaths = await scanWorkspaceProjects(root);
  await Promise.all(projectPaths.map((p) => register(p).catch(() => {})));
  const projectIds = projectPaths.map((p) => hashProjectPath(p));
  const now = new Date().toISOString();
  const existing = await readWorkspace(id);
  const rec: WorkspaceRecord = {
    id,
    name: opts.name ?? existing?.name ?? basename(root),
    root,
    projectIds,
    taskCounter: existing?.taskCounter ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeWorkspace(rec);
  return rec;
}

/** Re-run project discovery for a registered workspace. */
export async function rescanWorkspace(
  id: string,
  deps: AddWorkspaceDeps = {},
): Promise<WorkspaceRecord | null> {
  const current = await readWorkspace(id);
  if (!current) return null;
  return addWorkspace(current.root, { name: current.name }, deps);
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceRecord | null> {
  return updateWorkspace(id, (rec) => ({ ...rec, name }));
}

/**
 * Drop a workspace and its tasks. The FOLDER, its projects and their boxes are
 * untouched — this unregisters, it does not delete work.
 */
export async function removeWorkspace(id: string): Promise<boolean> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export function toWorkspaceView(rec: WorkspaceRecord): Workspace {
  return {
    id: rec.id,
    name: rec.name,
    root: rec.root,
    projectIds: rec.projectIds,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * The workspace a path belongs to: the one whose root is the longest PATH-SEGMENT
 * prefix of it. Segment-aware so `/a/foobar` never matches the workspace at
 * `/a/foo`. Pure, so the CLI can run it over a fetched listing.
 */
export function findWorkspaceContaining<T extends { root: string }>(
  records: T[],
  absPath: string,
): T | null {
  const target = absPath.length > 1 && absPath.endsWith('/') ? absPath.slice(0, -1) : absPath;
  let best: T | null = null;
  for (const rec of records) {
    if (target !== rec.root && !target.startsWith(`${rec.root}/`)) continue;
    if (!best || rec.root.length > best.root.length) best = rec;
  }
  return best;
}
