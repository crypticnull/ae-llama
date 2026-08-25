/*
 * version.js — single source of truth for the panel version and the update
 * channel. Bump VERSION together with ExtensionBundleVersion in
 * CSXS/manifest.xml when cutting a release (scripts/package-zxp.ps1 checks
 * they match).
 */
(function (global) {
  "use strict";

  global.AELL = {
    VERSION: "0.9.17",

    // Release channel label, shown wherever the version is displayed.
    // Purely cosmetic — update comparisons use the numeric VERSION only.
    CHANNEL: "alpha",

    // Hosted JSON the panel polls for updates (see update.json in the repo
    // root for the format). Host it anywhere stable you control — your own
    // site, an S3 bucket, or a public GitHub repo's raw URL. For aescripts
    // distribution, point buyers at your aescripts product page via the
    // manifest's panelUrl.
    // Served from the PUBLIC updates repo, which CI publishes into on every
    // main push / v* tag — end users need no git, no account, no auth.
    // One-time setup: create the public repo (with a README) and add an
    // UPDATES_REPO_TOKEN secret here; see README "Distributing & updating".
    UPDATE_MANIFEST_URL:
      "https://raw.githubusercontent.com/crypticnull/ae-llama-updates/main/update.json",

    // Curated GGUF models by VRAM tier. The hosted update.json can override
    // this list via a "modelCatalog" field without shipping a new panel.
    // minVramGB is the smallest GPU the model runs comfortably on at the
    // default 8k context; cpuDefault marks the pick for no-NVIDIA machines.
    MODEL_CATALOG: [
      {
        name: "Qwen2.5-32B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 32B — best quality",
        url: "https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF/resolve/main/Qwen2.5-32B-Instruct-Q4_K_M.gguf",
        sizeMB: 19900, minVramGB: 22
      },
      {
        name: "Qwen2.5-14B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 14B — great quality",
        url: "https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf",
        sizeMB: 9000, minVramGB: 11
      },
      {
        name: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 7B — solid default",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        sizeMB: 4700, minVramGB: 7, cpuDefault: true
      },
      {
        name: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        label: "Llama 3.2 3B — light",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        sizeMB: 2100, minVramGB: 4
      }
    ],

    // Curated GENERATION models by VRAM tier (docs/COMFY_TIERS_PLAN.md).
    // Same feed override as the chat catalog: update.json's
    // "comfyCatalog" replaces this list without a panel release. Every
    // VRAM figure here is PROVISIONAL (measured: false) until the local
    // session measures it on real hardware — nvidia-smi deltas during
    // actual generations flip the flag entry by entry. Entries with an
    // empty urls list are visible in the recommendation but not yet
    // downloadable; their files get pinned via the feed (P4/P5).
    // urls[].dir is the ComfyUI models/ subfolder the file lands in.
    COMFY_CATALOG: [
      {
        name: "sd15",
        label: "Stable Diffusion 1.5",
        kind: "image", sizeMB: 2132, minVramGB: 4, measured: false,
        urls: [{
          url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
          sizeMB: 2132, dir: "checkpoints"
        }]
      },
      {
        name: "sdxl",
        label: "SDXL",
        kind: "image", sizeMB: 6939, minVramGB: 6, measured: false,
        slowBelowGB: 8,
        slowNote: "under 8 GB this offloads: typically 2-4 minutes per " +
                  "image on 6 GB cards",
        urls: [{
          url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
          sizeMB: 6939, dir: "checkpoints"
        }]
      },
      {
        name: "krea2",
        label: "Krea 2 (turbo)",
        kind: "image", sizeMB: null, minVramGB: 12, measured: false,
        workflowTemplate: "AE_LLAMA_KREA2_V1",
        files: ["krea2_turbo_int8_convrot.safetensors",
                "qwen3vl_4b_fp8_scaled.safetensors",
                "qwen_image_vae.safetensors"],
        urls: [],
        note: "download links ship via the update feed once pinned; " +
              "existing files register by exact name"
      },
      {
        name: "ltx-small",
        label: "LTX video (small)",
        kind: "video", sizeMB: null, minVramGB: 6, measured: false,
        experimental: true,
        urls: [],
        note: "experimental short clips for 6 GB cards; files pinned " +
              "via the update feed after real-hardware timing"
      },
      {
        name: "wan22-5b",
        label: "Wan 2.2 5B",
        kind: "video", sizeMB: 17000, minVramGB: 8, measured: false,
        urls: [{
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
          sizeMB: 9700, dir: "diffusion_models"
        }, {
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
          sizeMB: 6400, dir: "text_encoders"
        }, {
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors",
          sizeMB: 1400, dir: "vae"
        }]
      },
      {
        name: "minimax-h3",
        label: "MiniMax H3 (RTX 50 series)",
        kind: "video", sizeMB: 40543, minVramGB: 32, measured: false,
        requiresBlackwell: true,
        workflowTemplate: "AE_LLAMA_H3_I2V_V1",
        urls: [{
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          sizeMB: 19999, dir: "diffusion_models"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
          sizeMB: 14960, dir: "text_encoders"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
          sizeMB: 4967, dir: "vae"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
          sizeMB: 577, dir: "vae"
        }]
      },
      {
        name: "minimax-h3-int8",
        label: "MiniMax H3 (32 GB, non-Blackwell encoder)",
        kind: "video", sizeMB: 51427, minVramGB: 32, measured: false,
        note: "the int8 text encoder is 11 GB larger than the " +
              "Blackwell-only nvfp4 one; whether H3 is usable here at " +
              "all is a P4 measurement",
        urls: [{
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
          sizeMB: 19999, dir: "diffusion_models"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
          sizeMB: 25884, dir: "text_encoders"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
          sizeMB: 4967, dir: "vae"
        }, {
          url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
          sizeMB: 577, dir: "vae"
        }]
      }
    ]
  };

})(window);
