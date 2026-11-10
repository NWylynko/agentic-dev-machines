import { createServer } from "node:net";

// A free port for a process that must know its port before it starts (Pod
// runtimes share ADM_RUNTIME_PORT). Picked below Linux's ephemeral range
// (32768-60999): a port from listen(0) is in that range, and once released the
// kernel hands it straight back out to other test processes' listen(0) calls
// and outbound connections, which then race the runner for it (EADDRINUSE).
export async function unusedFixedPort() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const server = createServer();
    const listening = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      // Every address, so it is free whichever host the caller binds.
      server.listen(port, () => resolve(true));
    });
    if (!listening) continue;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }
}
