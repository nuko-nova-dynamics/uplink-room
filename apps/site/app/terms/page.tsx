import type { Metadata } from "next";
import Link from "next/link";
import { DraftNotice, Placeholder } from "../_components/Draft";

export const metadata: Metadata = {
  title: "Terms of use (draft)",
  description: "A draft of the terms for using Uplink Room and uplinkroom.com.",
};

/** DRAFT, attorney review required. Bracketed items are decisions and facts the draft still needs. */
export default function Terms() {
  return (
    <article className="doc">
      <DraftNotice>
        These terms are a draft for review and aren't in effect yet. Nuko Nova Dynamics LLC will
        publish the final version here before they apply. Highlighted items in brackets are still to
        be decided.
      </DraftNotice>

      <h1>Terms of use</h1>
      <p className="updated">Draft of November 3, 2026</p>

      <h2>Who these terms are with</h2>
      <p>
        These terms are between you and Nuko Nova Dynamics LLC (“Nuko Nova”, “we”), which makes
        Uplink Room: the desktop app, the bridge it runs on linked machines, the Room API, and this
        website. If you use Uplink Room for a team or a company, you accept these terms for it too.
        Our <Link href="/privacy">privacy policy</Link> says how we handle personal information.
      </p>

      <h2>Your account and your team</h2>
      <ul>
        <li>Keep your sign-in to yourself, and tell us if you think someone else has used it.</li>
        <li>
          Team admins decide who joins a team, what each member and agent may do, and the settings
          of the team's machines.
        </li>
        <li>
          Whoever adds an agent to a team is responsible for what it does there. An agent can do at
          most what that person can.
        </li>
      </ul>

      <h2>Your content and your machines</h2>
      <p>
        What you and your team put into Uplink Room stays yours. You let us store and process it
        only to run Uplink Room for you. When you link a machine, its owner decides how much access
        others get, and the bridge enforces that on the machine. You're responsible for what runs on
        machines you link and for keeping the right to use the tools, accounts and subscriptions you
        connect, such as your coding agents' providers.
      </p>

      <h2>Acceptable use</h2>
      <p>Don't use Uplink Room to:</p>
      <ul>
        <li>break the law or anyone else's rights;</li>
        <li>reach machines, accounts or data you aren't allowed to;</li>
        <li>spread malware, or attack or overload Uplink Room or anyone else's systems;</li>
        <li>get around the limits a team, machine owner or Uplink Room sets.</li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        Uplink Room connects to tools we don't run, such as T3 Code, Cua, A2A agent gateways and
        your coding agents' providers. Their own terms apply to them, and we aren't responsible for
        them.
      </p>

      <h2>Early software</h2>
      <p>
        Uplink Room is new and changing quickly. It's provided “as is”, without warranties, to the
        extent the law allows.{" "}
        <Placeholder>
          counsel to draft the warranty disclaimer and limitation of liability
        </Placeholder>
      </p>

      <h2>Fees</h2>
      <p>
        Uplink Room is free to use today.{" "}
        <Placeholder>terms for paid plans, if any, before they start</Placeholder>
      </p>

      <h2>Ending</h2>
      <p>
        You can stop using Uplink Room and ask us to delete your account at any time. We may suspend
        or end access that breaks these terms.{" "}
        <Placeholder>notice periods and what happens to a team's data</Placeholder>
      </p>

      <h2>Changes and contact</h2>
      <p>
        When these terms change, the new version appears here with its date. Questions:{" "}
        <Placeholder>contact email</Placeholder>.
      </p>
      <p>
        <Placeholder>governing law and venue</Placeholder>
      </p>
    </article>
  );
}
