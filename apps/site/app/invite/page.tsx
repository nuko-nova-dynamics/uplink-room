import type { Metadata } from "next";
import { OpenInApp } from "../_components/OpenInApp";

export const metadata: Metadata = {
  title: "Join a team",
  description: "Open Uplink Room to join the team that invited you.",
  robots: { index: false, follow: false },
};

/**
 * The join link from an invite email: `/invite#<token>`. The page is the same for every invite;
 * the token is read in the browser from the fragment and handed to the desktop app.
 */
export default function InvitePage() {
  return <OpenInApp kind="invite" />;
}
