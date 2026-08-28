# ComfyUI local inventory — the owner's machine

Captured 2026-08-25 by the local session (WORKPLAN item 2c). Pure
filesystem read: ComfyUI was NOT launched and nothing was generated.
Sizes are binary MB (`bytes / 1048576`), rounded.

This exists because the remote session cannot see this disk. Anything
the bundled installer or the tier plan assumes about "a ComfyUI
install" should be checked against what is actually here.

## Findings that change the plan

1. **There are THREE model roots, not one.** `C:\Users\mr\Documents\ComfyUI\models`,
   the Comfy-Desktop code install, and
   `C:\Users\mr\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models` — the
   Desktop app's shared auto-download store, which holds 244.2 GB
   including every MiniMax H3 weight. ComfyUI resolves each model kind
   across the shared root FIRST, then Documents. A scan of one root
   answers wrongly: this document originally declared the H3 tier
   blocked for exactly that reason, and it was not.
2. **Code and data live in DIFFERENT roots.** `C:\Users\mr\Documents\ComfyUI`
   is the data/base folder (models, custom_nodes, user, input, output) —
   it has no `comfy/` package in it. The code ComfyUI actually runs is
   at `C:\Users\mr\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`.
   An installer that derives one root from the other will be wrong on
   this machine.
3. **Version 0.32.0, and the comparison is a trap.** The manifest wants
   `>=0.3.76`. Lexically `"0.32.0" < "0.3.76"`; numerically it is far
   newer. The gate must compare component-wise — the same bug class the
   panel's own `compareVersions` exists to avoid.
4. **All five Krea manifest models are present**, and the exact filename
   `krea2_turbo_int8_convrot.safetensors` does resolve. The
   register-existing matcher can be exact-name for this workflow.
5. **Every UNKNOWN custom node in the manifest is accounted for** — see
   the attribution table. One of them (`DepthAnythingV2Preprocessor`)
   ships in TWO installed packs, so which one registers depends on load
   order.
6. **MiniMax H3 IS fully provisioned — CORRECTED 2026-08-25.** The
   first pass of this document said the base weight was missing and the
   tier was blocked. That was wrong: it only scanned the Documents root.
   Both H3 transformers, the 32B encoder and both VAEs live in the
   shared root. Nothing needs downloading.
7. **Wan 2.2 is fully provisioned** (I2V fp16, fp8 and Q8 GGUF, plus the
   lightning/lightx2v 4-step LoRAs and umt5 encoders).
8. Total weights on disk: **320 files, 1255.5 GB** across the two model roots. Any catalog that
   offers to download what is "missing" needs to check first — most of
   it is already here, sometimes under names that do not match upstream.

## Install layout

| what | path | note |
| --- | --- | --- |
| Data / base folder | `C:\Users\mr\Documents\ComfyUI` | models, custom_nodes, user, input, output |
| Code actually run | `C:\Users\mr\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI` | v0.32.0 |
| Electron bundle copy | `C:\Users\mr\AppData\Local\Programs\ComfyUI\resources\ComfyUI` | v0.22.2 — STALE, do not read the version from here |
| Python | `C:\Users\mr\Documents\ComfyUI\.venv\Scripts\python.exe` | 3.12.11 |
| Desktop marker | `.comfyui-desktop-2` | `inst-1782844229269` |

Version provenance: the running instance logs its own version at
startup. `user/comfyui_8000.log` (2026-08-25 12:01) says **0.32.0**;
`comfyui_version.py` in the Programs bundle still says 0.22.2 and older
logs say 0.20.1. Read the log or the Comfy-Desktop install, never the
Programs copy. There is no git checkout — `Documents\ComfyUI` is not a
repository, so there is no tag to read.

Runtime facts from the same startup log, useful for tier ceilings:

- GPU: NVIDIA GeForce RTX 5090, **32607 MB VRAM**
- System RAM: 62852 MB; pinned memory 25140 MB
- torch 2.10.0+cu130, pytorch attention, cudaMallocAsync
- `comfy_kitchen` backends: cuda and eager available, triton disabled

## extra_model_paths

There is **no** `extra_model_paths.yaml` in either root. ComfyUI Desktop
uses its own file instead:

`C:\Users\mr\AppData\Roaming\ComfyUI\extra_models_config.yaml`

```yaml
comfyui_desktop:
  is_default: "true"
  custom_nodes: custom_nodes/
  download_model_base: models
  base_path: C:\Users\mr\Documents\ComfyUI
desktop_extensions:
  custom_nodes: C:\Users\mr\AppData\Local\Programs\ComfyUI\resources\ComfyUI\custom_nodes
```

That file declares ONE model root and a second custom-node root inside
the Programs bundle. It does not tell the whole story: the Desktop app
also resolves models out of its shared auto-download store
(`ComfyUI-Shared`, below) without declaring it here. The authority on
what is actually live is the running instance's startup log, which
prints the resolved roots per model kind:

```
[LoRA-Manager] Found checkpoint roots:
 - C:/Users/mr/AppData/Local/Comfy-Desktop/ComfyUI-Shared/models/checkpoints
 - C:/Users/mr/AppData/Local/Comfy-Desktop/ComfyUI-Shared/models/diffusion_models
 - C:/Users/mr/AppData/Local/Comfy-Desktop/ComfyUI-Shared/models/unet
 - C:/Users/mr/Documents/ComfyUI/models/checkpoints
 - C:/Users/mr/Documents/ComfyUI/models/diffusion_models
 - C:/Users/mr/Documents/ComfyUI/models/unet
```

**Shared root FIRST, Documents second** — so a file present in both is
served from the shared copy. Nothing lives on another drive.

A scan that only walks `Documents\ComfyUI\custom_nodes` will also miss
whatever the desktop ships in the Programs bundle.

