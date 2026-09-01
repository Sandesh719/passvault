import { startSignalingServer } from "./index.js";

const port = Number.parseInt(process.env["PORT"] ?? "8787", 10);
// Behind the reverse proxy that terminates TLS, the socket address is the
// proxy's. Off by default, because trusting the header when nothing sets it
// lets a client choose its own rate-limit bucket.
const trustProxy = process.env["TRUST_PROXY"] === "1";

const server = await startSignalingServer(port, { trustProxy });
console.log(
  `passvault signaling listening on port ${server.port}` +
    (trustProxy ? " (trusting X-Forwarded-For)" : "")
);

/**
 * Shut down when the container asks.
 *
 * A process that ignores SIGTERM is killed after a grace period instead, which
 * drops live signaling sessions rather than closing them.
 */
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
    // A socket that refuses to close must not hold the shutdown open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// One bad request must never take the server down with it.
process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});
