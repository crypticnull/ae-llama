# Shaping a user's sentence into an H3 prompt

Written 2026-09-16, after the owner asked what best practice is for H3
image-to-video and text-to-video, and how the panel should route a user's
plain English into the right format.

Two sources: the vendor's own encoder (authoritative for MECHANICS) and
published prompt guidance (for CRAFT).

## 1. The mechanics, from the backend's own source

`comfy/text_encoders/minimax.py` states the presentation, and it is not
chat-templated - raw prompt/label text with vision blocks spliced in:

| mode | what the encoder builds |
|---|---|
| `t2va` (text to video) | `<prompt>` - nothing else |
| `fl2va` (first/last frame) | `"<Picture 1>: " <vision> ["<Picture 2>: " <vision>] <prompt>` |
| `ref2va` (references) | per condition in request order: image -> `"<Picture i>: "`, audio -> `"<Audio j>: "`, video -> `"<Video k>: "` then per-2-frame `"<T.T seconds>"` blocks - then `<prompt>` |

**The labels are emitted by the ENCODER, not typed by the user.** The
ordinals come from the order conditions are attached. So the "syntax"
that feels complex belongs to `ref2va`, and even there the user supplies
only `<prompt>` plus the attachments.

**For i2v and t2v there is no special syntax at all.** The prompt is free
text. Nothing needs escaping, labelling or ordering.

Two more facts worth pinning:

- The tokenizer extends Qwen with `<d> </d> <|cutoff|> <|lyrics_start|>
  <|lyrics_end|> <|caption_start|> <|caption_end|>`, but **this text path
  never emits them**. Duration is a NODE input here, not prompt syntax,
  which matches the authored i2v graph: `MiniMaxH3ImageToVideo` takes its
  own inputs and no text block carries a length.
- A text segment over the limit RAISES
  `"MiniMax H3 text segment exceeds the supported prompt length"`. A long
  enhanced prompt can FAIL rather than truncate, so the panel must bound
  what it sends.
  **Read 2026-09-17 on the managed 0.34.0:** "one batch" means
  `max_length=99999999` tokens (`comfy/text_encoders/qwen3vl.py`), so the
  raise is real but only reachable by a ~100 MB prompt. The panel's bound
  (`comfy.js H3_PROMPT_MAX_TOKENS`, one token covers at least one UTF-8
  byte) is a proof, not a practical limit.

## 2. The craft, from published guidance

Recommended element order:
**References -> Retention -> Scene -> Timeline -> Camera -> Audio -> Constraints.**

- **Camera** in natural filmmaking language, not bracket commands: dolly
  in/out, track left/right, pan, tilt, orbit, crane, handheld, whip pan,
  locked-off. At most about three simultaneous moves.
- **Timeline** in bracketed seconds: `[0-3s] ... [3-6s] ...`, and audio
  events can be bound to a moment: `[5.4s] a quiet ceramic click`.
- **Length**: detailed enough to remove ambiguity, not detailed for its
  own sake.
- **i2v needs LESS scene description than t2v** - the image already
  carries the scene. The mode changes what the prompt must explain, not
  its structure.

## 3. What the panel should do

The owner rejected the ComfyUI-side prompt enhancer for good reasons: it
competes with the panel's own chat model, adds steps, and loads another
model. Those reasons stand. The work it did is real and has to live
somewhere.

**Recommendation: format DETERMINISTICALLY in the panel, after the tool
call - not in the model, and not in the graph.**

The chat model keeps doing what it is good at: turning "make the logo
drift toward camera" into a `comfy_generate` call with a plain-English
`prompt`. The panel then assembles the H3 shape from what it ALREADY
knows:

| element | where the panel gets it |
|---|---|
| Scene | the user's own words, verbatim |
| Timeline | the clip length it already injects (`COMFY_DEFAULT_CLIP_SECONDS`, or a named `durationSeconds`), so `[0-Ns]` needs no guessing |
| Camera | only if the user said one, matched against the vocabulary above |
| References | the mode: i2v omits scene restatement, t2v keeps it |
| Constraints | omitted unless the user gave one |

**Never invent.** An element the user did not supply is left out, not
filled with a plausible default - the same rule that makes `lineMacros`
refuse to contribute a silent zero.

Why panel-side rather than teaching the model the format:

1. **It costs zero context.** The prompt budget is the binding constraint
   (section 24: about 800 tokens of conversation room today). A format
   the model must learn is paid every turn, forever; a formatter in
   `comfy.js` is paid once, in code.
2. **It is deterministic and testable.** A stub test can pin "this
   sentence plus a 6 s clip produces this string", which no amount of
   instruction can guarantee from a small quantized model.
3. **It matches the owner's own rule**: the model does not need to be
   clever, it needs to call the tool.

**DECIDED by the owner, 2026-09-17:** format only when the text carries
no timeline and no camera term; otherwise pass it through untouched. His
reasoning: "most people aren't going to use those terms anyway", so the
common case is formatted and the deliberate case is respected. The test
is therefore a DETECTOR, not a judgement: a bracketed seconds range or a
term from the camera vocabulary means hands off.

**Also owner-approved the same day:** the panel-side deterministic
approach over a model-side or graph-side enhancer.

**Owner idea, NOT decided, recorded so it is not lost:** an explicit "H3
mode" in the panel. He said "we could even have like an H3 mode or
something. We can think more about that." Do not build it off this
sentence; it needs a shape first.

## 4. What to build

**Built 2026-09-17 (steps 1-3):** `comfy.js formatH3Prompt` and
`shapeH3Prompt`, pinned in `tests/test-h3-prompt-format.js`. Step 4 is
still open.

1. `Comfy.formatH3Prompt(text, {mode, seconds, camera})` in `comfy.js`,
   pure and stub-testable, emitting the ordering above and omitting every
   element it was not given.
2. Bound the result against the encoder's length limit and refuse with a
   grounded error naming the limit, rather than letting the backend throw.
3. Pin it: a test per mode (t2v, i2v), one asserting nothing is invented,
   one asserting an already-cinematic prompt passes through untouched.
4. Only then consider the ref2v path - it is the one that genuinely needs
   ordinals, and the owner's ref2v graph is not in this repo.
