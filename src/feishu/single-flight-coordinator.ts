export type SingleFlightRunRequest<TMessage> = {
  runId: string;
  messages: TMessage[];
  abortSignal: AbortSignal;
};

type ActiveRun<TResult> = {
  runId: string;
  controller: AbortController;
  phase: 'running' | 'completed';
  result?: TResult;
};

export type SingleFlightCoordinatorOptions<TMessage, TResult> = {
  debounceMs: number;
  quietMs: number;
  run: (request: SingleFlightRunRequest<TMessage>) => Promise<TResult>;
  commit: (request: SingleFlightRunRequest<TMessage>, result: TResult) => Promise<void>;
  onMerged?: (message: TMessage, pendingCount: number) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onIdle?: () => void;
};

let runSeq = 0;

function nextRunId(): string {
  runSeq += 1;
  return `run_${Date.now().toString(36)}_${runSeq.toString(36)}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
    || err instanceof Error && err.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('superseded', 'AbortError');
}

/**
 * Keeps one agent run active per conversation while still accepting new input.
 * New input aborts the current draft and is merged into the next run.
 */
export class SingleFlightCoordinator<TMessage, TResult> {
  private readonly pending: TMessage[] = [];
  private active: ActiveRun<TResult> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelledGeneration = 0;

  constructor(private readonly options: SingleFlightCoordinatorOptions<TMessage, TResult>) {}

  enqueue(message: TMessage): void {
    this.pending.push(message);
    this.clearQuietTimer();

    if (this.active) {
      this.options.onMerged?.(message, this.pending.length);
      if (this.active.phase === 'completed') {
        this.active.controller.abort();
        this.active = null;
        this.scheduleStart(this.options.debounceMs);
      } else {
        this.active.controller.abort();
      }
      return;
    }

    this.scheduleStart(this.options.debounceMs);
  }

  cancel(): void {
    this.cancelledGeneration += 1;
    this.pending.length = 0;
    this.clearDebounceTimer();
    this.clearQuietTimer();
    if (this.active) {
      this.active.controller.abort();
      this.active = null;
    }
    this.options.onIdle?.();
  }

  isCurrent(runId: string): boolean {
    return this.active?.runId === runId && !this.active.controller.signal.aborted;
  }

  isIdle(): boolean {
    return this.pending.length === 0 && !this.active && !this.debounceTimer && !this.quietTimer;
  }

  private scheduleStart(delayMs: number): void {
    if (this.active || this.pending.length === 0) return;
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startNextRun();
    }, Math.max(0, delayMs));
  }

  private async startNextRun(): Promise<void> {
    if (this.active || this.pending.length === 0) return;

    const generation = this.cancelledGeneration;
    const messages = this.pending.splice(0);
    const controller = new AbortController();
    const request: SingleFlightRunRequest<TMessage> = {
      runId: nextRunId(),
      messages,
      abortSignal: controller.signal,
    };

    this.active = { runId: request.runId, controller, phase: 'running' };

    try {
      const result = await this.options.run(request);
      if (generation !== this.cancelledGeneration || !this.isCurrent(request.runId) || this.pending.length > 0) {
        controller.abort();
        throw abortError();
      }
      this.active = { runId: request.runId, controller, phase: 'completed', result };
      this.scheduleCommit(request, result);
    } catch (err) {
      if (!isAbortError(err)) {
        await this.options.onError?.(err);
      }
      if (this.active?.runId === request.runId) this.active = null;
      if (this.pending.length > 0) {
        this.scheduleStart(0);
      } else if (!this.active) {
        this.options.onIdle?.();
      }
    }
  }

  private scheduleCommit(request: SingleFlightRunRequest<TMessage>, result: TResult): void {
    this.clearQuietTimer();
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      void this.commitIfCurrent(request, result);
    }, Math.max(0, this.options.quietMs));
  }

  private async commitIfCurrent(request: SingleFlightRunRequest<TMessage>, result: TResult): Promise<void> {
    try {
      if (!this.isCurrent(request.runId) || this.pending.length > 0) {
        this.active?.controller.abort();
        throw abortError();
      }
      await this.options.commit(request, result);
    } catch (err) {
      if (!isAbortError(err)) {
        await this.options.onError?.(err);
      }
    } finally {
      if (this.active?.runId === request.runId) this.active = null;
      if (this.pending.length > 0) {
        this.scheduleStart(0);
      } else {
        this.options.onIdle?.();
      }
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }
}
