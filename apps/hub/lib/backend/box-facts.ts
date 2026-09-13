// The box seams the timeline reads (`BackendDeps.boxFacts` / `boxDiffStat`),
// built from the host's box records. Kept out of `hub-backend.ts`, which only
// hands in the two functions it owns.
import { hashProjectPath } from '@agentbox/config';
import type { BoxRecord, Provider } from '@agentbox/core';
import { BOX_WORKSPACE } from '@agentbox/sandbox-core';
import type { ListedBox } from '@agentbox/sandbox-docker';
import type { DiffStat, TimelineBoxFact } from './deps';
import { parseShortstat } from './timeline';

export interface BoxFactSources {
  listBoxes(): Promise<ListedBox[]>;
  providerForBox(box: BoxRecord): Promise<Provider>;
}

export function boxFactOf(b: ListedBox): TimelineBoxFact {
  const root = b.projectRoot ?? b.workspacePath ?? b.id;
  const tree = b.gitWorktrees?.[0];
  const branches = [
    tree?.sanctionedBranch,
    tree?.branch,
    b.cloud?.sanctionedBranch,
    b.cloud?.workspaceBranch,
  ].filter((x): x is string => Boolean(x));
  const agent = b.lastAgent === 'claude-code' ? 'claude' : b.lastAgent;
  return {
    id: b.id,
    name: b.name,
    branches: [...new Set(branches)],
    ...(b.state ? { state: b.state } : {}),
    ...(agent ? { agent } : {}),
    projectRoot: root,
    projectId: hashProjectPath(root),
  };
}

export function createBoxFactSeams(src: BoxFactSources): {
  boxFacts(): Promise<TimelineBoxFact[]>;
  boxDiffStat(boxId: string): Promise<DiffStat | null>;
} {
  return {
    async boxFacts() {
      return (await src.listBoxes()).map(boxFactOf);
    },
    async boxDiffStat(boxId) {
      const box = (await src.listBoxes()).find((b) => b.id === boxId);
      if (!box) return null;
      const provider = await src.providerForBox(box);
      const r = await provider.exec(box, ['git', 'diff', '--shortstat'], { cwd: BOX_WORKSPACE });
      return r.exitCode === 0 ? parseShortstat(r.stdout) : null;
    },
  };
}
