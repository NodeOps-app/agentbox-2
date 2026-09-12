import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashProjectPath } from '@agentbox/config';
import { assertTempHome } from '../../../scripts/test-home.js';
import {
  addWorkspace,
  canonicalWorkspaceRoot,
  findWorkspaceContaining,
  listWorkspaces,
  readWorkspace,
  removeWorkspace,
  renameWorkspace,
  rescanWorkspace,
  scanWorkspaceProjects,
  toWorkspaceView,
} from '../src/workspaces/index.js';

/** Registering into the real project registry is not what these assert. */
const noRegister = { register: async () => {} };

// The temp HOME is per FILE, so the registry carries over between tests here.
beforeEach(async () => {
  await rm(join(assertTempHome(), '.agentbox', 'workspaces'), { recursive: true, force: true });
});

async function makeTree(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-ws-')));
  // A repo whose .git is a FILE (worktree/submodule shape).
  await mkdir(join(root, 'a'), { recursive: true });
  await writeFile(join(root, 'a', '.git'), 'gitdir: /elsewhere\n');
  // A repo with a .git directory.
  await mkdir(join(root, 'b', '.git'), { recursive: true });
  // A project identified by agentbox.yaml alone.
  await mkdir(join(root, 'c'), { recursive: true });
  await writeFile(join(root, 'c', 'agentbox.yaml'), 'services: {}\n');
  // Not projects.
  await mkdir(join(root, 'plain'), { recursive: true });
  await mkdir(join(root, '.hidden', '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  return root;
}

describe('scanWorkspaceProjects', () => {
  it('finds depth-1 projects and skips dot-dirs, node_modules and plain folders', async () => {
    const root = await makeTree();
    expect(await scanWorkspaceProjects(root)).toEqual([
      join(root, 'a'),
      join(root, 'b'),
      join(root, 'c'),
    ]);
  });

  it('includes the root itself when the root is a project', async () => {
    const root = await makeTree();
    await mkdir(join(root, '.git'), { recursive: true });
    const found = await scanWorkspaceProjects(root);
    expect(found[0]).toBe(root);
    expect(found).toHaveLength(4);
  });
});

describe('addWorkspace', () => {
  it('keys the workspace by hashProjectPath(root) and records its projects', async () => {
    const root = await makeTree();
    const ws = await addWorkspace(root, {}, noRegister);
    expect(ws.id).toBe(hashProjectPath(root));
    expect(ws.root).toBe(root);
    expect(ws.name).toBe(root.split('/').pop());
    expect(ws.projectIds).toEqual([
      hashProjectPath(join(root, 'a')),
      hashProjectPath(join(root, 'b')),
      hashProjectPath(join(root, 'c')),
    ]);
    expect(ws.taskCounter).toBe(0);
  });

  it('registers each discovered project', async () => {
    const root = await makeTree();
    const seen: string[] = [];
    await addWorkspace(root, {}, { register: async (p) => void seen.push(p) });
    expect(seen).toEqual([join(root, 'a'), join(root, 'b'), join(root, 'c')]);
  });

  it('is idempotent: re-adding rescans and keeps createdAt, name and the task counter', async () => {
    const root = await makeTree();
    const first = await addWorkspace(root, { name: 'kept' }, noRegister);
    await mkdir(join(root, 'd', '.git'), { recursive: true });
    const again = await addWorkspace(root, {}, noRegister);
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('kept');
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.projectIds).toHaveLength(4);
    expect(await listWorkspaces()).toHaveLength(1);
  });

  it('rescan picks up a project added after registration', async () => {
    const root = await makeTree();
    const ws = await addWorkspace(root, {}, noRegister);
    await mkdir(join(root, 'late', '.git'), { recursive: true });
    const after = await rescanWorkspace(ws.id, noRegister);
    expect(after?.projectIds).toHaveLength(4);
  });
});

describe('workspace registry', () => {
  it('renames, reads back and removes', async () => {
    const root = await makeTree();
    const ws = await addWorkspace(root, {}, noRegister);
    expect((await renameWorkspace(ws.id, 'storefront'))?.name).toBe('storefront');
    expect((await readWorkspace(ws.id))?.name).toBe('storefront');
    expect(await removeWorkspace(ws.id)).toBe(true);
    expect(await readWorkspace(ws.id)).toBeNull();
    expect(await removeWorkspace(ws.id)).toBe(false);
  });

  it('skips a malformed record instead of throwing', async () => {
    const root = await makeTree();
    const good = await addWorkspace(root, {}, noRegister);
    const junkDir = join(homedir(), '.agentbox', 'workspaces', '0123456789abcdef-junk');
    await mkdir(junkDir, { recursive: true });
    await writeFile(join(junkDir, 'workspace.json'), '{ not json');
    const all = await listWorkspaces();
    expect(all.map((w) => w.id)).toEqual([good.id]);
  });

  it('the API view drops the internal task counter', async () => {
    const root = await makeTree();
    const ws = await addWorkspace(root, {}, noRegister);
    expect(toWorkspaceView(ws)).not.toHaveProperty('taskCounter');
  });
});

describe('canonicalWorkspaceRoot', () => {
  it('strips a trailing slash', async () => {
    const root = await makeTree();
    expect(await canonicalWorkspaceRoot(`${root}/`)).toBe(root);
  });
});

describe('findWorkspaceContaining', () => {
  const records = [{ root: '/a/foo' }, { root: '/a/foo/inner' }, { root: '/a/foobar' }];

  it('matches the workspace root itself', () => {
    expect(findWorkspaceContaining(records, '/a/foo')?.root).toBe('/a/foo');
  });

  it('prefers the longest (most specific) root', () => {
    expect(findWorkspaceContaining(records, '/a/foo/inner/pkg')?.root).toBe('/a/foo/inner');
  });

  it('respects path-segment boundaries', () => {
    expect(findWorkspaceContaining(records, '/a/foobar/x')?.root).toBe('/a/foobar');
  });

  it('returns null when nothing contains the path', () => {
    expect(findWorkspaceContaining(records, '/b/other')).toBeNull();
  });
});
