import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both seams are mocked: nothing here may resolve the real ~/.agentbox hub, start
// one, or reach the network.
const resolveHubApiTarget = vi.fn();
const health = vi.fn();
vi.mock('../src/commands/control-plane.js', () => ({ resolveHubApiTarget }));
vi.mock('../src/control-plane/hub-api-client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/control-plane/hub-api-client.js')>();
  return {
    ...orig,
    HubApiClient: class {
      health = health;
    },
  };
});
const logError = vi.fn();
vi.mock('@clack/prompts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@clack/prompts')>();
  return { ...orig, log: { ...orig.log, error: logError, info: vi.fn() } };
});

const { withHubClientQuiet } = await import('../src/control-plane/with-hub.js');

describe('withHubClientQuiet', () => {
  let saved: typeof process.exitCode;
  beforeEach(() => {
    saved = process.exitCode;
    process.exitCode = undefined;
    resolveHubApiTarget.mockReset();
    health.mockReset();
    logError.mockReset();
  });
  afterEach(() => {
    process.exitCode = saved;
  });

  it('leaves the exit code untouched and prints nothing when the hub cannot be resolved', async () => {
    resolveHubApiTarget.mockResolvedValue(null);
    const fn = vi.fn();
    const res = await withHubClientQuiet({ preferLocal: true }, fn);
    expect(res.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(logError).not.toHaveBeenCalled();
    // `quiet` is what keeps resolution from auto-starting a local hub.
    expect(resolveHubApiTarget).toHaveBeenCalledWith(undefined, {
      quiet: true,
      preferLocal: true,
    });
  });

  it('swallows an unreachable hub and a throwing op the same way', async () => {
    resolveHubApiTarget.mockResolvedValue({ url: 'http://127.0.0.1:8787', apiKey: 'k' });
    health.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await withHubClientQuiet({}, vi.fn())).toEqual({ ok: false, error: 'ECONNREFUSED' });
    health.mockResolvedValue({ apiVersion: 'v1' });
    const thrown = await withHubClientQuiet({}, () => Promise.reject(new Error('boom')));
    expect(thrown).toEqual({ ok: false, error: 'boom' });
    expect(process.exitCode).toBeUndefined();
    expect(logError).not.toHaveBeenCalled();
  });

  it('answers the op value when the hub is there', async () => {
    resolveHubApiTarget.mockResolvedValue({ url: 'http://127.0.0.1:8787', apiKey: 'k' });
    health.mockResolvedValue({ apiVersion: 'v1' });
    expect(await withHubClientQuiet({}, () => Promise.resolve(42))).toEqual({
      ok: true,
      value: 42,
    });
  });
});