**The register matcher's root list**, in resolution order:

1. `C:\Users\mr\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models`
2. `C:\Users\mr\Documents\ComfyUI\models`
3. per-node checkpoint dirs, e.g.
   `Documents\ComfyUI\custom_nodes\comfyui_controlnet_aux\ckpts`
4. the code install
   (`AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`) for
   version only — it holds no user models

There is also a vestigial `Documents\ComfyUI\ComfyUI\custom_nodes`
holding `ComfyUI-VideoHelperSuite` and `DazzleNodes`, plus
`custom_nodes_backup` (30 entries) and an empty `custom_nodes_temp`.
None of these are on the live path; do not count them as installed.

## Krea manifest requirements — checked

Against `extension/workflows/AE_LLAMA_KREA2_V1.manifest.json`. The
workflow JSON itself references the same five filenames, so these are
what a load will actually ask for.

| manifest file | expected dir | found at | MB | verdict |
| --- | --- | --- | ---: | --- |
| `krea2_turbo_int8_convrot.safetensors` | checkpoints-or-diffusion_models | `models/diffusion_models/` | 12868 | OK — exact name |
| `qwen3vl_4b_fp8_scaled.safetensors` | text_encoders | `models/text_encoders/` | 5000 | OK — exact name |
| `qwen_image_vae.safetensors` | vae | `models/vae/` | 242 | OK — exact name |
| `depth-control-lora.safetensors` | loras | `models/loras/` | 822 | OK — exact name (optional branch) |
| `depth_anything_v2_vitl.pth` | controlnet-aux | `custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Large/` | 1279 | OK — but NOT under `models/` |

The last row is the one to watch: `comfyui_controlnet_aux`
auto-downloads into its own `ckpts/` tree, so a "do I have it?" check
scoped to `models/` will report it missing and re-download 1.3 GB.

Neighbours worth knowing about, because their names are close enough to
confuse a fuzzy matcher — all distinct files:
`Krea-2-Raw.safetensors` (25066), `krea2TurboOfficialComfy_krea2TurboBf16.safetensors`
(25066), `krea2Dmergev3_int8ConvrotV3.safetensors` (12867),
`darkBeastINT8Convrot2_darkBeastKREA2FP8.safetensors` (21175),
`moodyKrea2Mix_v30BF16.safetensors` (24452),
`lustifyNSFWCheckpoint_v10Krea2.safetensors` (12226), and
`models/text_encoders/!krea2_text_encoder.safetensors`. Note that
`krea2Dmergev3_int8ConvrotV3` is within 1 MB of the manifest's file but
is NOT it. Match on exact name, not on substring.

## MiniMax H3 — provisioned (corrected)

Every piece is on disk. The base weights are in the SHARED root, which
the first pass of this document did not scan; the LoRAs and one VAE
variant are in the Documents root. Both are live, so ComfyUI sees all
of it.

| piece | file | root | MB |
| --- | --- | --- | ---: |
| Transformer, frame+language to video/audio | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | shared | 19999 |
| Transformer, reference to video/audio | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` | shared | 19999 |
| Text encoder (nvfp4 AWQ) | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | shared | 14960 |
| Video VAE (fp16) | `vae/minimax_h3_video_vae_fp16.safetensors` | shared | 4967 |
| Audio VAE (fp32) | `vae/minimax_h3_audio_vae_fp32.safetensors` | shared | 577 |
| Video VAE (int8 convrot) | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | Documents | 3025 |
| Turbo 4-step LoRA (pruned) | `loras/MiniMax_H3/minimax_h3_turbo_4step_comfyui_pruned.safetensors` | Documents | 592 |
| Turbo 4-step LoRA (ckpt850) | `loras/MiniMax_H3/minimax_h3_turbo_4step_ckpt850.safetensors` | Documents | 744 |
| Turbo 4-step LoRA (ema) | `loras/MiniMax_H3/minimax_h3_turbo_4step_ema_ckpt850.safetensors` | Documents | 744 |
| Style LoRAs (4) | `loras/MiniMax_H3/` — `H3_Mis_Insrt_v07` (296), `HMNSFW_AIO_V2` (296), `h3_musubi_v4-000040` (284), `MysticXXX_MMH3-V1` (569) | Documents | |

`fl2va` is the weight the i2v workflow targets, and it covers t2v (no
image) as well — so it, not `ref2va`, is the first target.

The encoder on this machine is the **nvfp4 AWQ** variant. That is fine
here (RTX 5090 is Blackwell) but it is NOT a safe default for a bundled
installer — a non-nvfp4 variant is needed for anyone else, which is why
the tier plan pins the alternatives separately.

Three H3 node packs are installed: `ComfyUI-Spectrum-MiniMax-H3`,
`ComfyUI-MiniMaxH3-FirstBlockCache`, and `h3_dance_studio` (the
owner's own repo). ComfyUI's built-in `MinimaxHailuoVideoNode` and
friends are cloud API nodes, unrelated to any of this.

## Wan 2.2

Fully provisioned, in three precisions — the tier plan can offer a
low-VRAM and a full path without downloading anything.

| role | file | MB |
| --- | --- | ---: |
| I2V high fp16 | `diffusion_models/wan2.2_i2v_high_noise_14B_fp16.safetensors` | 27254 |
| I2V low fp16 | `diffusion_models/wan2.2_i2v_low_noise_14B_fp16.safetensors` | 27254 |
| I2V high fp8 | `diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 13633 |
| I2V low fp8 | `diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 13633 |
| I2V high Q8 GGUF | `diffusion_models/Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf` | 14693 |
| I2V low Q8 GGUF | `diffusion_models/Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf` | 14693 |
| T2V high/low fp8 | `unet/wan2.2_t2v_*_noise_14B_fp8_scaled.safetensors` | 13632 each |
| T2V low Q2_K GGUF | `unet/wan2.2_t2v_low_noise_14B_Q2_K.gguf` | 5054 |
| Text encoder | `text_encoders/umt5_xxl_fp16.safetensors` | 10840 |
| Text encoder (fp8) | `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6424 |

