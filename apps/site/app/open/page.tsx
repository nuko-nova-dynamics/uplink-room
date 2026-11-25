import type { Metadata } from "next";
import { OpenInApp } from "../_components/OpenInApp";

export const metadata: Metadata = {
  title: "Open Uplink Room",
  description: "Open a place in Uplink Room from an email.",
  robots: { index: false, follow: false },
};

/** The welcome email's links: `/open#team/<id>/...`, handed to the desktop app from the fragment. */
export default function OpenPage() {
  return <OpenInApp kind="open" />;
}
