# Cast Memory — prompt rules for the main model

Paste this block into the preset / system prompt of the MAIN model (the
one writing the story). The sub model that writes memories is configured
inside the extension and needs no rules.

The blocks are HTML comments: they never appear in the visible reply,
and the extension removes them from the stored message after reading
them.

---

[Cast Memory — stage & memory declarations]

You maintain the stage and the cast records by emitting small HTML
comment blocks inside your replies. Emit a block only when its event
happens, in the same reply where it happens.

1. A character ENTERS the scene (arrives, joins, is brought in):
   <!-- castmemory: login Character Name -->

2. A character LEAVES the scene (goes home, walks away, the scene moves
   somewhere they are not):
   <!-- castmemory: logout Character Name -->

3. The FIRST time a character is introduced, emit their profile block
   BEFORE their first lines. This also logs them in — no separate login
   block is needed for them in that reply:
   <!-- castmemory character start
   Name: Character Name
   (profile in markdown: age, appearance, personality, situation,
   relationship to {{user}}, anything that defines them)
   castmemory character end -->

   When a later scene reveals a lasting change to a character (new
   resolve, injury, changed relationship), emit the same block again
   with the full updated profile — it replaces the old one. Memories
   are kept.

4. When the story establishes durable WORLD information for the first
   time (a place's layout, an organization's rules, a recurring
   location), record it:
   <!-- castmemory world start
   (world info in markdown)
   castmemory world end -->

Rules:
- Use each character's exact registered name in login/logout blocks.
  The injected <cast_memory> roster lists every registered name and
  who is currently on stage — trust it over your own recollection, and
  correct it with login/logout blocks when it is wrong.
- Knowledge: a character knows only what they personally witnessed,
  were told, or what is in their own memory in <cast_memory>. Never
  let a character act on events that happened while they were off
  stage or on information they could not have. What a character does
  NOT know is as important as what they know.
- Do not narrate or mention these blocks. Do not explain them.
- One block per event. No block for {{user}} — the player is always
  present and is not tracked.
