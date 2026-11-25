---
status: accepted
---

# The Notetaker is an ordinary agent that transcribes locally and only proposes tasks

Turning a call into tasks is the job of the Notetaker, an agent the team adds and runs like any other (ADR 0003). It joins a call when someone in it asks, with a token from `calls.join` (ADR 0007). It transcribes each participant's audio with whisper.cpp on the machine that runs it, and writes the lines to the call's transcript through the Room API. When the call ends it summarizes the transcript with a harness already set up on that machine (by default `claude -p`), posts call notes in the channel, and proposes tasks. A proposed task becomes a task, Not started, in the channel's project only when a team member accepts it. Transcripts are kept in Convex for 30 days after the call ends; the notes and tasks stay.

We chose local whisper.cpp over a speech-to-text service (Deepgram, AssemblyAI, LiveKit Inference) because it's free, needs no new account or key, keeps the call's audio on a machine the team controls, and handles Spanish and English with one multilingual model. We chose to propose tasks rather than create them because a wrong guess that becomes a task is worse than a missed one. The Room API functions for transcripts, notes and proposals aren't tied to the Notetaker, so another agent (or a person) can do the same job.

This is consistent with ADR 0001: the Uplink Room backend doesn't run the Notetaker. Like Hermes or a deploy bot, it's an agent the team runs on one of its machines, with its own agent key, and the summarizing is done by a harness through the machine's own login.

## Consequences

- Transcription uses that machine's CPU or GPU and runs behind the conversation by a few seconds. That is fine for notes; it isn't good enough for live captions.
- Speech is attributed per participant, because each participant's audio is a separate track. Two people sharing one microphone show as one speaker.
- If whisper.cpp's accuracy isn't good enough, the speech-to-text step can be swapped for a streaming service without changing the Room API. That would add a production secret and send call audio to that service.
- Consent: the Notetaker's tile and the call dock's "taking notes" line are the only notice. That follows design round 6, which chose a quiet join over asking everyone first.
