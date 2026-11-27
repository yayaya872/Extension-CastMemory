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

   A change of day, a time skip, or a move to a different place ENDS
   the scene. In the first reply of the new scene, log out every
   character who is not there, and log in every character who newly
   appears. Characters who simply continue into the new scene need no
   new block.

3. The FIRST time a character is introduced, emit their profile block
   BEFORE their first lines. This also logs them in — no separate login
   block is needed for them in that reply:
   <!-- castmemory character start
   Name: Character Name
   ...
   castmemory character end -->
   The "..." is the profile itself: plain markdown prose (age,
   appearance, personality, situation, relationship to {{user}},
   anything that defines them), written directly as the block body.
   Never wrap it in a label or parentheses — do NOT write anything
   like "(profile in markdown: ...)" in the block.

   When a later scene reveals a lasting change to a character (new
   resolve, injury, changed relationship), emit the same block again
   with the full updated profile — it replaces the old one. Memories
   are kept.

4. WORLD information is only the story's CONCEPT and initial setup
   (era, setting premise, the main stage in one line — e.g. "Modern
   Japan" / "The stage is ◯◯ Apartments"). Keep it small and emit it
   once, at the start:
   <!-- castmemory world start
   ...
   castmemory world end -->
   The "..." is the world info itself, written directly as plain
   markdown prose — no labels or wrappers around it.
   Do NOT put place details in the world block — places have their
   own blocks (rule 5).

5. PLACES: declare the current place in EVERY reply. At the start
   of each reply, look at the Locations list in <cast_memory> and
   declare where this reply's scene is:
   <!-- castmemory: here Place Name -->
   Copy the name exactly from the list — you are SELECTING from the
   list, not describing a move. Only the current place's detail is
   kept in front of you; the other places appear by name only.

   If the scene's place is NOT in the list yet, create it in the
   same reply, BEFORE the here block:
   <!-- castmemory location start
   Name: Place Name
   ...
   castmemory location end -->
   The "..." is the place's detail itself (layout, atmosphere, who
   is there, what it is used for), written directly as plain
   markdown prose — no labels or wrappers around it. When a lasting
   change to a place is established, emit the location block again
   with the full updated detail — it replaces the old one.

6. A character's REAL NAME is revealed after they were registered
   under a descriptive placeholder (e.g. 赤髪の戦士, 白いローブの
   魔道士): emit a rename block in the same reply where the name is
   revealed:
   <!-- castmemory: rename Old Name -> New Name -->
   Their profile, memories and stage state move to the real name.
   From then on, use the new name in every block. Rename only on a
   genuine name reveal — nicknames, titles and aliases do not count.

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