Plus 14 Wan LoRAs under `models/loras/wan/` (lightning and lightx2v
4-step accelerators for both noise halves, SVI PRO rank-128, and
several style LoRAs).

Note the fp8 I2V pair is duplicated in BOTH `diffusion_models/` and
`unet/` — 27 GB of the total is the same two files stored twice.

## Custom node packs

70 packs on the live path (`Documents\ComfyUI\custom_nodes`), none
disabled. Repo taken from `.git/config` where present, else from
`pyproject.toml`.

### Manifest UNKNOWN nodes — attributed

| node class | pack | repo |
| --- | --- | --- |
| `Krea2ControlImageEncode` | `comfyui-krea2-controlnet` | https://github.com/facok/comfyui-krea2-controlnet |
| `Krea2ControlApply` | `comfyui-krea2-controlnet` | (same) |
| `Krea2ControlLoRALoader` | `comfyui-krea2-controlnet` | (same) |
| `DepthAnythingV2Preprocessor` | `comfyui_controlnet_aux` | https://github.com/Fannovel16/comfyui_controlnet_aux |
| `ArcaneBloomFX` | `crt-nodes` | https://github.com/PGCRT/CRT-Nodes |
| `easy cleanGpuUsed` | `comfyui-easy-use` | https://github.com/yolain/ComfyUI-Easy-Use |
| `OllamaGenerateV2` (bypassed) | `comfyui-ollama` | https://github.com/stavsap/comfyui-ollama |

**CORRECTED 2026-08-27.** This table was built by grepping pack sources
for class names, and grep cannot tell a definition from a mention. Three
of its warnings did not survive being asked of the running loader
(`/object_info`, which reports a `python_module` per registered class):

- `DepthAnythingV2Preprocessor` is NOT defined twice. `comfyui-art-venture`
  is installed and loads 78 classes, but it only *references* the name as a
  lookup into someone else's mapping (`modules/controlnet/preprocessor.py`
  line 34). One definition, one pack, no load-order risk.
- `ResolutionSelector` does not collide with `ComfyUI-UtilsCollection`
  either. That pack registers `ResolutionSelectorExtended` — a different
  class name. `ResolutionSelector` is core (`comfy_extras.nodes_resolution`).
- `PlaySound` does not collide with KJNodes. The classes are
  `PlaySound|pysssss` and `PlaySoundKJ`, both loaded at once.

The lesson is the method, not the three entries: attribution belongs to the
loader, which knows what it registered, and never to a text search. The
manifests now carry per-workflow attribution generated that way — see
`scripts/attribute-workflow-nodes.js`, and `tests/test-workflow-manifests.js`
for the offline invariant that keeps them honest.

The manifest's four KNOWN packs are all present and confirmed:
`rgthree-comfy`, `cg-use-everywhere`, `comfyui_essentials`, and
`SesquiLSR` (which does provide `SesquiLatentUpscale`).

### All 70 packs

