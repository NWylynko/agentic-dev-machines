// Waits are for things that must happen, so a long budget costs nothing when they
// do. Short ones failed on busy machines: Pi alone takes ~2.5 s to start when idle.
export const TERMINAL_WAIT_MS = 60_000;
export const TERMINAL_TEST_TIMEOUT_MS = 180_000;
