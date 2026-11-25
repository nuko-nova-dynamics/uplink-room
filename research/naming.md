# Naming

Picked on 2026-11-01: **Uplink Room**, domain **uplinkroom.com**.

The rule was that the .com had to be free. The first working name, Malecón (Guayaquil's riverfront promenade), failed that rule, because malecon.com has been registered since 1998. Julio then asked for an AI name about connected agents and bridges, without the Ecuador theme.

## How names were checked

- Registered or not: Verisign's RDAP service (`https://rdap.verisign.com/com/v1/domain/<name>.com`), which returns 200 for a registered name and 404 for a free one. A few results were cross-checked with Verisign WHOIS, and they matched.
- Buyable and price: Vercel's availability check and price lookup. Every free name checked cost $12.03 a year, with the same renewal price.
- Existing products: web searches only. No trademark (USPTO) search has been done yet.

The candidate lists are in `naming/names*.txt`. A name being free can change at any time. For example, manglaro.com was registered in August 2026 and zarpalo.com in March 2026.

## Results

Rounds 1 to 3 (Ecuador and Malecón themed, about 160 names): nearly all were registered, including malecon, minga, minka, tertulia, orilla, estero, helmspace, crewdeck and agentdeck. Free ones included maleconn, mingaroom, steerhall, farohall, getmalecon and maleconhq. maleconnect.com was registered in 2013, and in English it reads as "male connect".

Rounds 4 and 5 (AI themed, about 260 names): nearly all were registered, including agentbridge, agentmesh, agentroom, agentrelay, bridgeai, neurobridge, synapseroom, agenthub and agentsync. These were free:

| Name | Meaning | Problem |
|---|---|---|
| **Uplink Room** (picked) | NASA's JPL calls the room where the Curiosity team talks to its rover the "uplink room" | "Uplink" alone is common, so the brand needs both words |
| Synapse Hall | A synapse is where two neurons connect | Synapse is also the name of Matrix's chat server (element-hq/synapse) |
| Handoff Room | Where work passes between people and agents | A common phrase. One blog calls Block's Buzz "the live handoff room" |
| Gefyro | From the Greek word for bridge | Gefyra is already a Kubernetes developer tool that "bridges" a laptop to clusters |
| Tether Room | Tethering agents together | Sounds like the Tether (USDT) cryptocurrency |

Also free but weaker: spanroom, latenthall, axonroom, uplinkhall.

## Still to do

- Register uplinkroom.com.
- Run a USPTO trademark search for "Uplink Room" before treating it as a product name.