| pack | repo | source |
| --- | --- | --- |
| `ComfyLiterals` | https://github.com/M1kep/ComfyLiterals | git |
| `ComfyUI-AnimateDiff-Evolved` | — | none |
| `ComfyUI-Chibi-Nodes` | https://github.com/chibiace/ComfyUI-Chibi-Nodes | git |
| `ComfyUI-FilePathCreator` | https://github.com/HECer/ComfyUI-FilePathCreator | git |
| `ComfyUI-GGUF` | https://github.com/city96/ComfyUI-GGUF | pyproject |
| `ComfyUI-Krea2T-Enhancer` | https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer | pyproject |
| `ComfyUI-LTXVideo` | https://github.com/Lightricks/ComfyUI-LTXVideo | git |
| `ComfyUI-MelBandRoFormer` | https://github.com/kijai/ComfyUI-MelBandRoFormer | pyproject |
| `ComfyUI-MiniMaxH3-FirstBlockCache` | https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache.git | git |
| `ComfyUI-Pixelization` | https://github.com/DarioFT/ComfyUI-Pixelization | git |
| `ComfyUI-PromptRelay` | https://github.com/kijai/ComfyUI-PromptRelay.git | git |
| `ComfyUI-QwenVL` | https://github.com/1038lab/ComfyUI-QwenVL | pyproject |
| `ComfyUI-SelectStringFromListWithIndex` | https://github.com/wirytiox/ComfyUI-SelectStringFromListWithIndex | pyproject |
| `ComfyUI-Spectrum-MiniMax-H3` | https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3 | git |
| `ComfyUI-Upscaler-Tensorrt` | https://github.com/yuvraj108c/ComfyUI-Upscaler-Tensorrt | git |
| `ComfyUI-UtilsCollection` | https://github.com/silveroxides/ComfyUI-UtilsCollection | git |
| `ComfyUI-sol-attn` | https://github.com/Saganaki22/ComfyUI-sol-attn.git | git |
| `ComfyUI_Comfyroll_CustomNodes` | https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes | git |
| `ComfyUI_Ib_CustomNodes` | https://github.com/Chaoses-Ib/ComfyUI_Ib_CustomNodes | git |
| `ComfyUI_LayerStyle_Advance` | https://github.com/chflame163/ComfyUI_LayerStyle_Advance | pyproject |
| `Comfyui-Resolution-Master` | https://github.com/Azornes/Comfyui-Resolution-Master | pyproject |
| `Comfyui_joytag` | https://github.com/StartHua/Comfyui_joytag | git |
| `RES4LYF` | https://github.com/ClownsharkBatwing/RES4LYF/ | git |
| `SesquiLSR` | https://github.com/LoganBooker/SesquiLSR.git | git |
| `cg-use-everywhere` | https://github.com/chrisgoringe/cg-use-everywhere | pyproject |
| `comfy-image-saver` | https://github.com/giriss/comfy-image-saver | git |
| `comfyui-art-venture` | https://github.com/sipherxyz/comfyui-art-venture | pyproject |
| `comfyui-custom-scripts` | https://github.com/pythongosssss/ComfyUI-Custom-Scripts | pyproject |
| `comfyui-dream-project` | https://github.com/alt-key-project/comfyui-dream-project | pyproject |
| `comfyui-easy-use` | https://github.com/yolain/ComfyUI-Easy-Use | pyproject |
| `comfyui-florence2` | https://github.com/kijai/ComfyUI-Florence2 | pyproject |
| `comfyui-frame-interpolation` | https://github.com/Fannovel16/ComfyUI-Frame-Interpolation | pyproject |
| `comfyui-hunyuan3dwrapper` | https://github.com/kijai/ComfyUI-Hunyuan3DWrapper | git |
| `comfyui-image-saver` | https://github.com/alexopus/ComfyUI-Image-Saver | pyproject |
| `comfyui-impact-pack` | https://github.com/ltdrdata/ComfyUI-Impact-Pack | pyproject |
| `comfyui-impact-subpack` | https://github.com/ltdrdata/ComfyUI-Impact-Subpack | pyproject |
| `comfyui-inspire-pack` | https://github.com/ltdrdata/ComfyUI-Inspire-Pack | pyproject |
| `comfyui-kjnodes` | https://github.com/kijai/ComfyUI-KJNodes | pyproject |
| `comfyui-krea2-controlnet` | https://github.com/facok/comfyui-krea2-controlnet | git |
| `comfyui-logicutils` | https://github.com/aria1th/ComfyUI-LogicUtils | pyproject |
| `comfyui-lora-manager` | https://github.com/willmiao/ComfyUI-Lora-Manager | pyproject |
| `comfyui-ltxvideolora` | https://github.com/dorpxam/ComfyUI-LTXVideoLoRA | pyproject |
| `comfyui-ollama` | https://github.com/stavsap/comfyui-ollama | git |
| `comfyui-scail2-infinity` | https://github.com/collbroGTR/comfyui-scail2-infinity | git |
| `comfyui-solricks` | https://github.com/SOLRICKS/comfyui-solricks | pyproject |
| `comfyui-videohelpersuite` | https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite | pyproject |
| `comfyui-wd14-tagger` | https://github.com/pythongosssss/ComfyUI-WD14-Tagger | pyproject |
| `comfyui_auto_caption` | https://github.com/Cyber-BlackCat/ComfyUI_Auto_Caption | pyproject |
| `comfyui_controlnet_aux` | https://github.com/Fannovel16/comfyui_controlnet_aux | pyproject |
| `comfyui_creaprompt` | https://github.com/tritant/ComfyUI_CreaPrompt | pyproject |
| `comfyui_essentials` | https://github.com/cubiq/ComfyUI_essentials | pyproject |
| `comfyui_ipadapter_plus` | https://github.com/cubiq/ComfyUI_IPAdapter_plus | pyproject |
| `comfyui_layerstyle` | https://github.com/chflame163/ComfyUI_LayerStyle | pyproject |
| `comfyui_nvidia_rtx_nodes` | https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI | pyproject |
| `comfyui_seamless_patten` | https://github.com/moyi7712/ComfyUI_Seamless_Patten | pyproject |
| `comfyui_ultimatesdupscale` | https://github.com/ssitu/ComfyUI_UltimateSDUpscale | pyproject |
| `crt-nodes` | https://github.com/PGCRT/CRT-Nodes | pyproject |
| `gguf` | https://github.com/calcuis/gguf | pyproject |
| `h3_dance_studio` | https://github.com/crypticnull/h3_dance_studio.git | git |
| `purgevram` | — | none |
| `reservedvram` | https://github.com/Windecay/ComfyUI-ReservedVRAM | pyproject |
| `rgthree-comfy` | https://github.com/rgthree/rgthree-comfy | pyproject |
| `save-image-extended-comfyui` | https://github.com/audioscavenger/save-image-extended-comfyui | pyproject |
| `seedvr2_videoupscaler` | https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler | pyproject |
| `wanblockswap` | https://github.com/orssorbit/ComfyUI-wanBlockswap | pyproject |
| `was-node-suite-comfyui` | https://github.com/ltdrdata/was-node-suite-comfyui/ | git |
| `was-ns` | https://github.com/ltdrdata/was-node-suite-comfyui | pyproject |
| `wavespeed` | https://github.com/chengzeyi/Comfy-WaveSpeed | pyproject |
| `whiterabbit` | https://github.com/Artificial-Sweetener/comfyui-WhiteRabbit | pyproject |
| `wo_joycaption_comfyui` | https://github.com/without-ordinary/wo_joycaption_comfyui | pyproject |

## Every model file

256 weight files, 1011.3 GB, grouped by kind-folder. Non-weight
sidecars (`.metadata.json`, `.civitai.info`, preview images) and files
under 1 MB are omitted; HuggingFace snapshot trees under `LLM/`,
`LLavacheckpoints/` and similar appear as their individual shards.

### `models/LLM`

