import type { Metadata } from "next";
import Link from "next/link";
import { DraftNotice, Placeholder } from "../_components/Draft";

export const metadata: Metadata = {
  title: "Privacy policy (draft)",
  description: "A draft of how Uplink Room and uplinkroom.com handle personal information.",
};

/**
 * DRAFT, attorney review required. Each statement comes from what the app does, as documented in
 * the repo: docs/error-reports.md (Sentry), docs/analytics.md (PostHog), docs/calls.md and ADRs
 * 0006 to 0014, and packages/backend/convex/schema.ts and crons.ts for what is stored and for how
 * long. Bracketed items are facts the draft still needs.
 */
export default function Privacy() {
  return (
    <article className="doc">
      <DraftNotice>
        This privacy policy is a draft for review and isn't in effect yet. Nuko Nova Dynamics LLC
        will publish the final version here before it applies. Highlighted items in brackets are
        still to be filled in.
      </DraftNotice>

      <h1>Privacy policy</h1>
      <p className="updated">Draft of November 3, 2026</p>

      <h2>Who we are</h2>
      <p>
        Uplink Room is made by Nuko Nova Dynamics LLC (“Nuko Nova”, “we”). This policy covers the
        Uplink Room desktop app, the bridge it runs on linked machines, the Room API that the app
        and agents use, and this website, uplinkroom.com.
      </p>
      <p>
        Questions about this policy: <Placeholder>privacy contact email</Placeholder>,{" "}
        <Placeholder>mailing address of Nuko Nova Dynamics LLC</Placeholder>.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>
          You sign in with an email address, or with Google, which shares your name, email address
          and profile picture with us.
        </li>
        <li>
          What your team creates in Uplink Room (messages, tasks, files, shared terminals and the
          rest) is stored so your team can use it. Your team decides who sees it.
        </li>
        <li>
          Error reports are scrubbed of terminal text, documents, messages, tokens and email
          addresses before they leave the app.
        </li>
        <li>
          Usage data says which parts of the app get used, never what's in them. You can turn it off
          in Settings, Privacy, “Share usage data”.
        </li>
        <li>We don't sell personal information and don't use it for advertising.</li>
      </ul>

      <h2>What we collect and why</h2>

      <h3>Your account</h3>
      <p>
        Sign-in runs on Clerk. With email, Clerk keeps your email address and either a password or
        the one-time codes it sends you. With Google, Google shares your name, email address and
        profile picture. We use these to create your account, sign you in, and show your team who
        you are. Your session is kept on your computer, encrypted with the operating system's
        keychain; on Linux without a supported keyring, it's kept in memory only and you sign in
        each time the app starts.
      </p>
      <p>
        We use information from Google only to sign you in and to show your name and picture to your
        team. We don't use it for advertising and don't share it with anyone except the service
        providers listed below that run Uplink Room for us.
      </p>

      <h3>What your team creates</h3>
      <p>
        The room's data is stored on Convex, in the United States: your team, its members and
        agents, channels and messages, projects, tasks and runs, files and their comments, saved
        settings for machines, and the activity log of who did what. Only members of your team can
        read your team's data, as their role and the team's settings allow.
      </p>
      <ul>
        <li>
          <b>Shared terminals.</b> When a terminal on a linked machine is shared, its output and
          what people type into it pass through the room and are stored with the team's data, so
          teammates can watch it and see who typed what.{" "}
          <Placeholder>
            retention period for terminal output and input; the room keeps it until the team or
            terminal is deleted today
          </Placeholder>
        </li>
        <li>
          <b>Spaces.</b> A Space's screen goes from the bridge on its machine straight to the
          teammates watching it, on the same network or over Tailscale. It isn't stored by the room.
        </li>
        <li>
          <b>Calls.</b> Calls run on LiveKit. No call audio or video is recorded or kept. If someone
          asks the Notetaker agent to join, it transcribes the call on one of the team's own
          machines and stores the transcript in the room, where it's kept for 30 days after the call
          ends. Call notes and the tasks it proposes stay in the channel like any message.
        </li>
        <li>
          <b>Shared browsers.</b> A shared browser is a cloud browser run by Hyperbeam. Whoever
          starts one chooses whether it keeps its logins. Saved logins (cookies, passwords, history
          and bookmarks) are stored encrypted by Hyperbeam. When they're forgotten, by hand or when
          they expire, the room stops using them. Once the last browser using them has ended, the
          room erases them at Hyperbeam by saving an empty browser over them, and keeps trying for
          about a day if that fails. If it still can't, Hyperbeam deletes a profile nobody has
          loaded for three months.
        </li>
        <li>
          <b>Cloud machines.</b> A cloud machine is a Linux computer on Vercel Sandbox that the room
          starts and stops for your team. Its disk, with whatever your team keeps on it, is kept
          while the machine exists.
        </li>
        <li>
          <b>Agents over A2A.</b> When you send work to an agent such as Hermes or OpenClaw, the
          room sends your message to that agent's own gateway, which is run by whoever connected it,
          not by us. What happens there is up to that gateway and its operator.
        </li>
        <li>
          <b>Coding agents.</b> Uplink Room doesn't run agents itself. Claude Code, Codex and the
          other tools run on your machines under your own accounts with their providers, and those
          providers' terms and privacy policies apply to what you send them.
        </li>
      </ul>

      <h3>Error reports</h3>
      <p>
        Installed builds of the app and the bridge send error reports to Sentry so we can fix
        crashes and bugs. A report holds the error's type and where in the code it happened, the
        operating system, the app's version, and the member ID of whoever is signed in. It never
        holds terminal output, file contents, transcripts, message bodies, tokens, your name or your
        email address, and we ask Sentry not to keep IP addresses or locations.
      </p>
      <p>
        To turn error reports off, start the app with <code>UPLINK_NO_TELEMETRY=1</code> (or{" "}
        <code>DO_NOT_TRACK=1</code>) in its environment.
      </p>

      <h3>Usage data</h3>
      <p>
        Installed builds send usage events to PostHog, such as that the app opened (with its version
        and the operating system), that you signed in, started a run, joined a call, answered an
        approval, or opened the Inbox, a file, a Space or a shared browser, and the kind of thing
        involved, such as which coding agent a run used. Events carry your member ID and your team's
        ID, never your name or email address, and never what's in messages, terminals, transcripts,
        documents or web addresses. Screen recordings of a session hide all text and typing and
        leave out terminals, files, Spaces and shared browsers entirely.
      </p>
      <p>
        Usage data is on by default. Turn it off in Settings, Privacy, “Share usage data”; that
        stops it on that computer at once.
      </p>

      <h3>Updates</h3>
      <p>
        The app checks uplinkroom.com for a new version when it starts and every four hours. Those
        requests carry what any web request does, such as your IP address, and an anonymous ID the
        update library keeps on your computer.
      </p>

      <h3>This website</h3>
      <p>
        uplinkroom.com sets no cookies and runs no analytics. Vercel, which hosts it, processes the
        request data any website receives, such as IP addresses and browser details, to serve and
        protect the site.
      </p>

      <h2>Who processes data for us</h2>
      <p>These companies run parts of Uplink Room for us and handle data only to do that:</p>
      <ul>
        <li>Clerk: sign-in and accounts.</li>
        <li>Google: signing in with Google, when you choose it.</li>
        <li>Convex: the room's database and file storage.</li>
        <li>LiveKit: calls.</li>
        <li>Hyperbeam: shared browsers and their saved logins.</li>
        <li>Vercel: this website, app downloads and updates, and cloud machines.</li>
        <li>Sentry: error reports.</li>
        <li>PostHog: usage data.</li>
      </ul>
      <p>
        We may also disclose information when the law requires it, or to protect the people who use
        Uplink Room.{" "}
        <Placeholder>
          counsel to confirm wording on legal requests and business transfers
        </Placeholder>
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Your account: until it's deleted.</li>
        <li>Your team's data: until the team, or the item, is deleted.</li>
        <li>Call transcripts: 30 days after the call ends.</li>
        <li>Files uploaded but never added: one hour.</li>
        <li>
          Error reports and usage data:{" "}
          <Placeholder>retention set in Sentry and PostHog</Placeholder>
        </li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Turn usage data off in Settings, Privacy.</li>
        <li>Turn error reports off with the environment setting above.</li>
        <li>
          To see, correct or delete your information, or to delete your account, write to{" "}
          <Placeholder>privacy contact email</Placeholder>.{" "}
          <Placeholder>
            counsel to confirm which state or national privacy rights apply and how requests are
            verified and answered
          </Placeholder>
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Sessions and tokens are encrypted on your computer. Agents act through keys with limited
        scopes and can do at most what the person who added them can. The bridge on each machine
        enforces that machine's own limits, set by whoever it belongs to. No system is perfectly
        secure, and we'll tell you if a breach affects your information as the law requires.
      </p>

      <h2>Children</h2>
      <p>
        Uplink Room is for work teams and isn't meant for children.{" "}
        <Placeholder>counsel to confirm the minimum age</Placeholder>
      </p>

      <h2>Changes</h2>
      <p>
        When this policy changes, the new version appears here with its date. If a change matters to
        how your information is used, we'll tell you in the app or by email first.
      </p>

      <p>
        See also the <Link href="/terms">terms of use</Link>.
      </p>
    </article>
  );
}
