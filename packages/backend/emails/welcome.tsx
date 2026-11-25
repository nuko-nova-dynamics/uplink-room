/**
 * Sent to the person who just joined: welcome to the team, and four first steps, each a link that
 * opens the right place in the app (through uplinkroom.com/open, since mail apps drop links to
 * `uplink-room://`).
 */
import type { ReactNode } from "react";
import { Section } from "react-email";
import { Action, color, Footer, Layout, Link, link, quiet, text, Title } from "./layout";
import { roleName } from "./words";

export type WelcomeEmailProps = {
  teamName: string;
  role: "admin" | "member";
  teamUrl: string;
  downloadUrl: string;
  /** The channel to try a call in, usually #general. */
  channelName?: string | undefined;
  channelUrl?: string | undefined;
  machinesUrl: string;
  agentsUrl: string;
};

export function welcomeSubject(p: Pick<WelcomeEmailProps, "teamName">): string {
  return `Welcome to ${p.teamName} on Uplink Room`;
}

/** One step: its number is part of its heading, so the text version reads "1. Install ..." too. */
function Step({ n, title, href, action, children }: { n: number; title: string; href: string; action: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "0 0 20px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: "16px", lineHeight: "24px", fontWeight: 700, color: color.text }}>
        {n}. {title}
      </h2>
      <p style={{ ...quiet, margin: "0 0 4px" }}>{children}</p>
      <p style={{ ...quiet, margin: 0 }}>
        <Link href={href} style={link}>
          {action}
        </Link>
      </p>
    </Section>
  );
}

export default function WelcomeEmail(p: WelcomeEmailProps) {
  const channel = p.channelName ? `#${p.channelName}` : "a channel";
  return (
    <Layout
      title={welcomeSubject(p)}
      preview={`You're in. Four first steps: the app, a call in ${channel}, your machine's bridge, and an agent.`}
      footer={
        <>
          <Footer>You got this email because you joined {p.teamName} on Uplink Room.</Footer>
          <Footer>Uplink Room, Nuko Nova Dynamics LLC</Footer>
        </>
      }
    >
      <Title>Welcome to {p.teamName}</Title>
      <p style={text}>
        You joined as {roleName(p.role)}. Four first steps:
      </p>
      <Step n={1} title="Get the app on every computer you work on" href={p.downloadUrl} action="Download Uplink Room">
        It runs on macOS, Windows and Linux, and keeps itself up to date.
      </Step>
      <Step n={2} title={`Join a call in ${channel}`} href={p.channelUrl ?? p.teamUrl} action={`Open ${channel}`}>
        Every call belongs to a channel. Start or join one from the channel's header.
      </Step>
      <Step n={3} title="Pair your machine's bridge" href={p.machinesUrl} action="Open Settings, Machines">
        The bridge shares your computer's terminals with the team, within limits you set on that
        computer.
      </Step>
      <Step n={4} title="Add an agent" href={p.agentsUrl} action="Open Settings, Agents">
        You're accountable for the agents you add, and each can do at most what you can.
      </Step>
      <Action href={p.teamUrl}>Open {p.teamName}</Action>
    </Layout>
  );
}

WelcomeEmail.PreviewProps = {
  teamName: "Miami Web AI",
  role: "member",
  teamUrl: "https://uplinkroom.com/open#team/k57abc",
  downloadUrl: "https://uplinkroom.com/download",
  channelName: "general",
  channelUrl: "https://uplinkroom.com/open#team/k57abc/channel/k99def",
  machinesUrl: "https://uplinkroom.com/open#team/k57abc/settings/machines",
  agentsUrl: "https://uplinkroom.com/open#team/k57abc/settings/agents",
} satisfies WelcomeEmailProps;
