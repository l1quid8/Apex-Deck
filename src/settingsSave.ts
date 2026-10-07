/** Serialize setting writes and keep only the newest pending value. */
export function latestSaveQueue<T>(write: (value: T) => Promise<void>) {
  type Waiting = { resolve: () => void; reject: (error: unknown) => void };
  let running = false;
  let pending: { value: T; waiting: Waiting[] } | undefined;
  const drain = async () => {
    running = true;
    while (pending) {
      const job = pending;
      pending = undefined;
      try {
        await write(job.value);
        job.waiting.forEach(waiter => waiter.resolve());
      } catch (error) {
        job.waiting.forEach(waiter => waiter.reject(error));
      }
    }
    running = false;
  };
  return (value: T): Promise<void> => new Promise((resolve, reject) => {
    if (pending) {
      pending.value = value;
      pending.waiting.push({ resolve, reject });
    } else pending = { value, waiting: [{ resolve, reject }] };
    if (!running) void drain();
  });
}
