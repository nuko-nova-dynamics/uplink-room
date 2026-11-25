import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery } from "convex/react";
import { getFunctionName, makeFunctionReference, type FunctionReference } from "convex/server";
import { errorMessage } from "./errors";
import type { Id, MemberRow, MyTeam } from "./api";
import { api } from "./api";
import { Icon } from "../components/Icon";
import {
  Toast,
  ToastAction as UiToastAction,
  ToastRegion,
  ToastTitle,
  createToaster,
} from "@ui-sdk/react/toast";
import { setTelemetryMember } from "./telemetry";
import { pendingActions } from "./pendingActions";

export type Session = {
  team: MyTeam;
  teamId: Id<"teams">;
  me: { memberId: Id<"members">; name: string; role: "admin" | "member" };
  members: MemberRow[];
  isAdmin: boolean;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ team, children }: { team: MyTeam; children: ReactNode }) {
  const members = useQuery(api.teams.members, { teamId: team.teamId });
  // A Settle or Snooze queued when the window closed is sent now, once its Undo time is past.
  const settle = useMutation(api.inbox.settle);
  const snooze = useMutation(api.inbox.snooze);
  useEffect(() => {
    const teamId = team.teamId;
    pendingActions.replay(teamId, (a) =>
      a.kind === "settle"
        ? settle({ teamId, ...a.args } as never)
        : snooze({ teamId, ...a.args } as never),
    );
    // Once per team: the mutations' identity doesn't matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.teamId]);
  // Error reports name the member by id only, never by name or email.
  useEffect(() => {
    setTelemetryMember(team.memberId);
    return () => setTelemetryMember(null);
  }, [team.memberId]);
  const value = useMemo<Session | null>(() => {
    if (!members) return null;
    const me = members.find((m) => m.memberId === team.memberId);
    return {
      team,
      teamId: team.teamId,
      me: { memberId: team.memberId, name: me?.name ?? "You", role: team.role },
      members,
      isAdmin: team.role === "admin",
    };
  }, [members, team]);
  if (!value) return null;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside a team");
  return session;
}

/** Room API queries for the current team: `useRoomQuery(api.tasks.board, { projectId })`. */
export function useRoomQuery<Q extends FunctionReference<"query">>(
  query: Q,
  args: Omit<Q["_args"], "teamId"> | "skip",
): Q["_returnType"] | undefined {
  const { teamId } = useSession();
  // The generic can't prove `{ teamId, ...args }` is `Q["_args"]`; the Room API adds `teamId` to every function.
  return useQuery(query, (args === "skip" ? "skip" : { teamId, ...args }) as never) as
    | Q["_returnType"]
    | undefined;
}

/**
 * Like `useRoomQuery`, but an error (such as not_found for a terminal whose run is hidden from the
 * viewer) comes back as `failed` (undefined unless given) instead of throwing during render. For
 * previews a screen can do without: one failing must not take the screen down.
 */
export function useSoftRoomQuery<Q extends FunctionReference<"query">, F = undefined>(
  query: Q,
  args: Omit<Q["_args"], "teamId"> | "skip",
  failed?: F,
): Q["_returnType"] | undefined | F {
  const { teamId } = useSession();
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  // Keyed on the function's name: `api.x.y` is a new reference on every render (convex's anyApi), and
  // useQueries resubscribes whenever its request object changes, which loops (React error 301).
  const name = getFunctionName(query);
  const request = useMemo(
    () =>
      key === "skip"
        ? {}
        : { q: { query: makeFunctionReference<"query">(name), args: { teamId, ...(JSON.parse(key) as object) } } },
    [name, teamId, key],
  );
  const result = (useQueries(request as never) as Record<string, unknown>)["q"];
  return result instanceof Error ? (failed as F) : (result as Q["_returnType"] | undefined);
}

/**
 * One Room API query called several times, each with its own args, softly: a call that fails comes
 * back as `failed` (undefined unless given) instead of throwing during render. For a request a
 * screen splits to stay under a function's limit, such as repo statuses 100 at a time.
 */
export function useSoftRoomQueries<Q extends FunctionReference<"query">, F = undefined>(
  query: Q,
  argsList: Omit<Q["_args"], "teamId">[],
  failed?: F,
): (Q["_returnType"] | undefined | F)[] {
  const { teamId } = useSession();
  const key = JSON.stringify(argsList);
  // Keyed on the function's name and the args' JSON, as useSoftRoomQuery is, so a re-render with the
  // same args keeps the same subscriptions.
  const name = getFunctionName(query);
  const request = useMemo(
    () =>
      Object.fromEntries(
        (JSON.parse(key) as object[]).map((args, i) => [String(i), { query: makeFunctionReference<"query">(name), args: { teamId, ...args } }]),
      ),
    [name, teamId, key],
  );
  const results = useQueries(request as never) as Record<string, unknown>;
  return argsList.map((_, i) => {
    const result = results[String(i)];
    return result instanceof Error ? (failed as F) : (result as Q["_returnType"] | undefined);
  });
}

// ---------- toasts ----------

/** A toast's one button, such as Undo. It closes the toast. */
export type ToastAction = { label: string; onClick(): void; ms: number };
type ToastApi = { show(text: string, ok?: boolean, action?: ToastAction): void };
const ToastContext = createContext<ToastApi>({ show: () => {} });

/**
 * Toasts on UI SDK's Toast: a success says so briefly, a failure stays longer, and either can carry
 * one button (Undo) that closes it. They stack at the top of the window, above any open dialog.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toaster] = useState(() => createToaster());
  useEffect(() => () => void toaster.dismiss(), [toaster]);
  const show = useCallback(
    (text: string, ok = false, action?: ToastAction) => {
      const id = toaster(text, {
        type: ok ? "success" : "error",
        // A toast's timer pauses while the pointer rests on it. A button such as Undo works only
        // until its own deadline, so that toast closes then, hovered or not.
        duration: action ? Infinity : ok ? 3500 : 7000,
        action: action
          ? { label: action.label, onAction: () => action.onClick(), dismiss: true }
          : undefined,
      });
      if (action) setTimeout(() => void toaster.dismiss(id), action.ms);
    },
    [toaster],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toaster={toaster} side="top" align="center" expanded className="toasts">
        {(item) => (
          <Toast className="toast">
            <span className={item.type === "success" ? "state-done" : "state-failed"}>
              <Icon name={item.type === "success" ? "check" : "x"} />
            </span>
            <ToastTitle render={<span />} />
            {item.action ? <UiToastAction className="btn small ghost toast-action" /> : null}
          </Toast>
        )}
      </ToastRegion>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/**
 * A Room API mutation for the current team. It adds `teamId`, and shows the
 * API's error message in a toast when the call fails (then returns undefined).
 */
export function useAct<M extends FunctionReference<"mutation">>(
  mutation: M,
  options: { success?: string } = {},
): (args: Omit<M["_args"], "teamId">) => Promise<M["_returnType"] | undefined> {
  const { teamId } = useSession();
  const toast = useToast();
  const run = useMutation(mutation);
  const success = options.success;
  return useCallback(
    async (args) => {
      try {
        const result = await run({ teamId, ...args } as M["_args"]);
        if (success) toast.show(success, true);
        return result ?? (true as M["_returnType"]);
      } catch (error) {
        toast.show(errorMessage(error));
        return undefined;
      }
    },
    [run, teamId, toast, success],
  );
}

/**
 * `useAct` for a button pressed once: while a call is out, `pending` is true and another press
 * sends nothing, so repeated clicks can't stack calls or toasts.
 */
export function useActOnce<M extends FunctionReference<"mutation">>(
  mutation: M,
  options: { success?: string } = {},
): [(args: Omit<M["_args"], "teamId">) => Promise<M["_returnType"] | undefined>, boolean] {
  const act = useAct(mutation, options);
  const out = useRef(false);
  const [pending, setPending] = useState(false);
  const once = useCallback(
    async (args: Omit<M["_args"], "teamId">) => {
      if (out.current) return undefined;
      out.current = true;
      setPending(true);
      try {
        return await act(args);
      } finally {
        out.current = false;
        setPending(false);
      }
    },
    [act],
  );
  return [once, pending];
}
