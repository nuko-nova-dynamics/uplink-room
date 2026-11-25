/** Sent to whoever sent the invite, once the person they invited joins. They can turn it off. */
import { Action, Footer, Layout, text, Title } from "./layout";
import { roleName } from "./words";

export type JoinedEmailProps = {
  teamName: string;
  inviteeName: string;
  inviteeEmail?: string | undefined;
  role: "admin" | "member";
  /** Set when an agent sent the invite for this person: "Hermes". */
  agentName?: string | undefined;
  membersUrl: string;
};

export function joinedSubject(p: Pick<JoinedEmailProps, "teamName" | "inviteeName">): string {
  return `${p.inviteeName} joined ${p.teamName}`;
}

export default function JoinedEmail(p: JoinedEmailProps) {
  const who = p.inviteeEmail ? `${p.inviteeName} (${p.inviteeEmail})` : p.inviteeName;
  return (
    <Layout
      title={joinedSubject(p)}
      preview={`${p.inviteeName} accepted the invite and is in ${p.teamName} as ${roleName(p.role)}.`}
      footer={
        <>
          <Footer>
            You got this email because {p.agentName ? `${p.agentName}, an agent you added,` : "you"} invited{" "}
            {p.inviteeName}. To stop these emails, open Uplink Room, then Settings, Notifications, and turn
            off "Someone you invited joins".
          </Footer>
          <Footer>Uplink Room, Nuko Nova Dynamics LLC</Footer>
        </>
      }
    >
      <Title>{joinedSubject(p)}</Title>
      <p style={text}>
        {who} accepted {p.agentName ? `the invite ${p.agentName} sent for you` : "your invite"} and is in{" "}
        {p.teamName} as {roleName(p.role)}.
      </p>
      <Action href={p.membersUrl}>See the team's members</Action>
    </Layout>
  );
}

JoinedEmail.PreviewProps = {
  teamName: "Miami Web AI",
  inviteeName: "Ana Moran",
  inviteeEmail: "ana@example.com",
  role: "member",
  membersUrl: "https://uplinkroom.com/open#team/k57abc/settings/members",
} satisfies JoinedEmailProps;
