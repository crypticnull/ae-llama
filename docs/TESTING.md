# AE Llama — test-user install guide

_Owner decision, 2026-09-28: AE Llama is a personal tool and is not for
sale. This guide installs the packaged panel on a machine; it is not a
store or support page._

AE Llama is an After Effects panel that drives AE with a local AI model:
you type what you want in plain language, it inspects your project and
does the work with real AE operations (layers, keyframes, expressions,
masks, effects, project-panel cleanup). Everything runs on your own
machine — no cloud, no account, nothing leaves your computer.

This is an **alpha**. It updates itself often, sometimes several times a
day. That is the point of testing it.

## What you need

- Windows 10 or 11
- After Effects 2024 or newer
- An NVIDIA GPU is strongly recommended — anything from ~4 GB VRAM up
  works; the panel sizes its AI model to your card automatically. No
  NVIDIA GPU also works (CPU mode, slower, lightest model).
- Disk space for the one-time model download: roughly 2–20 GB depending
  on your card (bigger card, better model).

## Install (once, ~2 minutes plus downloads)

1. Download the panel package:
   **https://raw.githubusercontent.com/crypticnull/ae-llama-updates/main/AE-Llama.zxp**
2. Install it with any ZXP installer (drag the `.zxp` onto it), or
   skip the installer: `scripts\install-zxp.ps1 -ZxpPath <path to .zxp>`
   from a clone of the repo extracts it straight into the CEP
   extensions folder.
3. In After Effects: **Edit → Preferences → Scripting & Expressions →
   check "Allow Scripts to Write Files and Access Network"**. The panel
   needs this to operate on your project.
4. Restart AE, then open **Window → Extensions → AE Llama**.
5. First run is hands-off: the panel detects your GPU, downloads the
   AI engine and the model recommended for your card (progress bar +
   cancel in the panel), and tells you when it is ready. Then just type
   into the chat box.

## Updates

Automatic — you never reinstall. The panel checks for updates when it
opens and installs them itself, then reloads. If you ever want to check
manually: the settings drawer has a "Check for updates" button.

## Trying it out

Open any project (a copy of a real one is the best test) and ask for
real work, in your own words:

- "add a null called CTRL and link the rotation of every text layer to
  a slider on it"
- "make a 3x3 grid of squares and stagger their opacity 4 frames apart"
- "add an _ARCHIVE subfolder inside each subfolder of _COMPS except
  Rejects"

The panel's settings drawer also has **Run self-test** — it builds a
scratch comp and runs the panel's full 200+ step regression suite
against your actual After Effects, then cleans up after itself. Green
means your install is healthy.

## When something goes wrong (this is the valuable part)

Use the **copy chat** button at the top of the panel — it copies the
whole conversation plus your version/model/GPU — and send that paste
back. That one paste is everything needed to reproduce and fix it.
Please send failures even (especially) when they seem dumb: "it made
the wrong folder" reports have directly produced same-day fixes.

Known alpha edges: image/video generation (the ComfyUI side) is still
being wired up per hardware tier — chat-driven AE work is the part to
hammer on right now.
