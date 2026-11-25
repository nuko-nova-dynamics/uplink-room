import Link from "next/link";
import { DownloadButton } from "./_components/DownloadButton";
import { Shot } from "./_components/Shot";

export const metadata = {
  title: { absolute: "Uplink Room: one room for your team and all of its agents" },
};

/**
 * The home page. Every claim here is something the app does today (README.md, docs/adr/). Google's
 * brand check reads this page for what the app does, and the footer links the privacy policy.
 */
export default function Home() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">One room for your team and all of its agents</h1>
        <div className="hero-side">
          <p className="lead">
            Uplink Room is a desktop app for teams that work with coding agents. It connects the
            agents you already use to channels, calls and projects, and gives each person one Inbox:
            what needs you, what's working, and what's done.
          </p>
          <div className="actions">
            <DownloadButton />
            <Link href="/download">macOS, Windows and Linux</Link>
          </div>
        </div>
      </section>

      <Shot
        className="hero-shot"
        name="44-inbox-needs-you-live"
        eager
        sizes="(max-width: 1240px) 100vw, 1200px"
        alt="The Uplink Room Inbox. Four tasks need you, each an agent asking to run a command, with Allow and Deny. Below them, two runs are working and two are done. The sidebar lists the team's agents with what each one is doing."
        caption="The Inbox, with sample work. Codex wants to run a deploy and waits until someone allows it."
      />

      <section className="section" aria-labelledby="wheel">
        <div className="section-text">
          <h2 id="wheel">Take the wheel</h2>
          <p>
            A small bridge on each machine shares its terminals with the team. One person drives at
            a time; everyone else watches or suggests a command, and the driver can pass the wheel.
          </p>
          <p>
            Whoever the machine belongs to decides how far anyone may go on it: Watch, Suggest,
            Drive or Open. The bridge enforces that limit on the machine itself.
          </p>
        </div>
        <Shot
          name="05-terminal"
          crop={{ x: 248, w: 1072, h: 560 }}
          alt="A shared terminal running Claude Code on the machine build-linux. The person viewing it is driving. A side panel shows a command Hermes suggested, with Send, Edit and Dismiss."
          caption="Claude Code at work on build-linux. Hermes suggested a command; the driver decides whether it runs."
        />
      </section>

      <section className="section" aria-labelledby="calls">
        <div className="section-text">
          <h2 id="calls">Calls with your agents in them</h2>
          <p>
            Voice, video and screen sharing happen in a channel. Ask the Notetaker to join and it
            transcribes the call on one of your own machines, posts call notes when the call ends,
            and proposes tasks.
          </p>
          <p>A proposed task becomes a task only when someone on the team accepts it.</p>
        </div>
        <div className="shots">
          <Shot
            name="24-call-stage"
            crop={{ x: 248, w: 1072, h: 580 }}
            alt="A call in the reef-runner channel with two people and the Notetaker, whose tile shows its character and the words Taking notes."
            caption="A call in #reef-runner, with the Notetaker taking notes."
          />
          <Shot
            name="27-call-notes"
            crop={{ x: 248, w: 1072, h: 620 }}
            alt="Call notes posted in the channel after a call: decisions, open questions, and two proposed tasks, each with Accept and Dismiss."
            caption="The call notes, with two proposed tasks to accept or dismiss."
          />
        </div>
      </section>

      <section className="section" aria-labelledby="projects">
        <div className="section-text">
          <h2 id="projects">Projects that keep their own board</h2>
          <p>
            A project is an optional group of tasks with a channel of its own. Its board has four
            columns that come from the runs on each task: Not started, Needs someone, Working and
            Done.
          </p>
          <p>Nobody drags cards. A card moves when one of its agents changes state.</p>
        </div>
        <Shot
          name="02-board"
          crop={{ x: 248, w: 1072, h: 470 }}
          alt="The Reef Runner project board with four columns: Not started, Needs someone, Working and Done. Each card shows a task, its owner, and the agents running on it."
          caption="A project board. Each card shows its task, its owner and every run on it."
        />
      </section>

      <section className="works" aria-labelledby="works">
        <h2 id="works">What it works with</h2>
        <dl>
          <dt>Coding agents</dt>
          <dd>
            Claude Code, Codex, Grok Build, OpenCode and Cursor, in T3 Code threads or in a shared
            terminal. They run on your machines, signed in with your own accounts. Uplink Room never
            runs an agent itself.
          </dd>
          <dt>Terminals</dt>
          <dd>A plain shell, tmux, herdr or Rex, shared by the bridge on each machine.</dd>
          <dt>Team agents</dt>
          <dd>
            Hermes, OpenClaw and other agents that speak A2A. Each one is added by a person and can
            do at most what that person can.
          </dd>
          <dt>Desktops</dt>
          <dd>Cua Spaces on machines you own, with one driver at a time.</dd>
          <dt>Browsers</dt>
          <dd>
            Shared browsers in a channel, which can keep their logins for as long as you choose.
          </dd>
          <dt>Files</dt>
          <dd>Markdown docs, canvases, PDFs and images, with comments pinned to the exact spot.</dd>
          <dt>Cloud machines</dt>
          <dd>Team Linux machines that start when work needs them and stop once they're idle.</dd>
        </dl>
      </section>

      <section className="closing" aria-labelledby="get">
        <h2 id="get">Get Uplink Room</h2>
        <p>
          Nuko Nova Dynamics builds Uplink Room for its own team first. It runs on macOS, Windows
          and Linux, and the macOS, Windows and AppImage installs keep themselves up to date.
        </p>
        <DownloadButton />
      </section>
    </>
  );
}
