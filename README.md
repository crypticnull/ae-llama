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
- Disk space for the engine (~100–400 MB) and a model (~4–5 GB)

## Install

**As a buyer (ZXP)** — install the `.zxp` with the
[aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/),
restart AE, open **Window ▸ Extensions ▸ AE Llama**. That's it — on first
launch the panel sets itself up:

1. Detects your GPU (`nvidia-smi`) and picks the right llama.cpp build —
   the newest CUDA line your driver supports, CUDA 12 for pre-Turing cards,
   CPU when there's no NVIDIA GPU.
2. Downloads and unpacks the engine into `%APPDATA%\AE-Llama\` (outside the
   extension, so updates never touch it).
3. If you have no model yet, one button downloads a good starter model
   (Qwen2.5-7B-Instruct, ~4.7 GB). Or drop any `.gguf` into
   `%APPDATA%\AE-Llama\models\` / use **Browse…** in the dropdown.

**As a developer (this repo)** — from the repo root in PowerShell:

```powershell
# Stock Windows PowerShell blocks local scripts (Restricted policy):
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#   (or prefix calls with: powershell -NoProfile -ExecutionPolicy Bypass -File ...)
#   (ZIP download instead of git clone? also run: Unblock-File .\scripts\*.ps1)

.\scripts\install.ps1      # junction the panel + PlayerDebugMode
```

Restart AE and open the panel — the same hands-off first-run setup applies.
`scripts\get-llama.ps1` still exists for CI/offline prep (`-Variant auto`
does the same GPU detection; `cpu`/`cuda -CudaVersion 13` force builds).

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
| llama-server.exe | auto-installed under `%APPDATA%\AE-Llama\vendor\` | Browse to any build you like |
| Models folder | `%APPDATA%\AE-Llama\models` | Scanned recursively for `.gguf` |
| Port | 8737 | Change if something else uses it |
| Context size | 8192 | Tokens; larger = more memory |
| GPU layers (-ngl) | 99 | 0 = CPU only; 99 = as many as fit |
| Temperature | 0.7 | Lower = more deterministic tool use |
| Max tool rounds | 4 | Caps the model's act→observe loop per message |

The **Updates** section of the drawer shows the installed version, checks
the update channel on demand, and can force-reinstall the engine.

## How it drives After Effects (safety model)

The model never writes or runs raw scripts. It can only emit JSON like
`{"tool": "add_text_layer", "args": {...}}` chosen from a fixed allowlist
(`extension/js/tools.js`). The panel forwards each command to
`extension/jsx/hostscript.jsx`, which implements the tools with validation
and undo groups. Unknown tools are rejected panel-side, so the blast radius
is exactly the tool list — currently:

`get_project_info`, `get_comp_details`, `create_folder`, `move_to_folder`,
`rename_item`, `delete_item`, `duplicate_comp`, `organize_project`,
`create_comp`, `add_text_layer`,
`set_text_style`, `add_solid`, `add_shape_layer`, `add_mask`, `precompose`,
`add_camera`, `add_marker`, `add_null`, `add_control`, `link_property`,
`apply_expression_preset`, `grid_layout`, `set_layer_3d`, `set_layer_parent`,
`set_transform`, `center_anchor_point`, `add_keyframe`, `set_expression`,
`apply_effect`,
`set_effect_param`, `set_layer_timing`, `delete_layer`, `set_comp_setting`,
`import_file`, `add_to_render_queue`, `comfy_status`,
`comfy_list_workflows`, `comfy_generate`

Rigging is first-class: *"put Speed and Wobble sliders on a null and drive
the title's rotation and wiggle from them"* becomes `add_null` →
`add_control` → `link_property` / `apply_expression_preset`. The panel
generates every expression itself (dimension-aware, names escaped), so the
model never hand-writes expression syntax; when it does use raw
`set_expression`, AE's own validation error is fed back so it can correct
itself. Text layers support full styling: font, size, fill, tracking,
leading, justification — at creation (`add_text_layer`) or later
(`set_text_style`).

While the model streams its answer you see the reply text live, and the
**Send** button becomes **Stop** — cancelling aborts generation on the
server immediately and halts any remaining tool commands.

## ComfyUI integration (image / video generation)

If you have a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
install, the LLM can render images and video and pull them straight into
your AE project:

> *"Generate a 1920×1080 stormy sky background and add it to the Intro comp"*

runs `comfy_generate` → queues an API-format workflow on your ComfyUI
instance → waits → downloads the render → imports it into the project, all
locally.

Setup (all paths definable in ⚙ Settings):

1. **Instance URL** — where ComfyUI listens (default `http://127.0.0.1:8188`).
   If ComfyUI is already running, that's all you need — press
   **Test connection**.
