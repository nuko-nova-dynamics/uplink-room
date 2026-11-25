/**
 * The invite, and its one reminder 3 days later. Who invited them to which team, one line on what
 * Uplink Room is, Join and Download, and the token for when the button can't open the app.
 */
import { Action, Footer, Layout, Link, link, quiet, Rule, text, Title, Token } from "./layout";
import { daysLeft, roleName } from "./words";

export type InviteEmailProps = {
  teamName: string;
  /** "Julio Diaz", or for an agent's invite "Hermes, an agent Julio Diaz added". */
  inviterName: string;
  inviterEmail?: string | undefined;
  inviteeEmail: string;
  role: "admin" | "member";
  inviteUrl: string;
  downloadUrl: string;
  token: string;
  expiresAt?: number | undefined;
  /** When it's the reminder. */
  reminder?: boolean;
  /** The time the email is made, for "expires in 4 days". */
  now: number;
};

export function inviteSubject(p: Pick<InviteEmailProps, "teamName" | "inviterName" | "reminder">): string {
  return p.reminder
    ? `Reminder: ${p.inviterName} invited you to ${p.teamName} on Uplink Room`
    : `${p.inviterName} invited you to ${p.teamName} on Uplink Room`;
}

export default function InviteEmail(p: InviteEmailProps) {
  const left = daysLeft(p.expiresAt, p.now);
  const expiry =
    left === null
      ? "The invite works once."
      : left <= 1
        ? "The invite works once and expires within a day."
        : `The invite works once and expires in ${left} days.`;
  return (
    <Layout
      title={inviteSubject(p)}
      preview={
        p.reminder
          ? `Your invite to ${p.teamName} is still waiting. ${expiry}`
          : `Join ${p.teamName}'s channels, calls and agents. ${expiry}`
      }
      footer={
        <>
          <Footer>
            {p.reminder
              ? `This is the only reminder. You got it because ${p.inviterName} invited ${p.inviteeEmail} to ${p.teamName} on Uplink Room and the invite hasn't been used.`
              : `You got this email because ${p.inviterName} invited ${p.inviteeEmail} to ${p.teamName} on Uplink Room.`}{" "}
            If you didn't expect it, you can ignore it.
          </Footer>
          <Footer>Uplink Room, Nuko Nova Dynamics LLC</Footer>
        </>
      }
    >
      <Title>{p.reminder ? `Your invite to ${p.teamName} is waiting` : `Join ${p.teamName} on Uplink Room`}</Title>
      <p style={text}>
        {p.inviterName}
        {p.inviterEmail ? ` (${p.inviterEmail})` : ""} invited you to {p.teamName} as {roleName(p.role)}.
      </p>
      <p style={text}>
        Uplink Room is a desktop app where a team and its coding agents share channels, calls and projects.
      </p>
      <Action href={p.inviteUrl}>Join on Uplink Room</Action>
      <p style={text}>
        Don't have the app yet?{" "}
        <Link href={p.downloadUrl} style={link}>
          Download Uplink Room
        </Link>{" "}
        for macOS, Windows or Linux, then open this email again.
      </p>
      <Rule />
      <p style={quiet}>
        If the button doesn't open the app, open Uplink Room and paste this invite token where it asks
        to join a team:
      </p>
      <Token value={p.token} />
      <p style={quiet}>{expiry}</p>
    </Layout>
  );
}

InviteEmail.PreviewProps = {
  teamName: "Miami Web AI",
  inviterName: "Julio Diaz",
  inviterEmail: "julio@example.com",
  inviteeEmail: "ana@example.com",
  role: "member",
  inviteUrl: "https://uplinkroom.com/invite#uri_0123456789abcdef0123456789abcdef0123456789abcdef",
  downloadUrl: "https://uplinkroom.com/download",
  token: "uri_0123456789abcdef0123456789abcdef0123456789abcdef",
  expiresAt: Date.UTC(2026, 10, 11, 12),
  now: Date.UTC(2026, 10, 4, 12),
} satisfies InviteEmailProps;
