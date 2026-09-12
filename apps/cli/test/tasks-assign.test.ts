import { describe, expect, it } from 'vitest';
import { parseTaskIds, TaskIdError } from '../src/lib/tasks-assign.js';

describe('parseTaskIds', () => {
  it('splits, trims and dedupes', () => {
    expect(parseTaskIds('T-1, T-2 ,T-1')).toEqual(['T-1', 'T-2']);
  });

  it('rejects an id that is not T-<number>', () => {
    expect(() => parseTaskIds('T-1,nope')).toThrow(TaskIdError);
    expect(() => parseTaskIds('t-1')).toThrow(TaskIdError);
    expect(() => parseTaskIds('T-')).toThrow(TaskIdError);
  });

  it('rejects an empty list', () => {
    expect(() => parseTaskIds('')).toThrow(TaskIdError);
    expect(() => parseTaskIds(' , ')).toThrow(TaskIdError);
  });
});
