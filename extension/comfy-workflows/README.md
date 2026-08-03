# ComfyUI workflow templates

Each `.json` file here is a ComfyUI workflow in **API format** and shows up
as a generation template the LLM can pick (`comfy_generate {workflow: "name"}`).
The folder location is definable in the panel's ⚙ Settings.

## Adding your own

1. Build the workflow in ComfyUI as usual.
2. Enable dev mode (Settings → *Dev mode* in older builds; newer builds show
   **Export (API)** in the Workflow menu by default).
3. **Export (API)** → save the JSON into this folder. The filename (minus
   `.json`) becomes the template name.

A regular **Save/Export** (UI format, has `nodes`/`links` keys) will be
rejected with a hint — only the API format is executable via the HTTP API.

## What the panel injects at generation time

The panel patches the graph by introspection, so most workflows work as-is:

- **prompt / negative** → `CLIPTextEncode` nodes, matched by following the
  sampler's `positive`/`negative` links (falling back to a "neg" in the
  node title).
- **width / height** → any node with numeric `width`+`height` inputs
  (`EmptyLatentImage`, video source nodes, …).
- **frames** → the first numeric `length`/`frames`/`video_frames`/`num_frames`
  input (video workflows).
- **seed** → every numeric `seed`/`noise_seed` input; randomized unless the
  LLM pins one.

Everything else (checkpoint, sampler, steps, LoRAs, resolution defaults)
stays exactly as you exported it.

## Included example

`example-txt2img.json` is a minimal SD checkpoint text-to-image graph.
Before using it, edit `ckpt_name` (`CHANGE-ME.safetensors`) to a checkpoint
that exists in your ComfyUI `models/checkpoints` folder — or just delete it
and export your own.

## Video notes

- End video workflows in a node that writes a real video file AE can import
  (e.g. SaveVideo / VHS Video Combine set to **mp4/H.264**). AE cannot
  import animated `.webp`.
- Video generation is slow; raise *Generation timeout* in ⚙ Settings if
  needed.
