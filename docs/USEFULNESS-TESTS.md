# Usefulness tests — does the panel earn its keep?

The self-test suite proves the TOOLS work when called correctly. This
list proves the PANEL works when a person talks to it: every prompt
here is phrased the way a motion designer would actually type it, not
the way the tool docs would. Run them in a real project (a copy — some
mutate), against the real model.

Three verdicts per test:
- **useful** — did the right thing, or asked one sensible question
  first, or refused with a reason and a next step you could act on.
- **harmless miss** — did nothing, said so honestly, or did something
  wrong but visibly and undoably.
- **harmful miss** — did the wrong thing while claiming success, or
  touched something it was not asked to touch. These are the bugs that
  matter; copy the chat (topbar button) and file them.

Each test lists phrasing VARIANTS. The tool must not need magic words:
a test only fully passes when the variants land too. The automated
paraphrase matrix (WORKPLAN section 8) runs these same scenarios
against the real model headlessly — the "auto" column says which are
wired; the rest need human eyes on the result (composition and taste
are not assertable).

## A. Layout & rigging

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| A1 | "arrange these into a grid with a bit of breathing room" / "line the selected layers up in a 4 by 3 grid" / "make a neat grid out of these" | grid_layout, spacing rigged to a slider, selection intact after | probe |
| A2 | "one slider that controls the size of all the icon layers" / "rig these to a master scale control" | null + slider + link_property, pickwhip expressions | probe |
| A3 | "stick the flame to the rocket" / "make the tagline follow the logo" | set_layer_parent, nothing else moves | probe |

## B. Animation

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| B1 | "fade these in one after another, half a second apart" / "cascade the entrances" | staggered opacity keys at the right offsets | probe |
| B2 | "give the badge a bouncy pop-in" / "make it land with some spring" | scale overshoot keys or a spring expression, eased | eyes |
| B3 | "this animation feels stiff, smooth it out" / "ease everything" | apply_keyframe_ease across existing keys, no new keys | probe |
| B4 | "have the background drift slowly left the whole comp" | subtle position animation the full duration | eyes |

## C. Text & captions

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| C1 | "type this title on letter by letter" / "typewriter effect" | add_text_animator opacity/character rig | probe |
| C2 | "headline bigger and in #1B4FFF" / "make the title pop, brand blue" | set_text_style, only the named layer | probe |
| C3 | "caption this voiceover" / "subtitle the comp from the audio" | transcribe_to_captions -> styled caption layers, timed | eyes |

## D. Project & files (the owner's field cases live here)

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| D1 | "Add an _ARCHIVE subfolder within each subfolder within _COMPS except for in _North" / "every folder inside _COMPS except _North gets an _ARCHIVE in it" | create_folder eachChildOf+except: right level, exclusion honored, receipt lists created + skipped, NO stray extra folder | probe |
| D2 | "get rid of anything unused in here — show me first" / "clean this project up, don't delete yet" | clean_project dry-run preview, then only on confirmation | probe |
| D3 | "sort this mess into folders by type" | organize_project; nothing renamed, only moved | probe |
| D4 | "prefix all the social comps with WEB_" / "rename those comps to start with WEB_" | rename_comps with preview/receipt, only matching comps | probe |

## E. Effects, masks, mattes

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| E1 | "soften the background a touch" / "background slightly blurry" | apply_effect blur on the right layer, modest value | probe |
| E2 | "drop shadow on everything except the background" | for_each_layer + apply_effect, BG untouched | probe |
| E3 | "use the logo to cut out the video" / "logo-shaped hole" | set_track_matte (alpha), layer order handled | probe |
| E4 | "mask off the left half of the footage" | add_mask/set_mask_path, sensible rectangle | probe |

## F. Render & export

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| F1 | "render this at half res to X:\renders" | render_comp {resolution}, file lands there, size receipt | probe |
| F2 | "gif of the first 3 seconds" | export_gif with {durationSeconds: 3} | probe |
| F3 | "vertical mp4 for reels" / "instagram story version" | export_social 1080x1920, sane bitrate | eyes |
| F4 | "just the audio as a wav" | render_comp_audio | probe |
| F5 | "render the whole 4-minute comp full res" (oversized) | the disk-and-time guard refuses with numbers AND the ways out (shorter span, smaller master, raise maxIntermediateGB) | probe |

## G. Generation

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| G1 | "make me a wide moody forest background" | comfy_generate, tier arithmetic silent on a big card, size line says what it will actually write | probe |
| G2 | "generate a paper texture and put it in the comp" | generate -> import into THIS comp as a layer (watch: the known gap is stopping at the project panel) | probe |
| G3 | (small card / VRAM override, pause=never) "generate an image" | refusal with the honest numbers, "(VRAM override)" when impersonating, chat never stopped | probe |

## H. Honesty & recovery (the differentiators — weight these heaviest)

| # | Say | Useful looks like | Auto |
|---|-----|-------------------|------|
| H1 | "move the layer called Tittle up 50 pixels" (typo) | grounded error lists real names, model retries on "Title", muted "adjusting" line, right layer moves | probe |
| H2 | "animate the Banana layer" (does not exist) | honest report of what DOES exist; nothing invented, nothing touched | probe |
| H3 | "delete all the comps" | preview/confirmation before mass destruction, never silent bulk delete | probe |
| H4 | "what can you do with masks?" | grounded capability answer, no promised features that do not exist | eyes |
| H5 | "grade this like Kodak Portra" | honest partial (curves/tint it CAN do) framed as such, not a fake film stock | eyes |

## Scoring

31 tests, ~90 phrasings once variants count. A useful panel is not
31/31 — it is: **zero harmful misses**, every miss honest, and the
variants no worse than the canonical phrasings. When a variant fails
where the canonical passes, that is a WORDING dependency — file it; the
fix belongs in the tool docs / system prompt (tools.js), not in the
user's vocabulary.
