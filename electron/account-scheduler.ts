export interface AccountTask {
  key: string;
  accountId: number;
}

export class AccountTaskScheduler<T extends AccountTask> {
  private readonly pending: T[] = [];
  private readonly activeKeys = new Set<string>();
  private readonly activeAccountIds = new Set<number>();
  private draining = false;

  constructor(
    private readonly getConcurrency: () => number,
    private readonly worker: (item: T) => Promise<void>,
    private readonly onWorkerError: (error: unknown) => void = () => undefined
  ) {}

  enqueue(item: T) {
    if (this.activeKeys.has(item.key) || this.pending.some((queued) => queued.key === item.key)) {
      return false;
    }
    this.pending.push(item);
    this.drain();
    return true;
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const concurrency = Math.max(1, Math.trunc(this.getConcurrency()) || 1);
      while (this.activeKeys.size < concurrency) {
        const nextIndex = this.pending.findIndex(
          (item) => !this.activeAccountIds.has(item.accountId)
        );
        if (nextIndex < 0) break;

        const [item] = this.pending.splice(nextIndex, 1);
        this.activeKeys.add(item.key);
        this.activeAccountIds.add(item.accountId);

        void Promise.resolve()
          .then(() => this.worker(item))
          .catch((error) => this.onWorkerError(error))
          .finally(() => {
            this.activeKeys.delete(item.key);
            this.activeAccountIds.delete(item.accountId);
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}
