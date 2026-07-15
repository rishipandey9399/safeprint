export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCleanupJob } = await import("./lib/cleanup");
    startCleanupJob();
  }
}
