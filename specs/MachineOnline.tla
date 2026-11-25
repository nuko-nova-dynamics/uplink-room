--------------------------- MODULE MachineOnline ---------------------------
(***************************************************************************)
(* How the room marks a machine offline once its bridge goes quiet         *)
(* (packages/backend/convex/lib/machines.ts markSeen, scheduleOnlineCheck; *)
(* convex/machines.ts checkOnline).                                        *)
(*                                                                         *)
(* Convex reruns a query only when data it read changes, never because     *)
(* time passed, so a scheduled mutation, checkOnline, looks when the       *)
(* machine's online window should end: offline if nothing came since, else *)
(* it schedules itself for the new window's end. markSeen, on each word    *)
(* from the bridge, schedules a check unless the one the machine names     *)
(* (onlineCheckId) is still pending. Each mutation is one transaction.     *)
(*                                                                         *)
(* A run of checkOnline can fail inside Convex ("Your request couldn't be  *)
(* completed", UPLINK-ROOM-BACKEND-H): its writes roll back and Convex     *)
(* runs it again. With PermanentFailures a run may also fail for good, as  *)
(* a bug in checkOnline would make it: then a quiet machine stays online.  *)
(*                                                                         *)
(* Time is relative, so the model is finite: `quiet` is how long since the *)
(* bridge was heard from (capped at Window), and each pending check counts *)
(* down to when it's due. Check ids come from a few reusable Slots.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Window,             \* the online window (90 s), in ticks
          Slots,              \* ids for scheduled checks
          PermanentFailures   \* whether a run can fail for good

VARIABLES quiet,     \* ticks since the bridge was last heard from, at most Window
          offline,   \* machines.offlineSince is set
          checkId,   \* machines.onlineCheckId, or 0 for none
          wait,      \* wait[s]: ticks until check s is due, for a pending check
          pending,   \* the checks scheduled and not finished
          bridgeUp   \* whether the bridge is running and heard from

vars == <<quiet, offline, checkId, wait, pending, bridgeUp>>

Min(a, b) == IF a < b THEN a ELSE b

\* scheduleOnlineCheck: a new check, due when the window that started `quiet` ticks ago ends.
Schedule(q) ==
  \E s \in Slots \ pending :
    /\ pending' = pending \cup {s}
    /\ wait' = [wait EXCEPT ![s] = Window - q]
    /\ checkId' = s

\* Pairing calls markSeen, so a machine starts heard from, with one check pending.
Init ==
  /\ quiet = 0 /\ offline = FALSE /\ bridgeUp = TRUE
  /\ \E s \in Slots :
       /\ pending = {s} /\ checkId = s
       /\ wait = [t \in Slots |-> IF t = s THEN Window ELSE 0]

Tick ==
  /\ quiet' = Min(quiet + 1, Window)
  /\ wait' = [s \in Slots |-> IF s \in pending /\ wait[s] > 0 THEN wait[s] - 1 ELSE wait[s]]
  /\ UNCHANGED <<offline, checkId, pending, bridgeUp>>

\* markSeen: a heartbeat, a bridge message, a reconnect.
MarkSeen ==
  /\ bridgeUp
  /\ quiet' = 0 /\ offline' = FALSE
  /\ IF checkId \in pending
       THEN UNCHANGED <<checkId, wait, pending>>
       ELSE Schedule(0)
  /\ UNCHANGED bridgeUp

BridgeStops == bridgeUp /\ bridgeUp' = FALSE /\ UNCHANGED <<quiet, offline, checkId, wait, pending>>
BridgeStarts == ~bridgeUp /\ bridgeUp' = TRUE /\ UNCHANGED <<quiet, offline, checkId, wait, pending>>

\* checkOnline(s) commits.
RunCheck(s) ==
  /\ s \in pending /\ wait[s] = 0
  /\ IF quiet >= Window
       THEN /\ offline' = TRUE /\ checkId' = 0
            /\ pending' = pending \ {s}
            /\ UNCHANGED wait
       ELSE /\ \E t \in Slots \ (pending \ {s}) :
                 /\ pending' = (pending \ {s}) \cup {t}
                 /\ wait' = [wait EXCEPT ![t] = Window - quiet]
                 /\ checkId' = t
            /\ UNCHANGED offline
  /\ UNCHANGED <<quiet, bridgeUp>>

\* A run that fails inside Convex rolls back and stays pending, to run again: a stutter.
\* A run that fails for good ends the check with nothing written.
GivesUp(s) ==
  /\ PermanentFailures
  /\ s \in pending /\ wait[s] = 0
  /\ pending' = pending \ {s}
  /\ UNCHANGED <<quiet, offline, checkId, wait, bridgeUp>>

Next ==
  \/ Tick \/ MarkSeen \/ BridgeStops \/ BridgeStarts
  \/ \E s \in Slots : RunCheck(s) \/ GivesUp(s)

\* Time passes, and Convex runs a due check sooner or later, however often a run fails first.
Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ \A s \in Slots : WF_vars(RunCheck(s))

TypeOK ==
  /\ quiet \in 0..Window /\ offline \in BOOLEAN /\ bridgeUp \in BOOLEAN
  /\ checkId \in Slots \cup {0} /\ pending \subseteq Slots
  /\ wait \in [Slots -> 0..Window]

\* Offline only once the window passed with no word from the bridge.
OfflineOnlyWhenQuiet == offline => quiet >= Window

\* One check at a time, so the scheduler doesn't fill up with them.
OneCheckPending == Cardinality(pending) <= 1

\* An online machine always has a check coming that will look.
CheckComing == ~offline => checkId \in pending

\* A bridge that stops is shown offline, unless it comes back first.
QuietGoesOffline == (~bridgeUp /\ ~offline) ~> (offline \/ bridgeUp)
=============================================================================
