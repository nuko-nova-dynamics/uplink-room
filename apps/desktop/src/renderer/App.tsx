import { useEffect, useState } from "react";
import { SignIn, useAuth } from "@clerk/electron/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api, type Id, type MyTeam } from "./lib/api";
import { errorMessage } from "./lib/errors";
import { lastTeam, rememberTeam, usePreferences, type Preferences } from "./lib/theme";
import { SessionProvider, ToastProvider, useToast } from "./lib/session";
import { clerkAppearance } from "./lib/clerkAppearance";
import { analytics, track } from "./lib/analytics";
import { retryConvexAuth } from "./lib/auth";
import { endAppCall } from "./lib/call";
import { log } from "./lib/log";
import { LinkMascot } from "./characters/LinkMascot";
import { Wordmark } from "./components/Wordmark";
import { Shell } from "./Shell";
import { UpdateReady } from "./components/UpdateReady";
import { JoinInvite } from "./components/JoinInvite";
import { TeamForms } from "./components/TeamForms";
import { NoTeamHome } from "./views/NoTeam";
import { clearInvite, clearOpen, NOTHING_TO_OPEN, openLinkTeamStep, startDeepLinks, useDeepLinks } from "./lib/deepLinks";

const isMac =
  typeof window !== "undefined" &&
  (window as unknown as { uplink?: { platform?: string } }).uplink?.platform === "darwin";

export function App() {
  const prefs = usePreferences();
  // Join and open links (lib/deepLinks.ts) are taken from the start, so one that opened the app
  // waits through sign-in.
  useEffect(() => startDeepLinks(), []);
  return (
    <ToastProvider>
      <div className={isMac ? "" : "no-mac-inset"} style={{ height: "100%" }}>
        <Auth prefs={prefs} />
      </div>
    </ToastProvider>
  );
}

type Prefs = Preferences;

function Auth({ prefs }: { prefs: Prefs }) {
  const { isLoaded, isSignedIn } = useAuth();
  const convex = useConvexAuth();
  useSignedOutEvent(isLoaded, isSignedIn);
  useSessionLog(isLoaded, isSignedIn, convex.isLoading, convex.isAuthenticated);
  if (!isLoaded || (isSignedIn && convex.isLoading)) return <Splash text="Loading" />;
  if (!isSignedIn) {
    return (
      <div className="gate">
        <div className="gate-drag" />
        <div className="gate-card" style={{ alignItems: "center" }}>
          <Wordmark size={26} lively />
          <SignIn routing="hash" withSignUp appearance={clerkAppearance(prefs.theme)} />
        </div>
        <UpdateReady placement="gate" />
      </div>
    );
  }
  if (!convex.isAuthenticated) return <Splash text="Connecting to your team" />;
  return <Teams prefs={prefs} />;
}

/**
 * The sign-in and the Convex session, in the diagnostic log. Signing out ends the call at once.
 * When Convex refuses a session Clerk still has (a token that expired while the computer slept,
 * fetched while the network was still coming back), it's handed to Convex again, sooner at first.
 */
function useSessionLog(isLoaded: boolean, isSignedIn: boolean | undefined, convexLoading: boolean, convexAuthenticated: boolean) {
  useEffect(() => {
    if (!isLoaded) return;
    log.info("auth", isSignedIn ? "signed in" : "signed out");
    if (!isSignedIn) void endAppCall();
  }, [isLoaded, isSignedIn]);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || convexLoading) return;
    log.info("auth", convexAuthenticated ? "convex session accepted" : "convex session refused");
  }, [isLoaded, isSignedIn, convexLoading, convexAuthenticated]);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || convexLoading) return;
    if (convexAuthenticated) {
      setTries(0);
      return;
    }
    const wait = Math.min(2_000 * 2 ** tries, 30_000);
    const timer = setTimeout(() => {
      log.warn("auth", "handing the session to convex again", { attempt: tries + 1 });
      setTries((t) => t + 1);
      retryConvexAuth();
    }, wait);
    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn, convexLoading, convexAuthenticated, tries]);
}

/** The Clerk session this install last saw, so a reload or restart doesn't count as signing in again. */
const SESSION_KEY = "uplink.analytics.session";

function lastSession(): string | null | undefined {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return undefined;
  }
}

function rememberSession(value: string): void {
  try {
    localStorage.setItem(SESSION_KEY, value);
  } catch {
    // Storage unavailable: the next launch may count this sign-in again.
  }
}

/**
 * Analytics, signing in: a Clerk session this install hasn't seen. It runs once the person is
 * recorded in the room (Teams), because Clerk can reload the page right after signing in, and an
 * event sent before that reload is lost.
 */
function useSignedInEvent(sessionId: string | null | undefined, ready: boolean): void {
  useEffect(() => {
    if (!ready || !sessionId) return;
    const last = lastSession();
    if (last === undefined || last === sessionId) return;
    track("signed_in");
    rememberSession(sessionId);
  }, [ready, sessionId]);
}

/** Analytics, signing out: forgets the member, so whoever signs in next starts anonymous. */
function useSignedOutEvent(isLoaded: boolean, isSignedIn: boolean | undefined): void {
  useEffect(() => {
    if (!isLoaded || isSignedIn) return;
    const last = lastSession();
    if (!last || last === "signed-out") return;
    // Clerk reloads the page as it signs out, so this one goes out with a beacon.
    track("signed_out", {}, { beforeReload: true });
    analytics.reset();
    rememberSession("signed-out");
  }, [isLoaded, isSignedIn]);
}

