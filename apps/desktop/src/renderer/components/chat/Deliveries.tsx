/**
 * Under a message: what happened with agents the room can reach but not follow (slice 14 of #139).
 * A routine webhook (Grok Bot) shows sending, sent, or why it failed; an agent that checks in on its
 * own schedule (dots, Muse, Duet) shows that it sees the message when it next checks, then Seen.
 * One plain line each: a fact about this message, not a control.
 */
import type { MessageRow } from "../../lib/api";
import { Icon } from "../Icon";

export type Delivery = MessageRow["deliveries"][number];

/** The words for one delivery, and whether it needs someone (a failed send: amber). */
export function deliveryLine(delivery: Pick<Delivery, "to" | "via" | "status" | "reason">): { text: string; needsSomeone: boolean } {
  const name = delivery.to.name;
  switch (delivery.status) {
    case "sending":
      return { text: `Sending to ${name}…`, needsSomeone: false };
    case "sent":
      return { text: `Sent to ${name}. It answers here when its run is done.`, needsSomeone: false };
    case "failed":
      return { text: `Sending to ${name} failed. ${delivery.reason ?? "The webhook didn't take it."}`, needsSomeone: true };
    case "waiting":
      return { text: `${name} checks in on its own schedule and sees this when it next checks.`, needsSomeone: false };
    case "seen":
      return { text: `Seen by ${name}`, needsSomeone: false };
  }
}

const ICON = { sending: "clock", sent: "check", failed: "alert", waiting: "clock", seen: "eye" } as const;

export function Deliveries({ deliveries }: { deliveries: Delivery[] }) {
  if (deliveries.length === 0) return null;
  return (
    <div className="deliveries">
      {deliveries.map((delivery) => {
        const line = deliveryLine(delivery);
        return (
          <span key={`${delivery.to.memberId}-${delivery.via}`} className={line.needsSomeone ? "delivery amber-text" : "delivery"}>
            <Icon name={ICON[delivery.status]} size={14} />
            <span>{line.text}</span>
          </span>
        );
      })}
    </div>
  );
}
