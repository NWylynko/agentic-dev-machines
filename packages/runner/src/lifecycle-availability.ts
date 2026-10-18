let unavailable: Error | undefined;
let terminalError: Error | undefined;
const waiters = new Set<{
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  abort?: () => void;
}>();

export function lifecycleAvailabilityError() {
  return terminalError ?? unavailable;
}

export function suspendLifecycleAvailability(cause: unknown) {
  if (terminalError || unavailable) return;
  unavailable = cause instanceof Error ? cause : new Error(String(cause));
}

export function restoreLifecycleAvailability() {
  if (terminalError) return;
  unavailable = undefined;
  for (const waiter of waiters) {
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    waiter.resolve();
  }
  waiters.clear();
}

export function failLifecycleAvailability(cause: unknown) {
  terminalError = cause instanceof Error ? cause : new Error(String(cause));
  for (const waiter of waiters) {
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    waiter.reject(terminalError);
  }
  waiters.clear();
}

export async function waitForLifecycleAvailability(signal?: AbortSignal) {
  if (terminalError) throw terminalError;
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (!unavailable) return;
  return new Promise<void>((resolve, reject) => {
    const waiter = {
      signal,
      resolve,
      reject,
      abort: undefined as (() => void) | undefined,
    };
    if (signal) {
      waiter.abort = () => {
        waiters.delete(waiter);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
    }
    waiters.add(waiter);
  });
}