| file | MB |
| --- | ---: |
| `Florence-2-SD3-Captioner/model.safetensors` | 1034 |
| `Florence-2-base/model.safetensors` | 442 |
| `Florence-2-base/pytorch_model.bin` | 443 |
| `Florence-2-large-PromptGen-v2.0/model.safetensors` | 3139 |
| `Florence-2-large/model.safetensors` | 1482 |
| `Florence-2-large/pytorch_model.bin` | 1484 |
| `Qwen-VL/Qwen3-VL-2B-Instruct/model.safetensors` | 4058 |
| `Qwen-VL/Qwen3-VL-4B-Instruct-FP8/model-00001-of-00002.safetensors` | 5118 |
| `Qwen-VL/Qwen3-VL-4B-Instruct-FP8/model-00002-of-00002.safetensors` | 624 |

### `models/LLavacheckpoints`

| file | MB |
| --- | ---: |
| `llama-joycaption-beta-one-hf-llava/model-00001-of-00004.safetensors` | 4660 |
| `llama-joycaption-beta-one-hf-llava/model-00002-of-00004.safetensors` | 4768 |
| `llama-joycaption-beta-one-hf-llava/model-00003-of-00004.safetensors` | 4688 |
| `llama-joycaption-beta-one-hf-llava/model-00004-of-00004.safetensors` | 2058 |

### `models/SEEDVR2`

| file | MB |
| --- | ---: |
| `ema_vae_fp16.safetensors` | 478 |

### `models/checkpoints`

| file | MB |
| --- | ---: |
| `illustriousXL_v01.safetensors` | 6617 |
| `ltx-2-19b-dev-fp8.safetensors` | 25824 |
| `ltx-2.3-22b-dev-fp8.safetensors` | 27795 |
| `ltx-2.3-22b-distilled-fp8.safetensors` | 28164 |
| `ltx2310eros_v12.safetensors` | 32739 |
| `sdpose_wholebody_fp16.safetensors` | 1828 |
| `sulphur_dev_bf16.safetensors` | 44002 |

### `models/diffusers`

| file | MB |
| --- | ---: |
| `Krea-2-Raw.safetensors` | 25066 |

### `models/diffusion_models`

| file | MB |
| --- | ---: |
| `DR34ML4Y_I2V_14B_HIGH_V2.safetensors` | 293 |
| `DR34ML4Y_I2V_14B_LOW_V2.safetensors` | 293 |
| `Krea-2-Raw.safetensors` | 25066 |
| `Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf` | 14693 |
| `Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf` | 14693 |
| `darkBeastINT8Convrot2_darkBeastKREA2FP8.safetensors` | 21175 |
| `hunyuan3d-dit-v2-0-turbo.safetensors` | 4702 |
| `krea2Dmergev3_int8ConvrotV3.safetensors` | 12867 |
| `krea2TurboOfficialComfy_krea2TurboBf16.safetensors` | 25066 |
| `krea2_turbo_int8_convrot.safetensors` | 12868 |
| `ltx-2.3-22b-dev_transformer_only_fp8_scaled.safetensors` | 22383 |
| `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` | 24058 |
| `ltx-2.3-22b-distilled-Q2_K.gguf` | 7893 |
| `lustifyNSFWCheckpoint_v10Krea2.safetensors` | 12226 |
| `moodyKrea2Mix_v30BF16.safetensors` | 24452 |
| `moodyProMix_zitV13.safetensors` | 11740 |
| `wan2.2_i2v_high_noise_14B_fp16.safetensors` | 27254 |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 13633 |
| `wan2.2_i2v_low_noise_14B_fp16.safetensors` | 27254 |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 13633 |
| `z_image_turbo-Q5_K_S.gguf` | 4949 |

### `models/facerestore_models`

| file | MB |
| --- | ---: |
| `GFPGANv1.3.pth` | 332 |
| `GFPGANv1.4.pth` | 332 |
| `GPEN-BFR-512.onnx` | 271 |
| `codeformer-v0.1.0.pth` | 359 |

### `models/frame_interpolation`

| file | MB |
| --- | ---: |
| `film_net_fp16.safetensors` | 66 |

### `models/insightface`

| file | MB |
| --- | ---: |
| `inswapper_128.onnx` | 529 |

### `models/latent_upscale_models`

