# Managed backend environment + attention A/B — 2026-09-16

WORKPLAN §13a step 1 (the environment) and the first before/after
attention numbers. Measured on the owner's machine, local session.

## Environment (§13a step 1)

| fact | value |
|---|---|
| interpreter | `<dataRoot>\vendor\comfy\ComfyUI_windows_portable\python_embeded\python.exe` |
| python | 3.13.14 (MSC v.1944, 64 bit) |
| torch | 2.13.0+cu130 |
| CUDA torch was BUILT against | 13.0 |
| device | NVIDIA GeForce RTX 5090, compute capability (12, 0) |
| ComfyUI | 0.34.0 (`ComfyUI/comfyui_version.py`) |
| pip in the embedded interpreter | 26.2.1 (present) |
| `triton`, `sageattention`, `sageattn3`, `flash_attn`, `xformers` | all ABSENT |
| `comfy_kitchen` | PRESENT, core dependency of the portable build |
| `comfy_kitchen.int8_attention_is_available()` | **True** (compiled kernel `backends/cuda/_C.abi3.pyd`, floor capability 7.5) |

ComfyUI 0.34.0 has two attention flags that matter here
(`comfy/cli_args.py`): `--use-sage-attention` (needs the `sageattention`
package; if the import fails the backend logs an error and **exits**) and
`--use-ck-attention` (Comfy Kitchen INT8 attention, core, no install; if
the kernel is unavailable it logs an error and keeps the default
attention). Without either, the backend uses pytorch SDPA.

## A/B: shipped managed boot vs `--use-ck-attention`

Shipped boot args (`--disable-pinned-memory`) plus the flag, seed 12345,
`scripts/catalog-vram-probe.js` via `local/headroom-run.sh`. Backend log
confirmed `Using Comfy Kitchen attention` on every flagged run.

| entry | room | attention | peak delta MiB | seconds | output |
|---|---|---|---|---|---|
| sdxl | whole card | default | 7 194 | 7 | png 72bfc2… |
| sdxl | whole card | ck | 7 226 | 6 | png 0ff252… |
| ltx-small | whole card | default | 10 426 | 12 | md5 45630f… (the shipped reference) |
| ltx-small | whole card | ck | 10 426 | 12 | md5 239c31… |
| wan22-5b-fp8 | whole card | default | 24 315 | **124** | md5 ab4fa5… (the shipped reference) |
| wan22-5b-fp8 | whole card | ck | 24 317 | **96** | md5 abdf56… |
| wan22-5b-fp8 | 841 (8 GB card minus AE minus desktop floor) | default | — | **131 / 135** (6a, earlier tonight) | md5 ab4fa5… |
| wan22-5b-fp8 | 841 | ck | 80 | **102** (backend: 100.49 s) | md5 abdf56… (same as whole card) |

Quality, ck against default, same seed: Wan SSIM 0.974 / PSNR 33.9 dB
(min 30.4), ltx-small SSIM 0.978 / PSNR 34.3 dB, sdxl SSIM 0.957 /
PSNR 29.2 dB. Looked at (Wan frame 60, sdxl side by side): the same
picture with small detail differences, not a degraded one.

## What this says

- **Peak VRAM does not move** on any entry. On the whole card
  DynamicVRAM fills to what is free regardless; at 841 MiB of room the
  job already fits. Attention is not what sets the floor for these
  graphs, so this is not a reach lever for the shipped catalog.
- **Speed moves only where attention dominates:** Wan 5B at 1280x704x121
  is 23 % faster on the whole card and 22-24 % faster at an 8 GB card's
  room. sdxl and ltx-small are within a second.
- **Output changes** (a different, equal-quality sample), so every
  shipped md5 reference and `measuredSeconds` would need retaking if it
  shipped.
- Deterministic: the flagged Wan clip is identical at 841 MiB and on the
  whole card.
- Unmeasured: any card other than Blackwell sm120. The kernel claims 7.5+,
  but speed on RTX 20/30/40 is not known.
- Not measured: SageAttention itself. Nothing is installed; no wheel was
  looked up for python 3.13 / torch 2.13 / cu130.
