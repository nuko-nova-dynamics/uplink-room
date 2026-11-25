---------------------------- MODULE BridgeQuit ----------------------------
(***************************************************************************)
(* The app and the bridge it runs, as the app quits (UPLINK-ROOM-BRIDGE-3).  *)
(*                                                                         *)
(* The app starts its bridge with the bridge's stdout and stderr piped to  *)
(* bridge.log (apps/desktop/src/main/bridge.ts). On quit it sends the      *)
(* bridge SIGTERM and exits without waiting (`void stopBridge()` in        *)
(* before-quit), which closes the pipe. The bridge's shutdown still logs.  *)
(* A write to a closed pipe fails with EPIPE, and with no listener for it  *)
(* that is an uncaught exception: the bridge crashed, mid-shutdown, and    *)
(* reported a fatal error. The app can also die without quitting, so its   *)
(* bridge is never told to stop.                                           *)
(*                                                                         *)
(* HandlesClosedOutput is the fix: the bridge's entry point calls          *)
(* onClosedOutput (packages/protocol/src/closedOutput.ts), so it drops     *)
(* writes once the pipe closes and keeps its course. AppWaitsForBridge is  *)
(* the fix not taken: quitting would wait on the bridge, every time.       *)
(***************************************************************************)
CONSTANTS HandlesClosedOutput, AppWaitsForBridge

VARIABLES app,     \* "running", "quitting" (SIGTERM sent), "gone"
          bridge,  \* "running", "stopping", "stopped", "crashed"
          pipe     \* "open", "closed": the bridge's stdout and stderr

vars == <<app, bridge, pipe>>

Init == app = "running" /\ bridge = "running" /\ pipe = "open"

\* before-quit: stopBridge() sends SIGTERM.
AppQuits ==
  /\ app = "running"
  /\ app' = "quitting"
  /\ bridge' = IF bridge = "running" THEN "stopping" ELSE bridge
  /\ UNCHANGED pipe

\* The app's process ends, and the pipe's read end with it.
AppExits ==
  /\ app = "quitting"
  /\ AppWaitsForBridge => bridge \in {"stopped", "crashed"}
  /\ app' = "gone" /\ pipe' = "closed"
  /\ UNCHANGED bridge

\* A crash, a force quit, a power cut: nobody tells the bridge to stop.
AppDies ==
  /\ app = "running"
  /\ app' = "gone" /\ pipe' = "closed"
  /\ UNCHANGED bridge

\* The bridge writes a log line: while it runs, and while it stops.
BridgeLogs ==
  /\ bridge \in {"running", "stopping"}
  /\ pipe = "closed" /\ ~HandlesClosedOutput
  /\ bridge' = "crashed"
  /\ UNCHANGED <<app, pipe>>

\* Its shutdown (cli.ts `shutdown`) ends terminals, saves its cursor and exits.
BridgeStops ==
  /\ bridge = "stopping"
  /\ bridge' = "stopped"
  /\ UNCHANGED <<app, pipe>>

Next == AppQuits \/ AppExits \/ AppDies \/ BridgeLogs \/ BridgeStops

Spec == Init /\ [][Next]_vars /\ WF_vars(AppExits) /\ WF_vars(BridgeStops)

TypeOK ==
  /\ app \in {"running", "quitting", "gone"}
  /\ bridge \in {"running", "stopping", "stopped", "crashed"}
  /\ pipe \in {"open", "closed"}

\* No uncaught EPIPE: the bridge never crashes because its reader went away.
NoCrash == bridge # "crashed"

\* A quit always ends in a bridge that stopped on its own terms.
QuitStopsBridge == (app = "quitting") ~> (bridge = "stopped")
=============================================================================
