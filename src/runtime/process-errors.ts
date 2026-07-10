let installed = false;

export function isBrokenPipeError(err: unknown): boolean {
  const maybeErr = err as NodeJS.ErrnoException | undefined;
  return maybeErr?.code === 'EPIPE' || maybeErr?.errno === -32;
}

function handleStreamError(err: Error): void {
  if (isBrokenPipeError(err)) return;
  throw err;
}

function handleUncaughtException(err: Error): void {
  if (isBrokenPipeError(err)) return;
  process.off('uncaughtException', handleUncaughtException);
  throw err;
}

export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;

  process.stdout.on('error', handleStreamError);
  process.stderr.on('error', handleStreamError);
  process.on('uncaughtException', handleUncaughtException);
}
