# The owner's authored KREA2 graph — a FIXTURE, not a shipped template

`AE_LLAMA_KREA2_V1.json` (API format) and its sidecar shipped in
`extension/comfy-workflows/` until 0.12.13, when WORKPLAN §18 P8 replaced
the krea2 catalog entry's graph with the core-only
`AE_LLAMA_KREA2_T2I_V1`. It left the bundle for the reason the owner gave
on 2026-09-06: *"build basic ones and redefine my supplied one as
alternate custom additions just for me for now. I want to fully build the
user's environment and think of mine as another level on top of that
that's separate."* It needs four custom node packs a user does not have
(rgthree Power Lora Loader / Any Switch / Image Comparer, easy
cleanGpuUsed, SesquiLatentUpscale), so a user who picked it got a graph
their backend refuses.

It is kept **here** rather than deleted because five suites use it as
their only realistic custom-node-heavy graph, and each of those five
proves something the core-only templates cannot:

- `test-workflow-adapt.js` — the converter's expected output: this file is
  exactly what `adapt-workflow.js` produces from
  `extension/workflows/AE_LLAMA_KREA2_V1.json` plus that folder's sidecar
  (subgraph expansion, cg-use-everywhere emulation, `panelAdaptation.setInputs`).
- `test-comfy-inject.js` — the case where the GENERIC encoder walk finds
  nothing and only a manifest `procedural.prompt` reaches the text.
- `test-comfy-optional-nodes.js` — a pack node with two outputs from two
  different inputs, which a single passthrough rule cannot answer for.
- `test-comfy-output-size.js` — a graph whose output size is not its latent
  size (the 1.6x latent upscale).
- `test-weight-availability.js` — a three-weight, three-loader graph.

The owner's own installed copy is untouched by the removal:
`setup.js`'s `ensureDataDirs` seeds, refreshes and preserves and has no
delete path, so a file already in `%APPDATA%\AE-Llama\comfy-workflows`
outlives its removal from the bundle. Its hashes stay in
`extension/comfy-workflows/.hash-history.json` forever, which is what
tells `ensureDataDirs` an installed copy is an unedited shipped one.

The authored UI-format source stays in `extension/workflows/` (which
§18 P11 removes from the packaged ZXP).
