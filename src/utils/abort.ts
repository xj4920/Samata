let controller = new AbortController();

export function getAbortSignal(): AbortSignal {
  return controller.signal;
}

export function resetAbort(): AbortController {
  controller = new AbortController();
  return controller;
}

export function abort(): void {
  controller.abort();
}

export function throwIfAborted(): void {
  if (controller.signal.aborted) {
    throw new DOMException('cancelled', 'AbortError');
  }
}
