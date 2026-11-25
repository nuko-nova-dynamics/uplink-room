---
status: accepted
---

# People make, join and leave Pairs in the app, and someone in no team gets a home

ADR 0034 built Pairs for runs and agents, and left the app (slice 12 of #139) to list and read them. Building the app's side showed that a person needs three things the Room API didn't have: making a Pair without a run, joining one with a code, and leaving one. Without them, someone who signed in to the app with no team could read a Pair only after a run of theirs joined it from a terminal. Decided on 2026-11-05 while building slice 12.

## Decisions

- **`pairs.create` makes a Pair with only its person in it**, no run. The app's New Pair calls it and then `pairs.code`, so its first code shows at once. Only a person makes one; an agent is refused, as with `pairs.code` and `pairs.end`.
- **Making Pairs is limited per person**, from the app (`pairs.create`) or a run (`uplink pair`, `joined.pairCode`): at most 10 new Pairs in any hour, and at most 20 open Pairs they made. A Pair they made counts until it ends, even after they leave it, so ending one makes room for another. Without a limit, someone could make Pairs without end, each a row in their list. A refusal says which limit was reached and, for the hourly one, how many minutes are left.
- **The app pages through every Pair** with `pairs.listPage`, the ones you joined last first, and sorts what it has loaded by latest activity; More Pairs loads the next page. The Pair that's open is read on its own with `pairs.get`, so a Pair the list hasn't reached still opens. `pairs.listPage` and `pairs.messagesPage` are for the app's own session and aren't in the Room API: `pairs.list` and `pairs.messages` answer it as before.
- **A person joins with a code from the app (`pairs.join`)** as one of the Pair's people, with no run. The code rules of ADR 0034 hold unchanged: it works once, a wrong, used or expired one is refused with one answer and counts against the person, and after 10 in an hour no code works for them until the hour is over. The refusal is returned, not thrown, so the count stays, and the app words it plainly. Someone already in the Pair is told so, and the code is left for another. A person who left and joins again is back, reading from then on.
- **A person leaves a Pair (`pairs.leave`).** They stop being one of its people and can't read it after; their runs and agents in it leave with them, and their runs can't resume it. Their messages stay under their name. A live Pair left with fewer than two people ends, as after an account deletion (`too_few_people`). Ending it for everyone is still `pairs.end`.
- **The app shows Pairs to everyone the same way**, team or none: in the sidebar after Direct messages, read like a direct message, with the code shown once in a popover by the Pair's title row. Someone signed in with no team gets a home of their Pairs, with making or joining a team under them, instead of the team picker; their Settings hold only Command line and Appearance.
- **A joined run says so**: `runs.get` marks it `joined`, and `teams.roster` counts each harness's joined runs. The app shows such a run as Live, not Status unknown, and says it has chat only where a terminal or thread would be.

## Consequences

- ADR 0034 said the app calls neither `pairs.join` nor `joined.pairJoin`. It now calls `pairs.join`, for a person.
- `endReason: "too_few_people"` now covers someone leaving as well as an account deletion.
- `pairPeople.removedAt` now means the person left or deleted their account. Account deletion (ADR 0035, slice 15) reads only rows without it, so a Pair someone left isn't visited again.
