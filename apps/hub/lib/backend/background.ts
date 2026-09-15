// Timeline bookkeeping that runs after a mutation has answered: off the request
// path, and every failure swallowed, so a log miss never changes a response.
const pending = new Set<Promise<void>>();

export function inBackground(work: () => Promise<unknown>): void {
  const p = Promise.resolve()
    .then(work)
    .then(
      () => undefined,
      () => undefined,
    );
  pending.add(p);
  void p.then(() => pending.delete(p));
}

/** Wait until every background write started so far has finished (tests). */
export async function backgroundSettled(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
