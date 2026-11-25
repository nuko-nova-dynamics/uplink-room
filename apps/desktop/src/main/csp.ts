/**
 * What the built renderer may load (served with every `uplink-room://app` page, main/index.ts):
 * Clerk for sign-in (its Frontend API, Cloudflare's challenge, Clerk Protect, telemetry and
 * images), Convex for data and for the short-lived file links its site serves (a direct message's
 * or a Pair's PDF, which the PDF viewer fetches: ADR 0016, ADR 0048), LiveKit for calls (LiveKit Cloud, Krisp's model service, and a dev
 * server on 127.0.0.1), PostHog for product analytics (sending only; its scripts are bundled, see
 * renderer/lib/analytics.ts), Google Fonts, and the HTML frame.
 *
 * Krisp noise cancellation (@livekit/krisp-noise-filter) runs its code from `blob:` scripts and
 * compiles WebAssembly, so `script-src` has `blob:` and `'wasm-unsafe-eval'`. Without the latter,
 * Chromium refuses to compile the module (`CompileError: WebAssembly.Module(): ... 'unsafe-eval'
 * is not an allowed source of script`), Krisp never turns on, and its enable step never settles,
 * which in 0.2.0 to 0.2.2 also held back the call's heartbeat. `'wasm-unsafe-eval'` allows
 * WebAssembly only, never JavaScript `eval`.
 */
import { FRAME_SCHEME } from "./frame";
import { POSTHOG_ASSETS_HOST, POSTHOG_HOST } from "./analyticsSpec";

export const LIVEKIT = "wss://*.livekit.cloud https://*.livekit.cloud https://integrations.livekit.io";

/** The app's policy, for the Clerk Frontend API host its publishable key names (or Clerk's development hosts). */
export function appCsp(clerkHost: string | undefined): string {
  const clerk = [`https://${clerkHost ?? "*.clerk.accounts.dev"}`, "https://*.clerk.accounts.dev"].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${clerk} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${clerk} https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com https://*.convex.cloud wss://*.convex.cloud https://*.convex.site ${LIVEKIT} ${POSTHOG_HOST} ${POSTHOG_ASSETS_HOST} http://127.0.0.1:* ws://127.0.0.1:*`,
    // Space views (spec #6) load from a loopback port that forwards to a bridge's Space gateway.
    `frame-src ${FRAME_SCHEME}: 'self' http://127.0.0.1:* https://challenges.cloudflare.com https://*.protect.clerk.com ${clerk}`,
    "worker-src 'self' blob:",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
