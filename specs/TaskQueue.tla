----------------------------- MODULE TaskQueue -----------------------------
(***************************************************************************)
(* How the room starts queued tasks on one machine (ADR 0050;              *)
(* packages/backend/convex/tasks.ts dispatchQueue and startQueued).        *)
(*                                                                         *)
(* dispatchQueue looks at the machine's queue oldest first. A row still    *)
(* marked starting after its start ran (the start threw, so Convex rolled  *)
(* it back and the mark stayed) is marked stuck and skipped. While a start *)
(* is under way it does nothing more. Otherwise it marks the oldest ready  *)
(* task (every task it needs closed, a slot free) starting and schedules   *)
(* startQueued, which checks again and starts it. Each mutation is one     *)
(* transaction.                                                            *)
(*                                                                         *)
(* A task in Broken throws when it starts, as a start the room didn't      *)
(* foresee would. With Inline the model is the first design, from before   *)
(* the review: dispatchQueue started tasks itself, so a start that threw   *)
(* rolled the whole dispatch back, every time.                             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Slots,    \* the machine's slots
          Inline    \* the first design: dispatchQueue starts tasks itself

\* Three queued tasks, oldest first: c's start throws, a is ready, and b waits for a.
Order == <<"c", "a", "b">>
Needs == [t \in {"a", "b", "c"} |-> IF t = "b" THEN {"a"} ELSE {}]
Broken == {"c"}

Tasks == {Order[i] : i \in 1..Len(Order)}

VARIABLES queued,    \* rows in taskQueue
          starting,  \* rows marked startingAt
          pending,   \* startQueued calls scheduled and not yet run
          stuck,     \* rows marked stuck
          running,   \* tasks whose terminal is live, each holding a slot
          started,   \* tasks a run started for
          closed,    \* closed tasks (tasks.keepRun)
          starts     \* how many runs each task got

vars == <<queued, starting, pending, stuck, running, started, closed, starts>>

TypeOK ==
  /\ queued \subseteq Tasks /\ starting \subseteq Tasks /\ pending \subseteq Tasks
  /\ stuck \subseteq Tasks /\ running \subseteq Tasks /\ started \subseteq Tasks
  /\ closed \subseteq Tasks /\ starts \in [Tasks -> Nat]

Init ==
  /\ queued = Tasks
  /\ starting = {}
  /\ pending = {}
  /\ stuck = {}
  /\ running = {}
  /\ started = {}
  /\ closed = {}
  /\ starts = [t \in Tasks |-> 0]

Pos(t) == CHOOSE i \in 1..Len(Order) : Order[i] = t
Ready(t) == Needs[t] \subseteq closed
SlotFree == Cardinality(running) < Slots
Waiting == queued \ (stuck \cup starting)
\* The oldest row that is ready: dispatchQueue skips the rest, which keep their places.
FirstReady == {t \in Waiting : Ready(t) /\ \A u \in Waiting : Ready(u) => Pos(t) <= Pos(u)}

Start(t) ==
  /\ queued' = queued \ {t}
  /\ running' = running \cup {t}
  /\ started' = started \cup {t}
  /\ starts' = [starts EXCEPT ![t] = @ + 1]

Dispatch ==
  /\ ~Inline
  /\ LET failed == starting \ pending IN
       IF failed # {}
         THEN /\ stuck' = stuck \cup failed
              /\ starting' = starting \ failed
              /\ UNCHANGED <<queued, pending, running, started, closed, starts>>
         ELSE /\ starting = {}
              /\ SlotFree
              /\ \E t \in FirstReady :
                   /\ starting' = {t}
                   /\ pending' = pending \cup {t}
              /\ UNCHANGED <<queued, stuck, running, started, closed, starts>>

StartQueued(t) ==
  /\ t \in pending
  /\ pending' = pending \ {t}
  /\ IF t \in Broken
       \* It throws: Convex rolls it back, and only the scheduled call is used up.
       THEN UNCHANGED <<queued, starting, stuck, running, started, closed, starts>>
       ELSE IF t \in queued /\ Ready(t) /\ SlotFree
              THEN /\ Start(t)
                   /\ starting' = starting \ {t}
                   /\ UNCHANGED <<stuck, closed>>
              ELSE /\ starting' = starting \ {t}
                   /\ UNCHANGED <<queued, stuck, running, started, closed, starts>>

\* The first design: a start that throws rolls back the whole dispatch, so nothing changes.
DispatchInline ==
  /\ Inline
  /\ SlotFree
  /\ \E t \in FirstReady :
       IF t \in Broken
         THEN UNCHANGED vars
         ELSE /\ Start(t)
              /\ UNCHANGED <<starting, pending, stuck, closed>>

\* The run's terminal ends, freeing its slot (lib/bridgeMessages.ts endTerminal).
EndTerminal(t) ==
  /\ t \in running
  /\ running' = running \ {t}
  /\ UNCHANGED <<queued, starting, pending, stuck, started, closed, starts>>

\* Its owner keeps the run, closing the task.
Close(t) ==
  /\ t \in started \ running
  /\ t \notin closed
  /\ closed' = closed \cup {t}
  /\ UNCHANGED <<queued, starting, pending, stuck, running, started, starts>>

Next ==
  \/ Dispatch
  \/ DispatchInline
  \/ \E t \in Tasks : StartQueued(t) \/ EndTerminal(t) \/ Close(t)

\* The cron and the triggers keep calling dispatch; scheduled calls run; terminals end; owners close.
Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(Dispatch)
  /\ WF_vars(DispatchInline)
  /\ \A t \in Tasks : WF_vars(StartQueued(t)) /\ WF_vars(EndTerminal(t)) /\ WF_vars(Close(t))

\* Never more live terminals than slots.
SlotsRespected == Cardinality(running) <= Slots
\* A task gets at most one run from the queue.
StartsOnce == \A t \in Tasks : starts[t] <= 1
\* A task starts only once every task it needs is closed.
NeedsClosedFirst == \A t \in started : Needs[t] \subseteq closed
\* Every queued task either starts or, if its start keeps failing, is marked stuck: none blocks the rest.
Progress == \A t \in Tasks : <>(t \in started \/ t \in stuck)
=============================================================================
