/**
 * The home of someone signed in who is in no team (ADR 0027: Uplink Room now has people in no
 * team). Pairs work without a team, so they lead; under them, making or joining a team. Settings
 * holds only what belongs to the person: their command line sign-ins and the appearance.
 */
import "./shell.css";
import { useCallback, useState, type ReactNode } from "react";
import { UserButton } from "@clerk/electron/react";
import { Toggle } from "@ui-sdk/react/toggle";
import { Tip } from "../components/Tip";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import type { Preferences } from "../lib/theme";
import { useSettingsMenu } from "../lib/settingsMenu";
import { clerkAppearance } from "../lib/clerkAppearance";
import { Icon } from "../components/Icon";
import { TeamForms } from "../components/TeamForms";
import { UpdateReady } from "../components/UpdateReady";
import { ViewBoundary } from "../components/ViewBoundary";
import { LinkMascot } from "../characters/LinkMascot";
import { ACCOUNT_SECTIONS, SettingsView, type SettingsSection } from "./Settings";
import { PairConversation, PairsLanding, PairsNav, PairStart, usePairs } from "./Pairs";

export type NoTeamRoute =
  | { name: "home" }
  | { name: "pair"; pairId: string; code?: boolean | undefined }
  | { name: "settings"; section: SettingsSection };

export function NoTeamHome({
  prefs,
  onJoined,
  account,
  initialRoute,
}: {
  prefs: Preferences;
  /** A team was made or joined: open it. */
  onJoined: (teamId: Id<"teams">) => void;
  /** Your avatar and account menu: Clerk's, unless the gym gives a stand-in. */
  account?: ReactNode;
  initialRoute?: NoTeamRoute;
}) {
  const [route, setRoute] = useState<NoTeamRoute>(initialRoute ?? { name: "home" });
  const [start, setStart] = useState<DOMRect | null>(null);
  const { pairs, more: morePairs } = usePairs();
  const me = useQuery(api.people.me, {});
  const openPair = (pairId: string, code = false) => setRoute({ name: "pair", pairId, code });
  const home = () => setRoute({ name: "home" });
  // Their Settings open on Command line, from the gear or the app menu's Settings….
  const openSettings = useCallback(
    () => setRoute({ name: "settings", section: "commandLine" }),
    [],
  );
  useSettingsMenu(openSettings);

  return (
    <div className="app no-team-app">
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-top">
          <span className="team-btn no-team-name">
            <LinkMascot size={22} />
            <span className="truncate">Uplink Room</span>
          </span>
        </div>
        <nav className="sidebar-scroll">
          <button
            className="nav-item"
            type="button"
            aria-current={route.name === "home" ? "page" : undefined}
            onClick={home}
          >
            <Icon name="link" />
            <span className="label-text">Pairs and teams</span>
          </button>
          <PairsNav
            pairs={pairs}
            more={morePairs}
            currentPairId={route.name === "pair" ? route.pairId : undefined}
            onOpen={(pairId) => openPair(pairId)}
            onStart={(rect) => setStart((open) => (open ? null : rect))}
          />
        </nav>
        <UpdateReady placement="sidebar" />
        <div className="sidebar-bottom">
          {account ?? <UserButton appearance={clerkAppearance(prefs.theme)} />}
          <span className="grow truncate me-name">{me?.name ?? ""}</span>
          <Tip label="Settings">
            <Toggle
              className="btn icon"
              aria-label="Settings"
              pressed={route.name === "settings"}
              onPressedChange={openSettings}
            >
              <Icon name="gear" />
            </Toggle>
          </Tip>
        </div>
      </aside>
      <main className="main" style={{ position: "relative" }}>
        <ViewBoundary key={JSON.stringify(route)} onLeave={home}>
          {route.name === "home" ? (
            <PairsLanding
              pairs={pairs}
              more={morePairs}
              onOpen={(pairId) => openPair(pairId)}
              onStart={setStart}
            >
              <section className="no-team" aria-labelledby="no-team-title">
                <h2 id="no-team-title">You're not in a team yet</h2>
                <p className="muted">
                  A team adds channels, calls, projects and one view of everyone's agents and runs.
                  Pairs work without one.
                </p>
                <TeamForms onJoined={onJoined} />
              </section>
            </PairsLanding>
          ) : route.name === "pair" ? (
            <PairConversation
              key={route.pairId}
              pairId={route.pairId}
              showCode={route.code}
              onLeft={home}
            />
          ) : (
            <SettingsView
              section={route.section}
              prefs={prefs}
              only={ACCOUNT_SECTIONS}
              onSection={(section) => setRoute({ name: "settings", section })}
            />
          )}
        </ViewBoundary>
      </main>
      {start ? (
        <PairStart
          anchor={start}
          onClose={() => setStart(null)}
          onOpened={(pairId, opts) => {
            setStart(null);
            openPair(pairId, opts.code);
          }}
        />
      ) : null}
    </div>
  );
}
