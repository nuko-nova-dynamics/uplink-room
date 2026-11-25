import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/electron/react";
import { ConvexProviderWithAuth } from "convex/react";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./components/ui-sdk.css";
import { useClerkConvexAuth } from "./lib/auth";
import { RoomConvexClient } from "./lib/roomConvexClient";
import { startTelemetry } from "./lib/telemetry";
import { log, logUncaught, watchBlobScripts } from "./lib/log";
import { App } from "./App";
import { analytics } from "./lib/analytics";
import "./look.css";

const convexUrl = import.meta.env["VITE_CONVEX_URL"] as string | undefined;
const clerkKey = import.meta.env["VITE_CLERK_PUBLISHABLE_KEY"] as string | undefined;

// Before anything can make a blob script or throw: the diagnostic log notes both (docs/logs.md).
watchBlobScripts();
logUncaught();
log.info("app", "window started", { mode: import.meta.env.MODE });
startTelemetry();

const root = createRoot(document.getElementById("root")!);

if (!convexUrl || !clerkKey) {
  root.render(
    <div className="splash">
      <p>
        Set <code>VITE_CONVEX_URL</code> and <code>VITE_CLERK_PUBLISHABLE_KEY</code> in{" "}
        <code>apps/desktop/.env.local</code>.
      </p>
    </div>,
  );
} else {
  void analytics.start();
  const convex = new RoomConvexClient(convexUrl);
  // The Convex connection, in the diagnostic log: each time the socket opens or drops.
  let connected = false;
  convex.subscribeToConnectionState((state) => {
    if (state.isWebSocketConnected === connected) return;
    connected = state.isWebSocketConnected;
    // Before the first connection the socket is just opening: nothing to warn about.
    if (!connected && state.connectionCount === 0) return;
    log[connected ? "info" : "warn"]("convex", connected ? "connected" : "disconnected", { connections: state.connectionCount, retries: state.connectionRetries });
  });
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
        <ConvexProviderWithAuth client={convex} useAuth={useClerkConvexAuth}>
          <App />
        </ConvexProviderWithAuth>
      </ClerkProvider>
    </StrictMode>,
  );
}
