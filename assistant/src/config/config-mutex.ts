let chain: Promise<unknown> = Promise.resolve();

/**
 * Serializes async writers to the workspace `config.json`. Every caller that
 * mutates the workspace config (seeder, discovery service, PATCH route) must
 * go through this so concurrent writers do not tear the file.
 *
 * Errors thrown by `fn` propagate to the caller, and the lock is released
 * either way so a failing writer does not deadlock subsequent ones.
 */
export async function withConfigWriteLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const prior = chain;
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  chain = chain.then(() => next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
  }
}
