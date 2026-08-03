# AE Llama — local LLM copilot panel for After Effects

A CEP extension panel for **After Effects 2024–2026 (Windows)** that runs a
local [llama.cpp](https://github.com/ggml-org/llama.cpp) model and lets it
**drive After Effects**: create comps, add and animate layers, apply effects,
set expressions, import footage, and queue renders — through a strict,
undo-friendly allowlist of tools.

```
┌─ AE Llama panel (CEP) ────────────────┐        ┌─────────────────────┐
│  model dropdown ▾   [Start]           │  HTTP  │  llama-server.exe   │
│  chat UI                              │◄──────►│  (your .gguf model) │
│                                       │        └─────────────────────┘
│  JSON commands  {tool, args}          │
│        │ allowlist executor           │
│        ▼ ExtendScript (evalScript)    │
│  jsx/hostscript.jsx → AE project DOM  │
└───────────────────────────────────────┘
```

Everything runs on your machine. No cloud calls, no telemetry.

## Requirements

- Windows 10/11
- After Effects 2024, 2025, or 2026
- PowerShell (preinstalled on Windows)
- A GGUF model file. Good starting points: Qwen2.5-7B-Instruct,
  Llama-3.1-8B-Instruct, or any instruct model in Q4_K_M quantization
  (~4–5 GB). Tool-following quality scales with model size.

## Install (once)

From the repo root in PowerShell:

```powershell
# 1. Download llama.cpp server binaries into extension\vendor\
.\scripts\get-llama.ps1              # CPU build
#  …or, with an NVIDIA GPU:
.\scripts\get-llama.ps1 -Variant cuda

# 2. Register the panel with After Effects (junction + PlayerDebugMode)
.\scripts\install.ps1
```

Then drop one or more `.gguf` files into `extension\models\` (or use the
panel's **Browse…** later), restart After Effects, and open
**Window ▸ Extensions ▸ AE Llama**.

## Using the panel

1. **Pick a model** from the dropdown. It lists every `.gguf` found in your
   models folder; choose **Browse for model file…** to navigate anywhere on
   disk — browsed files are remembered across sessions.
2. Press **Start**. The status dot turns green when the model is loaded
   (large models can take a minute; watch the log via the ▤ button).
3. Type what you want in the chat, e.g.:
   - *"Create a 1080p comp called Intro, 10 seconds at 30fps, with a dark
     grey background"*
   - *"Add a title that says HELLO, white, 200px, centered, and fade its
     opacity in over the first second"*
   - *"Apply a Gaussian Blur to layer 1 and animate blurriness from 0 to 40
     between 0s and 2s"*
   - *"Add a wiggle expression to the title's position"*

The model inspects your project, emits JSON tool calls, sees each result,
and iterates (up to *Max tool rounds*, default 4). Every mutation is wrapped
in an undo group — one **Ctrl+Z** reverts a whole action.

**Dry run** (in ⚙ Settings) shows what the model *would* do without touching
your project.

### Settings (⚙)

| Setting | Default | Notes |
|---|---|---|
| llama-server.exe | auto-found under `extension\vendor\` | Browse to any build you like |
| Models folder | `extension\models` | Scanned recursively for `.gguf` |
| Port | 8737 | Change if something else uses it |
| Context size | 8192 | Tokens; larger = more memory |
| GPU layers (-ngl) | 99 | 0 = CPU only; 99 = as many as fit |
| Temperature | 0.7 | Lower = more deterministic tool use |
| Max tool rounds | 4 | Caps the model's act→observe loop per message |

## How it drives After Effects (safety model)

The model never writes or runs raw scripts. It can only emit JSON like
`{"tool": "add_text_layer", "args": {...}}` chosen from a fixed allowlist
(`extension/js/tools.js`). The panel forwards each command to
`extension/jsx/hostscript.jsx`, which implements the tools with validation
and undo groups. Unknown tools are rejected panel-side, so the blast radius
is exactly the tool list — currently:

`get_project_info`, `get_comp_details`, `create_comp`, `add_text_layer`,
`add_solid`, `set_transform`, `add_keyframe`, `set_expression`,
`apply_effect`, `set_effect_param`, `set_layer_timing`, `delete_layer`,
`set_comp_setting`, `import_file`, `add_to_render_queue`

Structured output is enforced with llama.cpp's JSON-schema constrained
decoding (with a graceful fallback for older server builds).

## Repository layout

```
extension/            the CEP panel (this folder gets junctioned into AE)
  CSXS/manifest.xml   CEP manifest (AEFT 24.0–99.9, CSXS 11)
  index.html          panel markup
  js/                 panel logic (bridge, settings, server mgmt, tools, UI)
  jsx/hostscript.jsx  ExtendScript tool implementations (allowlist + undo)
  models/             put .gguf files here (gitignored)
  vendor/             llama.cpp binaries land here (gitignored)
scripts/
  get-llama.ps1       fetch llama.cpp Windows release binaries
  install.ps1         junction the panel + set PlayerDebugMode
  uninstall.ps1       remove the junction
```

## Troubleshooting

- **Panel missing from Window ▸ Extensions** — re-run `scripts\install.ps1`,
  fully restart AE. Check that
  `HKCU\Software\Adobe\CSXS.12\PlayerDebugMode` = `1` (string) and that
  `%APPDATA%\Adobe\CEP\extensions\com.cptk.aellama` exists.
- **"llama-server.exe not found"** — run `scripts\get-llama.ps1`, or set the
  path in ⚙ Settings.
- **Server never turns green** — open the log (▤). Out-of-memory on GPU?
  Lower *GPU layers*. Wrong binary (CUDA build without an NVIDIA driver)?
  Re-run `get-llama.ps1` without `-Variant cuda`.
- **Model produces junk commands** — small/base models struggle with tool
  use; prefer an *instruct* model ≥7B, or lower the temperature.
- **Port in use** — change the port in ⚙ Settings.
- **Debugging the panel** — with the panel open, visit
  `http://localhost:8092` in a browser for CEF DevTools (see
  `extension/.debug`).

## Roadmap (phase 2)

- AEGP C++ native plugin: menu commands, in-process inference option,
  render-hook integrations.
- Streaming token display and cancel button.
- More tools: shape layers, masks, precomposing, camera work, markers.