2. **Install folder** — optional; lets the panel's **Launch ComfyUI** button
   start it for you. Portable builds (`run_nvidia_gpu.bat` / `run_cpu.bat` /
   embedded Python) and plain checkouts (`main.py` + `python` on PATH) are
   detected. Custom venv setups: start ComfyUI yourself and just set the URL.
3. **Workflow templates folder** — drop ComfyUI **Export (API)** JSON files
   here (default `%APPDATA%\AE-Llama\comfy-workflows\`, seeded with a
   starter txt2img example — edit its `ckpt_name` first). The panel injects
   prompt/negative/size/seed/frames into your graph by node introspection;
   see `extension/comfy-workflows/README.md` for the exact rules.
4. **Generated files folder** — where renders are saved before being
   imported (default `%APPDATA%\AE-Llama\generated\`).

Video workflows should end in an AE-importable container (mp4/H.264 via
SaveVideo or VHS Video Combine — AE can't import animated webp), and may
need a higher *Generation timeout*.

Structured output is enforced with llama.cpp's JSON-schema constrained
decoding (with a graceful fallback for older server builds).

## Data folder & what survives updates

Everything heavy or user-owned lives in `%APPDATA%\AE-Llama\`, **outside**
the extension, because an extension update replaces the extension folder
wholesale:

```
%APPDATA%\AE-Llama\
  vendor\llama.cpp\   engine binaries (auto-installed, re-downloadable)
  models\             your .gguf models
  comfy-workflows\    your generation templates (seeded on first run)
  generated\          ComfyUI renders
  settings.json       settings mirror (localStorage backup)
```

Updating or reinstalling the panel never touches models, templates,
settings, or the engine.

## Distributing & updating (aescripts.com)

Every push builds a signed ZXP on CI (**Actions ▸ Build ZXP ▸ artifact
`AE-Llama-zxp`**); pushing a `v*` tag (e.g. `git tag v0.3.0 && git push
--tags`) additionally attaches it to a GitHub Release — that's the
downloadable package. For a stable signing identity across releases, add
repo secrets `ZXP_CERT_B64` (base64 of your .p12) and `ZXP_CERT_PASSWORD`;
otherwise CI self-signs per build (still installs fine).

Release flow:

1. Bump the version in **both** `extension/CSXS/manifest.xml`
   (`ExtensionBundleVersion` + `Extension Version`) and
   `extension/js/version.js` — the packager refuses a mismatch.
2. Build the signed ZXP: `.\scripts\package-zxp.ps1`
   (needs [ZXPSignCmd](https://github.com/Adobe-CEP/CEP-Resources) once;
   creates and reuses a self-signed cert — sufficient for CEP, buyers
   install via the aescripts ZXP Installer, no debug mode involved).
   Output: `dist\AE-Llama-<version>.zxp`. Dev files (`.debug`) and any
   local binaries are excluded automatically.
3. Upload to aescripts.com.
4. Update the hosted `update.json` (template in the repo root; host it at
   any stable URL you control and point `UPDATE_MANIFEST_URL` in
   `extension/js/version.js` at it **before** building):
   - `panelVersion` / `panelUrl` / `notes` — installed panels compare
     versions on launch and show an update banner.
   - `panelPackageUrl` (optional) — direct self-update. When set to a
     downloadable `.zxp`/`.zip` of the new version, the banner gains an
     **Update now** action that installs it in place (reopen the panel to
     load it), and the ⚙ *Install panel updates automatically* toggle makes
     the whole loop hands-off. Leave it **empty** for aescripts builds so
     buyers go through the store and licensing stays intact. Dev installs
     (extension junctioned from a git clone) ignore this field entirely —
     for them "Update panel now" simply runs `git pull` in the repo.
   - `llamaTag` — pin the llama.cpp release your build was tested against;
     the panel's engine installs/updates use it instead of `latest`.
   - `starterModel` — swap the recommended model without shipping a new ZXP.

## Repository layout

```
extension/            the CEP panel (ships as the ZXP)
  CSXS/manifest.xml   CEP manifest (AEFT 24.0–99.9, CSXS 11)
  index.html          panel markup
  js/                 panel logic (bridge, version, settings, llama server
                      mgmt, ComfyUI client, auto-setup/updates, tools, UI)
  jsx/hostscript.jsx  ExtendScript tool implementations (allowlist + undo)
  comfy-workflows/    bundled workflow templates (seeded into the data dir)
native/               AEGP C++ plugin scaffold (phase 2, experimental):
                      Window-menu command that opens the panel; see
                      native/README.md for SDK setup and build
scripts/
  get-llama.ps1       dev/CI engine download (-Variant auto|cpu|cuda,
                      -ListOnly to see the pick without downloading)
  install.ps1         dev install: junction the panel + PlayerDebugMode
  uninstall.ps1       remove the dev junction
  package-zxp.ps1     build the signed ZXP for distribution
.github/workflows/    CI: builds the signed ZXP, attaches it to releases
update.json           update-channel manifest template (host your copy)
```

## Troubleshooting

- **ZXP Installer says "no compatible program available" / asks for a
  Creative Cloud login you already have** — the installer's Adobe-app
  detection is failing, not the ZXP. In order: update to the latest
  [ZXP/UXP Installer](https://aescripts.com/learn/zxp-installer/) (older
  builds don't recognize new AE releases like 2026); launch it normally,
  NOT "Run as administrator" (elevation changes the user context, which
  breaks both app detection and the CC login check); sign out/in of the
  Creative Cloud desktop app and retry. Or skip the installer entirely:
  `.\scripts\install-zxp.ps1 -ZxpPath <path to .zxp>` extracts the signed
  panel straight into the CEP extensions folder (equivalently: rename the
  `.zxp` to `.zip` and extract it to
  `%APPDATA%\Adobe\CEP\extensions\com.cptk.aellama`).
- **Panel missing from Window ▸ Extensions** — re-run `scripts\install.ps1`,
  fully restart AE. Check the PlayerDebugMode string value = `1` under the
  key for *your* AE version: `HKCU\Software\Adobe\CSXS.11` for AE 2024,
  `HKCU\Software\Adobe\CSXS.12` for AE 2025/2026. Also confirm
  `%APPDATA%\Adobe\CEP\extensions\com.cptk.aellama` exists.
- **"llama-server.exe not found" / first-run setup failed** — use
  **Reinstall / update engine** in ⚙ Settings (needs internet), or run
  `scripts\get-llama.ps1`, or Browse to any llama-server.exe you have.
- **Server never turns green** — open the log (▤). Out-of-memory on GPU?
  Lower *GPU layers*. Wrong build for your GPU? **Reinstall / update
  engine** re-detects, or force one with `get-llama.ps1 -Variant cpu`.
- **Model produces junk commands** — small/base models struggle with tool
  use; prefer an *instruct* model ≥7B, or lower the temperature.
- **Port in use** — change the port in ⚙ Settings.
- **ComfyUI unreachable** — start it (Launch button or manually) and check
  the URL with **Test connection**. `comfy_generate` errors mentioning a
  node usually mean the workflow references a checkpoint/custom node your
  ComfyUI doesn't have — fix the template in ComfyUI and re-export.
- **Debugging the panel** — with the panel open, visit
  `http://localhost:8092` in a browser for CEF DevTools (see
  `extension/.debug`).

## Roadmap

- [x] Streaming reply display and Stop button
- [x] Shape layers, masks, precomposing, cameras, markers, 3D, parenting
- [x] AEGP C++ scaffold (`native/`) — menu command opening the panel;
      needs a local AE SDK to compile (untested until then)
- [ ] AEGP in-process inference (llama.cpp linked directly) + render hooks
- [ ] Starter model catalog (multiple sizes) in the update manifest