function Splash({ text }: { text: string }) {
  return (
    <div className="splash">
      <div className="row-flex">
        <LinkMascot size={40} state="working" />
        <span className="muted">{text}</span>
      </div>
    </div>
  );
}

/** After sign-in: record the person, then open the last team, pick one, or create or join one. */
function Teams({ prefs }: { prefs: Prefs }) {
  const ensure = useMutation(api.people.ensure);
  const { sessionId } = useAuth();
  const [ready, setReady] = useState(false);
  useSignedInEvent(sessionId, ready);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ensure({})
      .then(() => !cancelled && setReady(true))
      .catch((error: unknown) => !cancelled && setFailed(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [ensure]);

  const teams = useQuery(api.teams.mine, ready ? {} : "skip");
  const [chosen, setChosen] = useState<Id<"teams"> | null>(() => lastTeam() as Id<"teams"> | null);
  const [choosing, setChoosing] = useState(false);

  if (failed) return <Splash text={failed} />;
  if (!ready || teams === undefined) return <Splash text="Loading your teams" />;

  return (
    <TeamsReady
      prefs={prefs}
      teams={teams}
      chosen={chosen}
      setChosen={setChosen}
      choosing={choosing}
      setChoosing={setChoosing}
    />
  );
}

function TeamsReady({
  prefs,
  teams,
  chosen,
  setChosen,
  choosing,
  setChoosing,
}: {
  prefs: Prefs;
  teams: MyTeam[];
  chosen: Id<"teams"> | null;
  setChosen: (id: Id<"teams">) => void;
  choosing: boolean;
  setChoosing: (value: boolean) => void;
}) {
  const current = teams.find((t) => t.teamId === chosen);
  const pickId = (teamId: Id<"teams">) => {
    rememberTeam(teamId);
    setChosen(teamId);
    setChoosing(false);
  };
  const pick = (team: MyTeam) => pickId(team.teamId);
  const only = teams.length === 1 && !current && !choosing ? teams[0]! : null;
  const links = useDeepLinks();
  const toast = useToast();
  // An open link needs its team's Shell, which checks the place and goes there (lib/deepLinks.ts):
  // the team picker closes for the current team, another of your teams opens first, and a team
  // you aren't in opens nothing.
  const openTeam = links.open?.teamId;
  useEffect(() => {
    const step = openLinkTeamStep(openTeam, current?.teamId, teams, choosing);
    if (step === "show-team") setChoosing(false);
    else if (step === "switch") pickId(openTeam as Id<"teams">);
    else if (step === "refuse") {
      clearOpen();
      toast.show(NOTHING_TO_OPEN);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTeam, choosing]);
  const joinDialog = links.invite ? (
    <JoinInvite
      token={links.invite}
      onClose={clearInvite}
      onJoined={(teamId) => {
        clearInvite();
        pickId(teamId);
      }}
    />
  ) : null;
  // Analytics: the person is this team's member from here on (IDs only).
  useEffect(() => {
    if (!current) return;
    analytics.identify({ memberId: current.memberId, teamId: current.teamId });
    track("team_opened", { team_count: teams.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.memberId, current?.teamId]);
  useEffect(() => {
    // One team and nothing remembered: open it, there's no choice to make.
    if (only) pickId(only.teamId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only?.teamId]);

  if (current && !choosing) {
    return (
      <SessionProvider team={current}>
        <Shell prefs={prefs} teams={teams} onSwitch={() => setChoosing(true)} onPick={pick} />
        {joinDialog}
      </SessionProvider>
    );
  }
  if (only) return <Splash text="Opening your team" />;
  // In no team: their Pairs, and making or joining a team, instead of a gate (ADR 0027).
  if (teams.length === 0) {
    return (
      <>
        <NoTeamHome prefs={prefs} onJoined={pickId} />
        {joinDialog}
      </>
    );
  }
  return (
    <>
      <TeamGate
        teams={teams}
        onPick={pick}
        onJoined={pickId}
        onCancel={current ? () => setChoosing(false) : undefined}
      />
      {joinDialog}
    </>
  );
}

function TeamGate({
  teams,
  onPick,
  onJoined,
  onCancel,
}: {
  teams: MyTeam[];
  onPick: (team: MyTeam) => void;
  onJoined: (teamId: Id<"teams">) => void;
  onCancel: (() => void) | undefined;
}) {
  return (
    <div className="gate">
      <div className="gate-drag" />
      <div className="gate-card">
        <div className="hello">
          <LinkMascot size={64} lively />
          <div>
            <h1>Hi, I'm Link</h1>
            <p className="muted">Pick a team, make one, or join one with an invite token.</p>
          </div>
        </div>

        {teams.length > 0 ? (
          <div className="field">
            <span className="label">Your teams</span>
            {teams.map((team) => (
              <button
                key={team.teamId}
                className="team-option"
                type="button"
                onClick={() => onPick(team)}
              >
                <b className="grow">{team.name}</b>
                <span className="tag">{team.role}</span>
              </button>
            ))}
          </div>
        ) : null}

        <TeamForms onJoined={onJoined} />

        {onCancel ? (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Back to the team
          </button>
        ) : null}
      </div>
    </div>
  );
}
