let unavailable: Error | undefined;
let terminalError: Error | undefined;
let available: Promise<void> = Promise.resolve();
let resolveAvailable: (() => void) | undefined;
let rejectAvailable: ((error: Error) => void) | undefined;

export function lifecycleAvailabilityError() {
  return terminalError ?? unavailable;
}

export function suspendLifecycleAvailability(cause: unknown) {
  if (terminalError || unavailable) return;
  unavailable = cause instanceof Error ? cause : new Error(String(cause));
  available = new Promise<void>((resolve, reject) => {
    resolveAvailable = resolve;
    rejectAvailable = reject;
  });
}

export function restoreLifecycleAvailability() {
  if (terminalError) return;
  unavailable = undefined;
  resolveAvailable?.();
  resolveAvailable = undefined;
  rejectAvailable = undefined;
  available = Promise.resolve();
}

export function failLifecycleAvailability(cause: unknown) {
  terminalError = cause instanceof Error ? cause : new Error(String(cause));
  rejectAvailable?.(terminalError);
  rejectAvailable = undefined;
  resolveAvailable = undefined;
}

export async function waitForLifecycleAvailability(signal?: AbortSignal) {
  if (terminalError) throw terminalError;
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!unavailable) return;
  if (!signal) return available;
  return Promise.race([
    available,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  ]);
}
