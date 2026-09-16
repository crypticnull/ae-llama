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
the kernel is unavailable it logs an error and **also exits** -- CORRECTED
by NEXT UP 7a the same day, see below; this line first said it kept the
default attention, which was a misreading of `attention.py`). Without either, the backend uses pytorch SDPA.

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

## Shipped (NEXT UP 7a, 0.12.34) — gated, because the flag is fatal without the kernel

Fallback, measured: `CUDA_VISIBLE_DEVICES=-1`, `--cpu`, shipped args.
With `--use-ck-attention` the backend logged `Comfy Kitchen attention is
unavailable` and exited before `Starting server`; without it, it served.
`comfy_kitchen.int8_attention_is_available()` read False in that
environment and True on the 5090 (2.2 s from a cold python). The managed
boot now asks that function first and adds the flag only on True.

Retaken on the flagged boot, seed 12345, `local/ck-ship-run.sh`:

| entry | room | peak delta MiB | seconds | output |
|---|---|---|---|---|
| wan22-5b | whole card | 27 071 | **96** (backend 95.77) | md5 c328a1… |
| wan22-5b | 841 | 66 | **102** (backend 101.30) | md5 c328a1… (identical) |
| wan22-5b-fp8 | 841, rerun | 108 | **100** (backend 98.94) | md5 abdf56… (identical) |
| sd15 | whole card | 2 428 | 4 | png c12d65… (smoke only) |
| krea2 | whole card | 18 790 | 8 | png 06b2ee… (smoke only) |

Not run flagged: minimax-h3, minimax-h3-int8 (WORKPLAN NEXT UP 7c).

## SageAttention vs CK attention (NEXT UP 7b-2)

Wheels, installed with `pip --no-deps` into a robocopy of
`python_embeded` (`python_sage7b`, 4.08 GB, deleted afterwards; the
managed interpreter was checked to still have neither package):
`triton-windows==3.7.1.post27` (cp313) and woct0rdho
`sageattention-2.2.0+cu130torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl`.
`import torch, triton, sageattention` is clean (torch 2.13.0+cu130,
triton 3.7.1). Kernel smoke `sageattn` on a 1x24x4096x128 fp16 tensor:
it runs, no NaN, cosine 0.9993 against SDPA.

wan22-5b-fp8, whole card, shipped args plus the flag, seed 12345, back to
back in one session (`local/sage7b-run.sh` over `local/headroom-run.sh`,
which now takes `PYDIR`). AE was open and the idle floor was 2 436 MiB.

| attention | interpreter | backend log | peak MiB | delta MiB | executed s | output |
|---|---|---|---|---|---|---|
| sage | copy | `Using sage attention` | 27 616 | 25 180 | **96.58** | md5 47e5f5… |
| ck (control) | managed | `Using Comfy Kitchen attention` | 27 552 | 25 116 | **95.32** | md5 abdf56… (= shipped reference) |

Frame 60 of the Sage clip looked at: the same red toy car shot, no black
frames or noise (the post5 bug). Sage vs CK: SSIM 0.962, PSNR 32.0 dB
(min 29.9).

**Verdict:** no speed win and no VRAM win, so Sage is not worth an
install step here. The 841 MiB-room run was not taken. The pass ran in
the daytime with the owner at the machine, and a ballast leaving under
1 GB free is the open display question (WORKPLAN 5a-5c). With no
whole-card win it could not change the verdict.
