# The owner's authored MiniMax H3 graph — a FIXTURE, not a shipped template

`AE_LLAMA_H3_I2V_V1.json` (API format) and its sidecar shipped in
`extension/comfy-workflows/` until 0.12.14, when WORKPLAN §18 P9 replaced
the `minimax-h3` catalog entry's graph with the core-only
`AE_LLAMA_H3_T2V_V1`. It left the bundle for the reason the owner gave on
2026-09-06: *"build basic ones and redefine my supplied one as alternate
custom additions just for me for now. I want to fully build the user's
environment and think of mine as another level on top of that that's
separate."*

It needs **seven** custom node packs a user does not have — ComfyLiterals
(`Float`), comfyui-custom-scripts (`PlaySound|pysssss`), comfyui-easy-use
(`easy cleanGpuUsed`), comfyui-kjnodes (`ModelPreviewOverrideKJ`,
`MiniMaxH3MemoryEfficientSageAttentionPatch`),
ComfyUI-MiniMaxH3-FirstBlockCache (`ApplyMiniMaxH3FirstBlockCache`),
ComfyUI-sol-attn (`MiniMaxH3ScheduledSolAttentionPatch`) and
comfyui_nvidia_rtx_nodes (`RTXVideoSuperResolution`) — and it survived on a
bare backend only through the panel's `optionalNodes` rescue, which
demotes or substitutes each of them at queue time. A basic should not
need a rescue; that is the whole of why it was replaced.

It is kept **here** rather than deleted because it is this repo's only
graph that exercises several shapes no core-only template has:

- `test-workflow-adapt.js` — the converter's expected output: this file is
  exactly what `adapt-workflow.js` produces from
  `extension/workflows/AE_LLAMA_H3_I2V_V1.json` plus that folder's sidecar
  (the `panelAdaptation.dropNodes` of the Ollama enhancer pair).
- `test-comfy-optional-nodes.js` — the **only** manifest with a full
  `optionalNodes` block: five bypasses, one substitution
  (`Float` → core `PrimitiveFloat`, with an `as: number` coercion) and a
  terminal node with no consumer. Nothing shipped declares one any more.
- `test-workflow-manifests.js` — the three 2026-08-27 pack-attribution
  corrections (`ComfyMathExpression` and `ResolutionSelector` are CORE,
  not pack nodes; `PlaySound` is registered as `PlaySound|pysssss`), each
  of which replaced a plausible and wrong claim.
- `test-comfy-filename-tokens.js` — a `filename_prefix` carrying **two**
  `%date:…%` tokens in one string.
- `test-comfy-inject.js` / the `procedural.durationSeconds` path — a graph
  whose length is SECONDS fed to a math node, which is what makes
  `lengthIn` "seconds" and makes `injectParams` refuse a `frames` request.
  The shipped basics all carry a literal frame count instead.

The owner's own installed copy is untouched by the removal:
`setup.js`'s `ensureDataDirs` seeds, refreshes and preserves and has no
delete path, so a file already in `%APPDATA%\AE-Llama\comfy-workflows`
outlives its removal from the bundle. Its hashes stay in
`extension/comfy-workflows/.hash-history.json` forever, which is what
tells `ensureDataDirs` an installed copy is an unedited shipped one.

The authored UI-format source stays in `extension/workflows/` (which
§18 P11 removes from the packaged ZXP), alongside `AE_LLAMA_H3_R2V_V1`,
which never had an API counterpart at all.

**What left the product with it:** this was the last shipped template that
could take a first frame, so no bundled graph does image-to-video today.
Filed as WORKPLAN §18 P9a.
