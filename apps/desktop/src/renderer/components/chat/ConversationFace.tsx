import type { ComponentProps } from "react";
import { MemberFace } from "../Faces";

/** Conversation avatars keep the shared artwork and presence, with initials on the type ramp. */
export function ConversationFace({ size = 20, ...props }: ComponentProps<typeof MemberFace>) {
  if (props.member.kind === "agent") return <MemberFace {...props} size={size} />;
  return (
    <span className="conversation-face" data-size={size}>
      <MemberFace {...props} />
    </span>
  );
}
