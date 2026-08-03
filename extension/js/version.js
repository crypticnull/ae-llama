/*
 * version.js — single source of truth for the panel version and the update
 * channel. Bump VERSION together with ExtensionBundleVersion in
 * CSXS/manifest.xml when cutting a release (scripts/package-zxp.ps1 checks
 * they match).
 */
(function (global) {
  "use strict";

  global.AELL = {
    VERSION: "0.3.0",

    // Hosted JSON the panel polls for updates (see update.json in the repo
    // root for the format). Host it anywhere stable you control — your own
    // site, an S3 bucket, or a public GitHub repo's raw URL. For aescripts
    // distribution, point buyers at your aescripts product page via the
    // manifest's panelUrl.
    UPDATE_MANIFEST_URL:
      "https://raw.githubusercontent.com/crypticnull/cptk_claude/main/update.json",

    // Used when the update manifest is unreachable and the user asks for a
    // starter model anyway.
    FALLBACK_STARTER_MODEL: {
      name: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
      url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
      sizeMB: 4700
    }
  };

})(window);
