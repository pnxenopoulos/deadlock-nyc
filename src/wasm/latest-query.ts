type Listener<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
type Job<T> = { key: string; run: () => Promise<T>; listeners: Set<Listener<T>> };

const cancelled = () => new DOMException("Query superseded", "AbortError");

/** At most one running job and one latest queued job; identical jobs share work. */
export class LatestQuery<T> {
  private active?: Job<T>;
  private queued?: Job<T>;

  query(key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active?.key === key && this.queued) {
      this.reject(this.queued);
      this.queued = undefined;
    }
    let job = this.active?.key === key ? this.active : this.queued?.key === key ? this.queued : undefined;
    if (!job) {
      if (this.queued) this.reject(this.queued);
      job = { key, run, listeners: new Set() };
      this.queued = job;
    }
    const selected = job;
    const result = new Promise<T>((resolve, reject) => {
      const abort = () => {
        selected.listeners.delete(listener);
        if (this.queued === selected && selected.listeners.size === 0) this.queued = undefined;
        reject(cancelled());
      };
      const listener: Listener<T> = {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      };
      selected.listeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
    });
    this.pump();
    return result;
  }

  cancel(): void {
    if (this.queued) this.reject(this.queued);
    if (this.active) this.reject(this.active);
    this.queued = undefined;
  }

  private reject(job: Job<T>): void {
    for (const listener of job.listeners) listener.reject(cancelled());
    job.listeners.clear();
  }

  private pump(): void {
    if (this.active || !this.queued) return;
    const job = this.queued;
    this.queued = undefined;
    this.active = job;
    void Promise.resolve().then(job.run).then(
      (value) => { for (const listener of job.listeners) listener.resolve(value); },
      (error) => { for (const listener of job.listeners) listener.reject(error instanceof Error ? error : new Error(String(error))); },
    ).finally(() => { this.active = undefined; this.pump(); });
  }
}
