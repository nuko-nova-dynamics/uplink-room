// Preloaded into Vitest's fork workers (`execArgv` in the vitest configs that use it): a worker
// exits when its channel to Vitest closes.
//
// Vitest 5's fork worker exits only when a message to Vitest fails, or when nothing keeps Node
// running. If Vitest's own process dies first (killed, or crashed on EPIPE after `| grep -q` or
// `| head` closed its output), a worker that is waiting stays. convex-test keeps a timer for every
// scheduled function, some of them days long, so a backend or room-client worker stayed with
// parent pid 1 until its last scheduled function was due: up to 7 days.
//
// process.exit is kept from before Vitest replaces it with a guard while a test runs.
const exit = process.exit.bind(process);
if (process.send) process.once("disconnect", () => exit(1));
