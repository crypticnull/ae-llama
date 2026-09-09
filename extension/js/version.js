/*
 * version.js — single source of truth for the panel version and the update
 * channel. Bump VERSION together with ExtensionBundleVersion in
 * CSXS/manifest.xml when cutting a release (scripts/package-zxp.ps1 checks
 * they match).
 */
(function (global) {
  "use strict";

  global.AELL = {
    VERSION: "0.12.16",

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
    //
    // EVERY sizeMB IN THIS FILE IS MEBIBYTES (bytes / 1048576), the unit
    // the rest of the panel counts in: nvidia-smi reports MiB, tools.js
    // modelFileMB divides by 1048576, planHandoff multiplies vramGB by
    // 1024, and Windows itself labels GiB "GB". These four were written
    // from training in DECIMAL MB and so overstated every file by ~5%
    // (Llama 3.2 3B by 9%); measured against HuggingFace's x-linked-size
    // 2026-08-30 by scripts/catalog-probe.js, which re-checks them.
    MODEL_CATALOG: [
      {
        name: "Qwen2.5-32B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 32B — best quality",
        url: "https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF/resolve/main/Qwen2.5-32B-Instruct-Q4_K_M.gguf",
        sizeMB: 18932, minVramGB: 22
      },
      {
        name: "Qwen2.5-14B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 14B — great quality",
        url: "https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf",
        sizeMB: 8572, minVramGB: 11
      },
      {
        name: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        label: "Qwen2.5 7B — solid default",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        sizeMB: 4466, minVramGB: 7, cpuDefault: true
      },
      {
        name: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        label: "Llama 3.2 3B — light",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        sizeMB: 1926, minVramGB: 4
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
    //
    // Sizes are MiB (see MODEL_CATALOG above) and an entry's sizeMB is the
    // SUM of its urls[] — it is the only number a user sees before agreeing
    // to the download, so a total that disagrees with its own parts is a
    // bug. All twelve URLs were alive on 2026-08-30 and every size below is
    // that day's measurement (x-linked-size, or the file already on this
    // machine); `measured` is about the VRAM figure, which is measured
    // for every entry that ships a graph (krea2, sd15, sdxl, wan22-5b,
    // minimax-h3 and minimax-h3-int8, all measured or re-measured on the
    // managed backend) and still a guess only for ltx-small, the one
    // entry that ships none because it has no weights to ship.
    // An entry with measured: true carries the reading that earned it --
    // measuredVramMB (nvidia-smi peak minus an established idle floor),
    // measuredSeconds, measuredAt (the SIZE it was measured at, which is
    // half the number) and measuredOn (the card). minVramGB must cover
    // measuredVramMB or the entry is offered to a card that cannot hold
    // it; tests/test-model-catalog.js enforces exactly that.
    //
    // A VIDEO entry needs one more thing, because for a clip the frame is
    // only half the size: the latent is frames x pixels, so the same graph
    // at two lengths is two different jobs on the card. It carries
    // measuredClipSeconds (the length the reading was taken at) and
    // authoredClipSeconds (the length the TEMPLATE renders when the user
    // names none), and when those differ an authoredNote saying so -- the
    // catalog must not quote a two-second decomposition as if it were the
    // job the buyer is handed. The test reads the authored length out of
    // the shipped API template rather than trusting the number here.
    COMFY_CATALOG: [
      {
        name: "sd15",
        label: "Stable Diffusion 1.5",
        // MEASURED 2026-09-09 on an RTX 5090 by scripts/catalog-vram-probe.js,
        // running the shipped AE_LLAMA_SD15_T2I_V1 through the panel's own
        // comfy_generate on the MANAGED backend (the one a buyer installs:
        // ComfyUI portable, python 3.13.14, torch 2.13.0+cu130), nvidia-smi
        // streaming at 250 ms. Two runs at the template's authored 512x512,
        // seed 12345: 2112 MiB in 4 s COLD (the checkpoint still coming off
        // disk) and 2656 MiB in 2 s warm. The larger delta is the figure
        // here and the cold wall clock is the seconds, because a buyer's
        // first generation is the cold one.
        //
        // minVramGB stays 4: the delta is 2656 MiB against a 4096 MiB card,
        // and the weights it must hold are 2034 MiB of that. This is the
        // one catalog entry whose gate the measurement did not move.
        kind: "image", sizeMB: 2034, minVramGB: 4, measured: true,
        measuredVramMB: 2656, measuredSeconds: 4,
        measuredAt: "512x512 (the template's authored latent), seed 12345",
        measuredOn: "NVIDIA GeForce RTX 5090, managed ComfyUI backend " +
                    "(torch 2.13.0+cu130), 2026-09-09",
        workflowTemplate: "AE_LLAMA_SD15_T2I_V1",
        urls: [{
          url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
          sizeMB: 2034, dir: "checkpoints"
        }]
      },
      {
        name: "sdxl",
        label: "SDXL",
        // MEASURED 2026-09-09 on an RTX 5090 by scripts/catalog-vram-probe.js,
        // running the shipped AE_LLAMA_SDXL_T2I_V1 through the panel's own
        // comfy_generate on the MANAGED backend (ComfyUI portable, python
        // 3.13.14, torch 2.13.0+cu130), nvidia-smi streaming at 250 ms. Two
        // runs at the template's authored 1024x1024, seed 12345: 9472 MiB in
        // 6 s COLD (the checkpoint still coming off disk) and 7072 MiB in
        // 4 s warm. The larger delta is the figure here and the cold wall
        // clock is the seconds, because a buyer's first generation is the
        // cold one.
        //
        // minVramGB was 6 and the measurement disproves it in two independent
        // ways: the cold job costs 9.3 GiB, and the checkpoint alone is
        // 6617 MiB of resident weights on a card that would have 6144. So a
        // 6 GB card cannot hold this, and 0.10.14 measured what this backend
        // does when a job outgrows the card -- it does not OOM, it GRINDS. 12
        // is the smallest standard card that holds the cold delta with room
        // left for the desktop. Same class as krea2's 12 -> 24.
        //
        // slowBelowGB/slowNote ("under 8 GB this offloads, 2-4 minutes per
        // image on 6 GB cards") were REMOVED rather than re-tuned. They warn
        // about 6-8 GB cards, which the gate above now refuses outright, so
        // the warning could never fire; and nothing measured says a 12 GB
        // card offloads. If one turns out to, it comes back with a number.
        kind: "image", sizeMB: 6617, minVramGB: 12, measured: true,
        measuredVramMB: 9472, measuredSeconds: 6,
        measuredAt: "1024x1024 (the template's authored latent), seed 12345",
        measuredOn: "NVIDIA GeForce RTX 5090, managed ComfyUI backend " +
                    "(torch 2.13.0+cu130), 2026-09-09",
        workflowTemplate: "AE_LLAMA_SDXL_T2I_V1",
        urls: [{
          url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
          sizeMB: 6617, dir: "checkpoints"
        }]
      },
      {
        name: "krea2",
        label: "Krea 2 (turbo)",
        // RE-MEASURED 2026-09-09 on an RTX 5090 (32 607 MiB) by
        // scripts/catalog-vram-probe.js, because the graph this entry
        // ships CHANGED: AE_LLAMA_KREA2_V1 (the owner's authored two-pass
        // graph, four custom node packs) left the bundle and
        // AE_LLAMA_KREA2_T2I_V1 (core-only, one pass) replaced it --
        // WORKPLAN 18 P8. A measured block that describes a graph the
        // panel no longer ships is worse than none, so the reading was
        // retaken on the MANAGED backend a buyer gets (ComfyUI 0.34.0,
        // port 8288), nvidia-smi streaming at 250 ms, /free before each
        // run so the weights come back cold. Two runs at one seed:
        // 18 848 and 18 560 MiB over an established idle floor, 8 s each,
        // 1920x1080 out. The higher is published, as krea2's own earlier
        // reading and H3's and Wan's were.
        //
        // The previous reading was 24 160 MiB / 32 s at 3072x1728 -- the
        // authored graph's second pass, a 1.6x latent upscale re-sampled
        // at denoise 0.25, which the basic does not do. So the basic is
        // 5.3 GiB and 24 s cheaper for one pass at 1920x1080.
        //
        // minVramGB stays 24 and the smaller reading does NOT lower it.
        // The three weights are 18 109 MiB and all three are resident, so
        // the floor here is the weights, not the frame: the next standard
        // card down is 16 GB, which cannot hold 18.4 GiB of delta, and
        // 0.10.14 measured what this backend does when a job outgrows the
        // card -- it does not OOM, it GRINDS.
        kind: "image", sizeMB: null, minVramGB: 24, measured: true,
        measuredVramMB: 18848, measuredSeconds: 8,
        measuredAt: "1920x1080 (the template's authored latent), seed 12345",
        measuredOn: "NVIDIA GeForce RTX 5090, ComfyUI 0.34.0 (managed), " +
                    "2026-09-09",
        workflowTemplate: "AE_LLAMA_KREA2_T2I_V1",
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
        // MEASURED 2026-09-09 on an RTX 5090 (32 607 MiB) by
        // scripts/catalog-vram-probe.js, running the SHIPPED
        // AE_LLAMA_WAN22_5B_T2V_V1 through the panel's own comfy_generate
        // on the MANAGED backend a buyer gets (ComfyUI 0.34.0, port 8288),
        // with nvidia-smi streaming at 250 ms. Two runs at one seed:
        // 26 187 and 24 576 MiB over an established idle floor, 127 s each,
        // 1280x704 x 121 frames out. The higher is published, as krea2's
        // and H3's were.
        //
        // minVramGB was 8, and 8 is not off by a little. A THIRD run at
        // 704x480 -- a third of the pixels -- still cost 21 536 MiB in
        // 38 s, which is the number that settles it: the floor here is the
        // WEIGHTS, not the frame. This graph holds all three files
        // resident (17 304 MiB) and no width, height or length the panel
        // can inject brings that under a 24 GB card, let alone an 8 GB
        // one. 0.10.14 measured what this backend does when a job outgrows
        // the card -- it does not OOM, it GRINDS -- so an 8 GB buyer was
        // being offered this as their VIDEO DEFAULT and would have got
        // minutes per frame with no warning.
        //
        // 32 rather than 24: the authored job's own delta is 25.6 GiB, so
        // a 24 GB card cannot hold it even before its desktop.
        // See WORKPLAN 18 P7 and 18 P6a. The consequence for cards under
        // 32 GB is a PRODUCT question, filed as 18 P7a, not a catalog one.
        kind: "video", sizeMB: 17304, minVramGB: 32, measured: true,
        measuredVramMB: 26187, measuredSeconds: 127,
        measuredAt: "1280x704 x 121 frames (the template's authored " +
                    "default, 5.04 s at 24 fps), seed 12345",
        // Unlike minimax-h3, the reading IS the authored job: 121 frames is
        // the template's own default and 127 s is what a buyer waits, so
        // these two are equal and the row needs no authoredNote.
        measuredClipSeconds: 5.04,
        authoredClipSeconds: 5.04,
        measuredOn: "NVIDIA GeForce RTX 5090, ComfyUI 0.34.0 (managed), " +
                    "2026-09-09",
        workflowTemplate: "AE_LLAMA_WAN22_5B_T2V_V1",
        urls: [{
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
          sizeMB: 9536, dir: "diffusion_models"
        }, {
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
          sizeMB: 6424, dir: "text_encoders"
        }, {
          url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors",
          sizeMB: 1344, dir: "vae"
        }]
      },
      {
        name: "minimax-h3",
        label: "MiniMax H3 (RTX 50 series)",
        // RE-MEASURED 2026-09-09 on an RTX 5090 (32 607 MiB) by
        // scripts/catalog-vram-probe.js, running the SHIPPED
        // AE_LLAMA_H3_T2V_V1 through the panel's own comfy_generate on the
        // MANAGED backend a buyer gets (ComfyUI 0.34.0, port 8288), with
        // nvidia-smi streaming at 250 ms. Two runs at one seed: delta
        // 26 080 MiB and 253 s BOTH times, peaks 2 MiB apart (29 646 /
        // 29 648) over idle floors of 3566 / 3568 — the most repeatable
        // reading in this catalog. Re-measured, and not optionally:
        // WORKPLAN §18 P9 replaced this entry's graph with a core-only
        // basic, and the previous reading (26 969 MiB / 80 s) was taken on
        // the owner's authored AE_LLAMA_H3_I2V_V1, which no longer ships.
        // A number kept across a change of graph prices a job the buyer is
        // not given — the defect §18 P8 found on krea2 and the reason
        // test-model-catalog.js now reads the size and the length out of
        // the entry's OWN template.
        //
        // measuredClipSeconds and authoredClipSeconds are EQUAL here, and
        // that is the whole improvement. The authored graph asked for 15 s
        // (362 frames) and was still sampling at 901 s on this card when
        // the probe cancelled it, so the catalog could only ever hold a 2 s
        // decomposition of a job nobody would wait for. The basic is
        // authored at 124 frames — the frame count /object_info gives the
        // node as its own default and the bottom of the range its tooltip
        // calls trained (~124-362) — so the reading IS the shipped job:
        // 5.17 s of video in 4m13s.
        //
        // The gate stays 32 GB and the headroom is thin on purpose: peak
        // 29 646 MiB of a 32 607 MiB card, over an idle floor of 3566, and
        // the four weights are 40 503 MiB on disk. This entry is also
        // Blackwell-only (the nvfp4 encoder), so 32 GB is the card it is
        // offered to either way.
        kind: "video", sizeMB: 40503, minVramGB: 32, measured: true,
        measuredVramMB: 26080, measuredSeconds: 253,
        measuredAt: "1344x768 (0.98 MP, the template's authored frame), " +
                    "5.17 s / 124 frames, seed 12345",
        measuredClipSeconds: 5.17,
        authoredClipSeconds: 5.17,
        measuredOn: "NVIDIA GeForce RTX 5090, ComfyUI 0.34.0 (managed), " +
                    "2026-09-09",
        requiresBlackwell: true,
        workflowTemplate: "AE_LLAMA_H3_T2V_V1",
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
        // MEASURED 2026-09-09 on an RTX 5090 (32 607 MiB) by
        // scripts/catalog-vram-probe.js, running the shipped
        // AE_LLAMA_H3_INT8_T2V_V1 through the panel's own comfy_generate
        // on the MANAGED backend a buyer gets (ComfyUI 0.34.0, port
        // 8288), nvidia-smi streaming at 250 ms, /free before each run.
        // Two runs at one seed: delta 26 048 MiB BOTH times, peaks 1 MiB
        // apart (29 642 / 29 643) over idle floors of 3594 / 3595, 257
        // and 259 s, 1344x768 x 124 frames out.
        //
        // THE READING IS THE SIBLING'S. minimax-h3 measured 26 080 MiB /
        // 253 s on the same card at the same size and length, so this
        // encoder costs 32 MiB and 6 s MORE — inside the noise of two
        // runs. That is not what the old note here predicted ("the int8
        // text encoder is 11 GB larger... whether H3 is usable here at
        // all is a P4 measurement"), and the reason is worth keeping:
        // the 10 924 MiB the encoders differ by is a DOWNLOAD difference,
        // not a VRAM one. ComfyUI evicts the text encoder before it
        // samples, so the peak on this graph is set by the diffusion
        // model and the two VAEs — which are the same four files here as
        // in the sibling. Pricing this entry as "11 GB heavier" off
        // sizeMB would have been wrong in the only place it matters.
        //
        // minVramGB stays 32, unchanged from the guess, for the sibling's
        // reasons: peak 29 642 of 32 607 MiB is thin, and the entry
        // exists for cards that cannot load the Blackwell-native nvfp4
        // encoder at all — which is a format question, not a size one, so
        // it does not soften the floor.
        kind: "video", sizeMB: 51427, minVramGB: 32, measured: true,
        measuredVramMB: 26048, measuredSeconds: 259,
        measuredAt: "1344x768 (0.98 MP, the template's authored frame), " +
                    "5.17 s / 124 frames, seed 12345",
        // As with the nvfp4 sibling, the reading IS the authored job:
        // 124 frames is the template's own literal length, so these are
        // equal and the row needs no authoredNote.
        measuredClipSeconds: 5.17,
        authoredClipSeconds: 5.17,
        measuredOn: "NVIDIA GeForce RTX 5090, ComfyUI 0.34.0 (managed), " +
                    "2026-09-09",
        note: "the same four-file H3 stack as minimax-h3 with the int8 " +
              "text encoder in place of the Blackwell-only nvfp4 one: " +
              "10 924 MiB more to download, measured the same VRAM and " +
              "the same wall clock to render",
        workflowTemplate: "AE_LLAMA_H3_INT8_T2V_V1",
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
