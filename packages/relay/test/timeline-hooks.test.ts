import { describe, expect, it } from 'vitest';
import { prMergeRepo, prMergeTarget, prViewArgs } from '../src/timeline-hooks.js';
import { GH_PR_JSON_FIELDS } from '../src/workspaces/timeline-pr.js';

describe('gh pr merge parsing', () => {
  it('skips the value of -R/--repo when finding the PR', () => {
    expect(prMergeTarget(['-R', 'o/r', '409', '--squash'])).toBe('409');
    expect(prMergeTarget(['--repo', 'o/r', '--squash'])).toBeUndefined();
    expect(prMergeTarget(['--squash', '-b', 'body', 'feature/x'])).toBe('feature/x');
  });

  it('finds the repo in every spelling, and not in another flag value', () => {
    expect(prMergeRepo(['-R', 'o/r', '409'])).toBe('o/r');
    expect(prMergeRepo(['409', '--repo', 'github.example.com/o/r'])).toBe('github.example.com/o/r');
    expect(prMergeRepo(['--repo=o/r', '409'])).toBe('o/r');
    expect(prMergeRepo(['-Ro/r'])).toBe('o/r');
    expect(prMergeRepo(['-b', '--repo', '409'])).toBeUndefined();
    expect(prMergeRepo(['409'])).toBeUndefined();
  });

  it('scopes the follow-up gh pr view to that repo', () => {
    expect(prViewArgs([], '409', 'o/r')).toEqual([
      'pr',
      'view',
      '409',
      '--repo',
      'o/r',
      '--json',
      GH_PR_JSON_FIELDS,
    ]);
    expect(prViewArgs(['--hostname', 'h'], '409', undefined)).toEqual([
      '--hostname',
      'h',
      'pr',
      'view',
      '409',
      '--json',
      GH_PR_JSON_FIELDS,
    ]);
  });
});