| file | MB |
| --- | ---: |
| `ltx-2-spatial-upscaler-x2-1.0.safetensors` | 950 |
| `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` | 950 |
| `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | 950 |

### `models/loras`

| file | MB |
| --- | ---: |
| `AnimaMythD4rkL1nes.safetensors` | 66 |
| `Flux_2-Turbo-LoRA_comfyui.safetensors` | 2633 |
| `Krea/(Krea 2) Vision Vanguard 25 V2026.1.safetensors` | 218 |
| `Krea/Anatomy-Reveal-KREA2.safetensors` | 218 |
| `Krea/BeMyHero_-_EmmaX_epoch_9.safetensors` | 218 |
| `Krea/CRYPTIK_AMARIS_V1.safetensors` | 218 |
| `Krea/CRYPTIK_AMARIS_V1_000002500.safetensors` | 218 |
| `Krea/CRYPTIK_AMARIS_V1_000002750.safetensors` | 218 |
| `Krea/CRYPTIK_JULIA_V1.safetensors` | 218 |
| `Krea/CRYPTIK_JULIA_V1_000002500.safetensors` | 218 |
| `Krea/CRYPTIK_JULIA_V1_000002750.safetensors` | 218 |
| `Krea/CRYPTIK_KATJA_V1.safetensors` | 218 |
| `Krea/CRYPTIK_SAPPHIRE_V2_000003000.safetensors` | 218 |
| `Krea/CRYPTIK_SARIA_KREA2_V1_000002250.safetensors` | 218 |
| `Krea/CRYPTIK_SARIA_KREA2_V1_000003000.safetensors` | 218 |
| `Krea/CRYPTIK_SYNTHIA_V1.safetensors` | 218 |
| `Krea/CRYPTIK_SYNTHIA_V1_000002500.safetensors` | 218 |
| `Krea/CRYPTIK_SYNTHIA_V1_000002750.safetensors` | 218 |
| `Krea/CRYPTIK_VALENTA_V1.safetensors` | 218 |
| `Krea/CRYPTIK_VESNA_V3.safetensors` | 218 |
| `Krea/CRYPTIK_VESNA_V3_000002500.safetensors` | 218 |
| `Krea/CRYPTIK_VESNA_V3_000002750.safetensors` | 218 |
| `Krea/CRYPTIK_VESNA_V7.safetensors` | 218 |
| `Krea/CRYPTIK_VESS_KREA2_V1_2250.safetensors` | 218 |
| `Krea/CRYPTIK_VESS_KREA2_V1_2500.safetensors` | 218 |
| `Krea/CRYPTIK_VESS_KREA2_V1_2750.safetensors` | 218 |
| `Krea/CRYPTIK_VESS_KREA2_V1_3000.safetensors` | 218 |
| `Krea/CharacterDesign-KREA2_v1.safetensors` | 218 |
| `Krea/FaceDownAssUpKrea.safetensors` | 218 |
| `Krea/FrankFrazetta_Krea2.safetensors` | 218 |
| `Krea/Grimm_s_Fantasy_-_Krea2_epoch_10.safetensors` | 218 |
| `Krea/Grimm_s_realistic_painting_Krea2_epoch_10.safetensors` | 218 |
| `Krea/Krea2MythP0rtr4itStyle.safetensors` | 218 |
| `Krea/Krea2Weight_v3.safetensors` | 102 |
| `Krea/Krea2_Aberrant.safetensors` | 211 |
| `Krea/Krea2_HMNSFW_AIO.safetensors` | 218 |
| `Krea/Krea2_NSFW_V4.1_pre.safetensors` | 436 |
| `Krea/Krea_2_Innie_Rank_8_000003000.safetensors` | 55 |
| `Krea/Neoprene_Dress_V1-Krea2.safetensors` | 218 |
| `Krea/OOTN64_Krea2.safetensors` | 218 |
| `Krea/PornMaster_Detail_Slider_Krea2_V1_000000225.safetensors` | 27 |
| `Krea/Purple_Dreams_Kr2.safetensors` | 218 |
| `Krea/RLY-KREA2-thighgap-v1-trigger-thighgap.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-adeline-v1-trigger-rlyadeline.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-alessia-v1-trigger-rlyalessia.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-amelia-v1-trigger-rlyamelia.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-annika-v1-trigger-rlyannika.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-aspen-v11-trigger-rlyaspen.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-bristol-v1-trigger-rlybristol.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-chloe-v1-trigger-rlychloe.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-christine-v1-trigger-rlychristine.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-emersyn-v1-trigger-rlyemersyn.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-fallon-v1-trigger-rlyfallon.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-farrah-v1-trigger-rlyfarrah.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-genoveva-v1-trigger-rlygenoveva.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-helena-v1-trigger-rlyhelena.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-helga-v1-trigger-rlyhelga.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-irena-v1.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-jada-v1-trigger-rlyjada.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-jada-v11-trigger-rlyjada.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-jessi-v1-trigger-rlyjessi.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-leona-v1-trigger-rlyleona.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-rayven-v1-trigger-rlyrayven.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-rowan-v1-trigger-rlyrowan.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-shiloh-v1-trigger-rlyshiloh.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-skye-v1-trigger-rlyskye.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-solana-v1-trigger-rlysolana.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-soleil-v1-rlysoleil.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-taryn-v1-trigger-rlytaryn.safetensors` | 218 |
| `Krea/RLY-thot_shot-KREA2-xara-v1-trigger-rlyxara.safetensors` | 218 |
| `Krea/RLY-thot_shot-ZiB-ZiT-gabbie-v1-trigger-rlygabbie.safetensors` | 162 |
| `Krea/RLY-thot_shot-ZiB-ZiT-genoveva-v10-trigger-rlygenoveva.safetensors` | 162 |
| `Krea/RLY-thot_shot-ZiB-ZiT-luna-v1-trigger-rlyluna.safetensors` | 162 |
| `Krea/RLY-thot_shot-ZiB-ZiT-marley-v11-trigger-rlymarley.safetensors` | 162 |
| `Krea/RLY-thot_shot-ZiB-ZiT-soleil-v11-trigger-rlysoleil.safetensors` | 162 |
| `Krea/Sticker_KREA2_V1.safetensors` | 218 |
| `Krea/YFG-Fwshn-Krea2_1.8k-v2.safetensors` | 218 |
| `Krea/emma_krea.safetensors` | 218 |
| `Krea/ethnicity_krea2_loraholic.safetensors` | 7 |
| `Krea/fantasy_origin_epoch_10.safetensors` | 218 |
| `Krea/krea2_Enhancer.safetensors` | 224 |
| `Krea/krea2_better_pussy.safetensors` | 218 |
| `Krea/krea2_identity_edit_v1_2.safetensors` | 1744 |
| `Krea/krea2_papercraft_v1.safetensors` | 109 |
| `Krea/krea2_puckering_lips_v1_000002400.safetensors` | 109 |
| `Krea/lenovo_krea2.safetensors` | 109 |
| `Krea/lipbite_krea2_r1_3000.safetensors` | 218 |
| `Krea/pawg_krea2.safetensors` | 109 |
| `Krea/real_3d_krea2_loraholic.safetensors` | 7 |
| `Krea/realism_engine_krea2_v2.safetensors` | 1490 |
| `Krea/realism_engine_krea2_v3.1.safetensors` | 1490 |
| `Krea/seed_cryptik_amaris_v1.safetensors` | 55 |
| `Krea/seed_cryptik_julia_v1.safetensors` | 55 |
| `Krea/seed_cryptik_katja.safetensors` | 55 |
| `Krea/seed_cryptik_synthia_v1.safetensors` | 55 |
| `Krea/seed_cryptik_valenta_v1.safetensors` | 55 |
| `Krea/seed_cryptik_vesna_v3.safetensors` | 55 |
| `Krea/seed_cryptik_vesna_v4.safetensors` | 55 |
| `Krea/seed_cryptik_vesna_v5.safetensors` | 55 |
| `Krea/seed_cryptik_vesna_v6.safetensors` | 55 |
| `Krea/snofs_krea_v1.safetensors` | 1490 |
| `MiniMax_H3/H3_Mis_Insrt_v07.safetensors` | 296 |
| `MiniMax_H3/HMNSFW_AIO_V2.safetensors` | 296 |
| `MiniMax_H3/MysticXXX_MMH3-V1.safetensors` | 569 |
| `MiniMax_H3/h3_musubi_v4-000040.safetensors` | 284 |
| `MiniMax_H3/minimax_h3_turbo_4step_ckpt850.safetensors` | 744 |
| `MiniMax_H3/minimax_h3_turbo_4step_comfyui_pruned.safetensors` | 592 |
| `MiniMax_H3/minimax_h3_turbo_4step_ema_ckpt850.safetensors` | 744 |
| `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | 810 |
| `SDXL/8.0-sprite pixel art style by skormino.safetensors` | 218 |
| `V3_flux_klein.safetensors` | 158 |
| `ZiT/Mystic-XXX-ZIT-V7.safetensors` | 198 |
| `ZiT/NSFW_master_ZIT_000017532.safetensors` | 593 |
| `ZiT/PornMaster_NSFW_ZIT_V1.safetensors` | 337 |
| `ZiT/ZiTMythG0thicL1nes.safetensors` | 162 |
| `ZiT/cadence_zimage_turbo_lora_v1.safetensors` | 81 |
| `ZiT/carly_zimage_turbo_lora_v1.safetensors` | 81 |
| `ZiT/pixel_art_style_z_image_turbo.safetensors` | 162 |
| `ZiT/zit_sda_v1.safetensors` | 162 |
| `depth-control-lora.safetensors` | 822 |
| `dgz.safetensors` | 162 |
| `ltx/DR34ML4Y_LTXXX_V2.safetensors` | 1851 |
| `ltx/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors` | 624 |
| `ltx/LTX2.3_Crisp_Enhance.safetensors` | 673 |
| `ltx/LTX2.3_Physics_V2_000002000.safetensors` | 1286 |
| `ltx/LTX2.3_reasoning_Sulphur-2_I2V_V4.safetensors` | 768 |
| `ltx/Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors` | 528 |
| `ltx/SexGod_FingeringDildo_LTX23_v1.safetensors` | 2571 |
| `ltx/SexGod_LTX23_DoggyStyle_v2_5.safetensors` | 2571 |
| `ltx/bounceV2_5_LTX23_I2V.comfy.safetensors` | 1382 |
| `ltx/ltx-2-19b-distilled-lora-384.safetensors` | 7319 |
| `ltx/ltx-2-19b-ic-lora-detailer.safetensors` | 2496 |
| `ltx/ltx-2-19b-lora-camera-control-dolly-left.safetensors` | 312 |
| `ltx/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors` | 631 |
| `ltx/ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | 7253 |
| `ltx/ltx-2.3-22b-distilled-lora-384.safetensors` | 7253 |
| `ltx/ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors` | 2467 |
| `ltx/realisdance_ltx2.3_ic-lora_step_02000.safetensors` | 312 |
| `seed_cryptik_vesna_v7.safetensors` | 55 |
| `wan/SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors` | 1170 |
| `wan/SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors` | 1170 |
| `wan/Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors` | 585 |
| `wan/Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors` | 585 |
| `wan/Wan2.2-T2V-A14B-4steps-lora-250928-low_noise_model.safetensors` | 1170 |
| `wan/stock_photography_wan22_LOW_v1.safetensors` | 293 |
| `wan/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 1170 |
| `wan/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 1170 |
| `wan/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` | 1170 |
| `wan/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` | 1170 |
| `wan/wan22.r3v3rs3_c0wg1rl-14b-High-i2v_e70.safetensors` | 585 |
| `wan/wan22.r3v3rs3_c0wg1rl-14b-High-t2v_e120.safetensors` | 585 |
| `wan/wan22.r3v3rs3_c0wg1rl-14b-Low-i2v_e70.safetensors` | 585 |
| `wan/wan22.r3v3rs3_c0wg1rl-14b-Low-t2v_e120.safetensors` | 585 |

### `models/text_encoders`

| file | MB |
| --- | ---: |
| `!krea2_text_encoder.safetensors` | 8465 |
| `Qwen3-4B.i1-Q5_K_S.gguf` | 2693 |
| `gemma-3-12b-it-Q2_K.gguf` | 4547 |
| `gemma312BAbliterated_v10aExperimental.safetensors` | 14324 |
| `gemma4_e4b_it_fp8_scaled.safetensors` | 8638 |
| `gemma_3_12B_it_fp4_mixed.safetensors` | 9010 |
| `gemma_3_12B_it_fp8_scaled.safetensors` | 12594 |
| `ltx-2.3_text_projection_bf16.safetensors` | 2205 |
| `mistral_3_small_flux2_bf16.safetensors` | 33936 |
| `nsfw_wan_umt5-xxl_fp8_scaled.safetensors` | 6424 |
| `qwen3.5_4b_bf16.safetensors` | 8888 |
| `qwen3VL4BAbliteratedComfyui_v10.safetensors` | 8465 |
| `qwen3vl_4b_fp8_scaled.safetensors` | 5000 |
| `qwen_0.6b_ace15.safetensors` | 1136 |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | 8950 |
| `qwen_3_4b.safetensors` | 7672 |
| `qwen_4b_ace15.safetensors` | 7991 |
| `umt5_xxl_fp16.safetensors` | 10840 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6424 |

### `models/ultralytics`

| file | MB |
| --- | ---: |
| `bbox/face_yolov8m.pt` | 50 |
| `segm/face_yolov8m-seg_60.pt` | 52 |

### `models/unet`

| file | MB |
| --- | ---: |
| `LTX-2.3-distilled-Q4_K_S.gguf` | 15932 |
| `acestep_v1.5_turbo.safetensors` | 4566 |
| `acestep_v1.5_xl_turbo_bf16.safetensors` | 9513 |
| `flux2_dev_fp8mixed.safetensors` | 33813 |
| `ltx2310eros_v12.safetensors` | 32739 |
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | 19484 |
| `qwen_image_fp8_e4m3fn.safetensors` | 19484 |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 13633 |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 13633 |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | 13632 |
| `wan2.2_t2v_low_noise_14B_Q2_K.gguf` | 5054 |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | 13632 |
| `wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2Q8H.gguf` | 14693 |
| `z_image_turbo_bf16.safetensors` | 11740 |

### `models/upscale_models`

| file | MB |
| --- | ---: |
| `4x-UltraSharp.pth` | 64 |
| `4xNomosWebPhoto_RealPLKSR.pth` | 28 |
| `4x_NMKD-Superscale-SP_178000_G.pth` | 64 |
| `4x_foolhardy_Remacri.safetensors` | 64 |
| `RealESRGAN_x2.pth` | 64 |
| `RealESRGAN_x4plus.safetensors` | 64 |

### `models/vae`

| file | MB |
| --- | ---: |
| `!krea2_vae.safetensors` | 242 |
| `LTX23_audio_vae_bf16.safetensors` | 348 |
| `LTX23_video_vae_bf16.safetensors` | 1385 |
| `ace_1.5_vae.safetensors` | 322 |
| `ae.safetensors` | 320 |
| `full_encoder_small_decoder.safetensors` | 238 |
| `minimax_h3_video_vae_int8_convrot.safetensors` | 3025 |
| `qwen_image_vae.safetensors` | 242 |
| `taeltx2_3.safetensors` | 22 |
| `wan_2.1_vae.safetensors` | 242 |

## The shared root — `AppData\Local\Comfy-Desktop\ComfyUI-Shared`

The Desktop app's auto-download store, and the root the first pass of
this document missed. 64 files, **244.2 GB**, of which 177.4 GB is
`diffusion_models`. It is resolved BEFORE the Documents root.

Weights only (>1 MB); `.metadata.json` sidecars and the HuggingFace
cache tree under `LLM/` are omitted.

### `<shared>/models/LLM`

| file | MB |
| --- | ---: |
| `Qwen-VL/Qwen3-VL-4B-Instruct-FP8/model-00001-of-00002.safetensors` | 5118 |
| `Qwen-VL/Qwen3-VL-4B-Instruct-FP8/model-00002-of-00002.safetensors` | 624 |

### `<shared>/models/background_removal`

| file | MB |
| --- | ---: |
| `birefnet.safetensors` | 424 |

### `<shared>/models/checkpoints`

| file | MB |
| --- | ---: |
| `hunyuan3d-dit-v2-mv_fp16.safetensors` | 4700 |
| `sam3.1_multiplex_fp16.safetensors` | 1665 |
| `sd_xl_base_1.0.safetensors` | 6617 |
| `sd_xl_refiner_1.0.safetensors` | 5795 |

### `<shared>/models/clip_vision`

| file | MB |
| --- | ---: |
| `clip_vision_h.safetensors` | 1206 |

### `<shared>/models/diffusion_models`

| file | MB |
| --- | ---: |
| `boogu_image_edit_int8_convrot.safetensors` | 10844 |
| `flux1-dev-kontext_fp8_scaled.safetensors` | 11353 |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 19999 |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19999 |
| `qwen_image_edit_2511_bf16.safetensors` | 38968 |
| `qwen_image_edit_2511_int8_convrot.safetensors` | 19549 |
| `wan2.1_14B_SCAIL_2_fp16.safetensors` | 31275 |
| `wan2.2_bernini_r_high_noise_fp8_scaled.safetensors` | 14853 |
| `wan2.2_bernini_r_low_noise_fp8_scaled.safetensors` | 14853 |

### `<shared>/models/loras`

| file | MB |
| --- | ---: |
| `QWEN_EDIT_ACTION_V1.safetensors` | 281 |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 810 |
| `lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` | 704 |
| `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors` | 601 |
| `qwen-image-edit-2511-multiple-angles-lora.safetensors` | 281 |
| `wan2.1_SCAIL_2_DPO_lora_bf16.safetensors` | 1170 |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 1170 |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 1170 |

### `<shared>/models/text_encoders`

| file | MB |
| --- | ---: |
| `clip_l.safetensors` | 235 |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14960 |
| `qwen3vl_8b_fp8_scaled.safetensors` | 10098 |
| `t5xxl_fp8_e4m3fn_scaled.safetensors` | 4918 |

### `<shared>/models/vae`

| file | MB |
| --- | ---: |
| `Wan2_1_VAE_bf16.safetensors` | 242 |
| `minimax_h3_audio_vae_fp32.safetensors` | 577 |
| `minimax_h3_video_vae_fp16.safetensors` | 4967 |
