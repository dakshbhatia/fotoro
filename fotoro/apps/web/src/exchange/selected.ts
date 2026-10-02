/* Reconcile the prior original before allowing another source into durable staging. */
export async function syncSelectedSequential<T>(
  files: T[],
  options: {
    stage: (file: T) => Promise<void>;
    drain: () => Promise<void>;
    unresolved: () => Promise<boolean>;
    skipped: (file: T, error: unknown) => Promise<void>;
    current: () => boolean;
    signal?: AbortSignal;
  },
) {
  const check = () => {
    if (!options.current()) throw new Error("VAULT_LOCKED");
    options.signal?.throwIfAborted();
  };
  check();
  await options.drain();
  check();
  if (await options.unresolved()) return { stopped: true };
  check();
  for (const file of files) {
    check();
    try {
      await options.stage(file);
      check();
    } catch (error) {
      check();
      await options.skipped(file, error);
      check();
    }
    await options.drain();
    check();
    if (await options.unresolved()) return { stopped: true };
    check();
  }
  return { stopped: false };
}
