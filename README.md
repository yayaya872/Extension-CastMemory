# Cast Memory

Long-term memory and character persistence for SillyTavern roleplay.

Each character keeps **their own memories** — only of events they were
present for. Raw chat history sent to the model shrinks to the current
scene plus a short tail; everything older reaches the model as
per-character memories and world memory. A character who wasn't there
doesn't know — information asymmetry is structural, not prompted.

This repository is the merged edition built on Stockpile Memory
(v1.1.1, kept frozen in its own repository).

## How it works

1. **Presence (main model).** The story model declares who is on stage
   with tiny HTML-comment blocks — login when a character enters,
   logout when they leave, a profile block at first introduction. The
   extension parses and strips them and keeps the roster. See
   [PROMPT_RULES.md](PROMPT_RULES.md) for the block you paste into your
   preset.
2. **Memory writing (sub model).** When a scene closes (everyone
   logged out), when unwritten history passes a token threshold or a
   turn limit, or on a manual tap, a sub model of your choice (connection profile /
   OpenAI-compatible / Ollama / main API) reads the scene and writes:
   one subjective memory per participant, plus shared world-memory
   entries — as JSON, stored per character.
3. **Injection.** A `generate_interceptor` splices a `<cast_memory>`
   block into the exact outgoing chat array: the roster (who is on
   stage), world setting + world memory, the location list (one line
   each) with only the CURRENT location's detail in full, and for each
   on-stage character their profile and their own memories. Off-stage
   characters contribute only folded long-term memory, within budget.
4. **Hiding, safely.** Messages whose range is covered by written
   memories are flagged with SillyTavern's ignore symbol and leave the
   prompt — except the newest N messages (default 10), which always
   stay raw. **Unwritten messages are never hidden**: hiding only ever
   lands on memory-entry boundaries at or below the written frontier.

Older memories fold into a per-character long-term memory (and world
long-term memory) when they grow past a size threshold.

## UI

Two separate floating elements sit over the chat, each draggable
with its own saved position: a round 🎭 button — its badge shows how
many characters are on stage, and the mask turns into a spinner
while the sub model is writing memories — and a chip showing only
the current location's name. Tap the button to open the sheet; tap
the chip to open it on the World tab. A third, smaller 💬 float
opens the consult window: an overlay side chat with the main model
(it sees the cast memory block and the recent story), kept entirely
out of the story history. There you can discuss where the story
goes, have the model fix Cast Memory data by emitting the same
declaration blocks (e.g. register a character the story forgot), and
arm any of its replies as a one-shot GM instruction that rides on
your next main generation only. By default the consult window talks
through the main connection (whole replies); if you pick a
Connection Manager profile for it in the settings — the main
model's own profile works as-is — its replies stream into the
window live, with a stop button. The sheet has three tabs:

- **Characters** — the roster; tap a character for their profile and
  memories, rendered as markdown. Profiles are editable; presence can
  be toggled by hand; every memory entry can show its original
  messages or be deleted.
- **World** — the location list (tap for detail; set the current
  place by hand), world setting (concept only, from world blocks,
  editable) and world memory entries with the same original-text view.
- **Ops** — close the scene and write memories now, un-apply (send all
  originals again), add a character manually, wipe all data.

The same sheet is reachable from the wand (extensions) menu and from
the quick bar above the message input.

## Data & reversibility

Everything lives in `chatMetadata['cast_memory']` of each chat —
profiles, memories, world records, the presence log, and the
written/applied frontiers. The summary engine's data of the old
Stockpile Memory (`chatMetadata['stockpile_memory']`) is not touched.
Turning the extension off, or using "un-apply", restores the full raw
history; nothing is ever deleted from the chat itself.

## Settings highlights

- Newest messages kept raw (default 10)
- Mid-scene write threshold in tokens (default 6000)
- Injected memory budget (default 3000 tokens)
- Fold threshold per character / world (default 4000 chars)
- Sub-model connection: profile (recommended — e.g. a flat-rate
  model), OpenAI-compatible endpoint, Ollama, or the main API
- Writer / fold prompts are fully editable

## Lineage

Forked in code from Extension-StockpileMemory v1.1.1 (same author):
interceptor injection, ignore-flag hiding, the Popup-API sheet and the
top-anchored FAB (ST's transformed `<html>` breaks bottom-anchored
fixed elements on phones) are inherited from it. The storage,
presence system, per-character memory writing and UI are new.
