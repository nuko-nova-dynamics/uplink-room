"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLATFORM_NAMES, platformOf } from "../../lib/platform";

/** "Download for macOS" once the browser says which platform it's on; plain "Download" until then. */
export function DownloadButton() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = platformOf(nav.userAgent, nav.userAgentData?.platform);
    if (platform) setName(PLATFORM_NAMES[platform]);
  }, []);
  return (
    <Link className="button" href="/download">
      {name ? `Download for ${name}` : "Download"}
    </Link>
  );
}
