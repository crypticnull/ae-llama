/*
 * version.js — single source of truth for the panel version and the update
 * channel. Bump VERSION together with ExtensionBundleVersion in
 * CSXS/manifest.xml when cutting a release (scripts/package-zxp.ps1 checks
 * they match).
 */
(function (global) {
  "use strict";

  global.AELL = {
    VERSION: "0.9.2",

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
    ]
  };

})(window);
