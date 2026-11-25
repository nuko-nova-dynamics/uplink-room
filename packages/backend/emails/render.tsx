/**
 * Turns an email row (convex/lib/email.ts) into its subject, HTML and text. Runs in the Node action
 * `emailSend.send`, the only code that imports React Email, so the rest of the backend never loads it.
 */
import type { ReactElement } from "react";
import { render } from "react-email";
import type { EmailData, EmailKind } from "../convex/lib/email";
import { downloadUrl, inviteUrl, openUrl } from "../convex/lib/inviteToken";
import InviteEmail, { inviteSubject } from "./invite";
import JoinedEmail, { joinedSubject } from "./joined";
import WelcomeEmail, { welcomeSubject } from "./welcome";

export type RenderedEmail = { subject: string; html: string; text: string };

export async function renderEmail(
  kind: EmailKind,
  data: EmailData,
  extra: { token: string | null; now: number },
): Promise<RenderedEmail> {
  const team = `team/${data.teamId}`;
  let subject: string;
  let element: ReactElement;
  switch (kind) {
    case "invite":
    case "reminder": {
      if (!extra.token) throw new Error("An invite email needs its token.");
      const props = {
        teamName: data.teamName,
        inviterName: data.inviterName ?? "Someone on the team",
        inviterEmail: data.inviterEmail,
        inviteeEmail: data.inviteeEmail ?? "you",
        role: data.role ?? "member",
        inviteUrl: inviteUrl(extra.token),
        downloadUrl: downloadUrl(),
        token: extra.token,
        expiresAt: data.expiresAt,
        reminder: kind === "reminder",
        now: extra.now,
      };
      subject = inviteSubject(props);
      element = <InviteEmail {...props} />;
      break;
    }
    case "welcome": {
      const props = {
        teamName: data.teamName,
        role: data.role ?? "member",
        teamUrl: openUrl(team),
        downloadUrl: downloadUrl(),
        channelName: data.channelName,
        channelUrl: data.channelId ? openUrl(`${team}/channel/${data.channelId}`) : undefined,
        machinesUrl: openUrl(`${team}/settings/machines`),
        agentsUrl: openUrl(`${team}/settings/agents`),
      };
      subject = welcomeSubject(props);
      element = <WelcomeEmail {...props} />;
      break;
    }
    case "joined": {
      const props = {
        teamName: data.teamName,
        inviteeName: data.inviteeName ?? data.inviteeEmail ?? "Someone",
        inviteeEmail: data.inviteeEmail,
        role: data.role ?? "member",
        agentName: data.agentName,
        membersUrl: openUrl(`${team}/settings/members`),
      };
      subject = joinedSubject(props);
      element = <JoinedEmail {...props} />;
      break;
    }
  }
  const [html, text] = await Promise.all([
    render(element),
    // html-to-text capitalizes headings by default; the text version keeps their case.
    render(element, {
      plainText: true,
      htmlToTextOptions: {
        selectors: [
          { selector: "h1", options: { uppercase: false } },
          { selector: "h2", options: { uppercase: false } },
        ],
      },
    }),
  ]);
  return { subject, html, text };
}
