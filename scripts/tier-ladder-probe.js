/*
 * tier-ladder-probe.js — WORKPLAN item 7, bullet "Tier impersonation ladder".
 *
 * `vramOverrideGB` exists so one card can BE every card. Bullet 1 drove two
 * budgets through a real generation (no override -> concurrent, 8 GB ->
 * handoff) and chat-probe step 14 drove one refusal. This walks the whole
 * ladder — 4/6/8/12/16/24/32 plus the card's own number — and asks the three
 * questions the workplan asks, of the SHIPPED code, with the REAL machine
 * underneath it:
 *
 *   1. does the budget produce the matching tier line?      (tiers.js)
 *   2. do the catalog picks match that tier's promise?       (setup.js)
 *   3. is the handoff (or refusal) consistent with the tier? (tools.js)
 *
 * Nothing here is arithmetic the probe supplies. The GPU is nvidia-smi's,
 * the chat model is the one in the user's real settings measured off disk,
 * and every generation bill is the weights this machine actually holds,
 * summed by the panel's own genNeedMBFor. What the probe adds is the
 * INVARIANTS — the sentences that must hold at every rung — and a table.
 *
 *   node scripts/tier-ladder-probe.js
 *   node scripts/tier-ladder-probe.js --budgets 4,8,32
 *   node scripts/tier-ladder-probe.js --no-server    # decisions with no chat
 *
 * By default it starts a real llama-server (the decision is only interesting
 * with a chat model holding VRAM) and stops it again. It runs NO generation
 * and touches neither ComfyUI nor After Effects: the executed halves are
 * bullet 1's and step 14's, already in the log. Writes a markdown transcript
 * to logs/ and exits 0 only if every invariant held.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
}
const OPT = {
  budgets: String(argValue("--budgets", "4,6,8,12,16,24,32"))
    .split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0),
  model: argValue("--model", null),
  noServer: argv.indexOf("--no-server") !== -1,
  reuseServer: argv.indexOf("--reuse-server") !== -1
};

// --------------------------------------------------------- the panel, in Node

const storage = {};
const window = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  localStorage: {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null;
    },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  },
  AEBridge: {
    nodeRequire: require,
    getExtensionPath() { return EXT; },
    evalScript(script, cb) {
      say("error", "AE was called and this probe has no AE half: " +
                   String(script).slice(0, 120));
      if (cb) cb("", true);
    }
  }
};
window.window = window;

function loadPanelFile(rel) {
  const src = fs.readFileSync(path.join(EXT, "js", rel), "utf8");
  new Function("window", src)(window);
}
loadPanelFile("version.js");
loadPanelFile("settings.js");
loadPanelFile("tiers.js");
loadPanelFile("setup.js");
loadPanelFile("llama.js");
loadPanelFile("comfy.js");
loadPanelFile("tools.js");

const Settings = window.Settings;
const Setup = window.Setup;
const Comfy = window.Comfy;
const Llama = window.Llama;
const Tiers = window.Tiers;
const Tools = window.Tools;
const AELL = window.AELL;

/* The probe reads the user's REAL settings and overrides only the two knobs
 * the ladder is about, plus the workflow dir (the REPO's shipped templates,
 * not a stale install copy). Everything else — modelPath, comfyModelsDir,
 * comfyModelRoots — stays the user's, because those are what the numbers are
 * measured from. */
let LADDER = { vramOverrideGB: 0, comfyPauseLlm: "auto" };
const BASE_OVERRIDE = {
  comfyWorkflowsDir: path.join(EXT, "comfy-workflows")
};
if (OPT.model) BASE_OVERRIDE.modelPath = OPT.model;
const realGet = Settings.get;
Settings.get = function () {
  const s = realGet.apply(Settings, arguments);
  for (const k in BASE_OVERRIDE) s[k] = BASE_OVERRIDE[k];
  for (const k in LADDER) s[k] = LADDER[k];
  return s;
};

// --------------------------------------------------------------- reporting

const transcript = [];
let failures = 0;
function say(kind, text) {
  transcript.push({ kind: kind, text: text });
  const tag = { info: "--", row: "  ", verdict: "==", error: "!!" }[kind] || "  ";
  console.log(tag + " " + String(text).replace(/\n/g, "\n   "));
}
function verdict(ok, label, detail) {
  if (!ok) failures++;
  say("verdict", (ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
}

// ------------------------------------------------------------------- setup

function detectGpu(cb) {
  execFile("nvidia-smi",
    ["--query-gpu=name,compute_cap,memory.total",
     "--format=csv,noheader,nounits"], { timeout: 15000 },
    function (err, out) {
      if (err) { cb({ hasNvidia: false, vramGB: null }); return; }
      const p = String(out).split(/\r?\n/)[0].split(",");
      cb({ hasNvidia: true,
           name: (p[0] || "").trim() || null,
           computeCap: /^\d+(\.\d+)?$/.test((p[1] || "").trim())
             ? parseFloat(p[1].trim()) : null,
           vramGB: /^\d+$/.test((p[2] || "").trim())
             ? Math.round(parseInt(p[2].trim(), 10) / 1024) : null });
    });
}

function startChat(cb) {
  if (OPT.noServer) {
    say("info", "--no-server: the ladder runs with no chat model loaded");
    cb(null);
    return;
  }
  const s = Settings.get();
  if (OPT.reuseServer) {
    say("info", "--reuse-server: using whatever listens on " + s.port);
    cb(null);
    return;
  }
  say("info", "starting llama-server: " + s.modelPath);
  let settled = false;
  const giveUp = setTimeout(function () {
    if (!settled) { settled = true; cb(new Error("chat server never came up")); }
  }, 900000);
  Llama.on("status", function (state, detail) {
    if (state === "error") say("error", "llama: " + detail);
    if (state === "running" && !settled) {
      settled = true;
      clearTimeout(giveUp);
      cb(null);
    }
  });
  Llama.start({ serverPath: s.serverPath, modelPath: s.modelPath,
                port: s.port, ctxSize: s.ctxSize, gpuLayers: s.gpuLayers },
              function (err) {
                if (err && !settled) {
                  settled = true;
                  clearTimeout(giveUp);
                  cb(err);
                }
              });
}

/** The shipped manifests, by workflow name, exactly as comfy.js reads them. */
function shippedManifests() {
  const dir = BASE_OVERRIDE.comfyWorkflowsDir;
  const out = [];
  for (const w of Comfy.listWorkflows(dir)) {
    if (w.example) continue;
    out.push({ name: w.name, manifest: Comfy.readManifest(w.file) });
  }
  return out;
}

// ------------------------------------------------------------- the ladder

/* What each tier PROMISES, from TIERS[].policy/mandatory — the ladder checks
 * the panel against its own table rather than against a second copy of it. */
function expectedTierId(gb) {
  const floors = Tiers.TIERS;
  let id = floors[0].id;
  for (const t of floors) if (gb >= t.minGB) id = t.id;
  return id;
}

function run() {
  detectGpu(function (gpu) {
    Tools.setGpuInfo(gpu);
    Setup.setGpuInfo && Setup.setGpuInfo(gpu);
    say("info", "GPU: " + (gpu.hasNvidia
      ? gpu.name + ", " + gpu.vramGB + " GB, compute " + gpu.computeCap +
        " (" + Tiers.archOf(gpu.computeCap) + ")"
      : "no NVIDIA GPU"));

    startChat(function (err) {
      if (err) {
        say("error", "no chat model: " + err.message +
                     " — the handoff column will read 'not loaded'");
      }
      const chatState = (function () {
        try { return Llama.getState(); } catch (e) { return "?"; }
      })();
      say("info", "chat server: " + chatState +
                  (chatState === "running"
                    ? " (" + path.basename(Llama.getCurrentModel() || "?") + ")"
                    : ""));

      const flows = shippedManifests();
      say("info", "shipped workflows: " +
                  flows.map((f) => f.name).join(", "));

      // The card's own number first, then each impersonated budget.
      const rungs = [null].concat(OPT.budgets);
      const rows = [];
      for (const gb of rungs) {
        LADDER.vramOverrideGB = gb === null ? 0 : gb;
        rows.push(measureRung(gb, gpu, flows));
      }
      checkLadder(rows, gpu);
      finish(rows, gpu, chatState);
    });
  });
}

/** Everything the panel says at ONE budget. No decisions are taken here. */
function measureRung(gb, gpu, flows) {
  const s = Settings.get();
  const res = Tiers.resolveTier(gpu, s);
  const rec = Setup.recommendSetup(null, gpu);
  const plans = {};
  for (const mode of ["auto", "always", "never"]) {
    LADDER.comfyPauseLlm = mode;
    const perFlow = {};
    for (const f of flows) {
      const p = Tools._vramArbiter.planFor(Settings.get(), f.manifest);
      perFlow[f.name] = p;
    }
    plans[mode] = perFlow;
  }
  LADDER.comfyPauseLlm = "auto";
  const row = {
    budget: gb, overridden: gb !== null, tier: res.tier, vramGB: res.vramGB,
    arch: res.arch, rec: rec, plans: plans
  };
  say("row", label(row) + ": " + res.tier.id +
      "  chat=" + (rec.chat ? rec.chat.name : "none") +
      "  image=" + (rec.gen.image ? rec.gen.image.name : "none") +
      "  video=" + (rec.gen.video ? rec.gen.video.name : "none"));
  for (const f of flows) {
    const parts = ["auto", "always", "never"].map(
      (m) => m + ":" + plans[m][f.name].decision.mode);
    const need = plans.auto[f.name].genNeedMB;
    say("row", "      " + f.name + " needs " +
        (need === null ? "?" : need + " MB") + " -> " + parts.join(" "));
  }
  say("row", "      " + rec.copy);
  return row;
}

function label(row) {
  return row.budget === null ? "real card (" + row.vramGB + " GB)"
                             : "override " + row.budget + " GB";
}

/* The invariants. Each is a sentence that must be true at EVERY rung; a
 * failure names the rung. */
function checkLadder(rows, gpu) {
  const chatCat = Setup.modelCatalog(null);
  const genCat = Setup.comfyCatalog(null);

  for (const row of rows) {
    const at = label(row);
    const gb = row.vramGB;

    // 1. the tier line
    verdict(row.tier.id === expectedTierId(gb),
            at + ": lands in " + expectedTierId(gb),
            "got " + row.tier.id);
    verdict(row.rec.vramGB === gb && row.rec.overridden === row.overridden &&
            row.rec.tier.id === row.tier.id,
            at + ": settings and tiers agree on the same card",
            "recommendSetup says " + row.rec.vramGB + " GB / " +
            row.rec.tier.id + ", overridden=" + row.rec.overridden);
    verdict(row.rec.copy.indexOf(row.tier.copy) !== -1 &&
            row.rec.copy.indexOf(String(gb) + " GB") !== -1,
            at + ": the first-run line quotes this budget and this tier",
            row.rec.copy);
    if (row.overridden) {
      verdict(row.rec.copy.indexOf("override") !== -1,
              at + ": the line says the number is an override",
              row.rec.copy);
    }
    // An impersonated budget must never change what the SILICON is: the
    // override is a VRAM fiction, and an fp8/nvfp4 gate answered by a
    // fiction would recommend weights the card cannot execute.
    verdict(row.arch === Tiers.archOf(gpu.computeCap),
            at + ": the architecture is still the real one (" + row.arch + ")");

    // 2. the catalog picks
    const chat = row.rec.chat;
    verdict(!!chat, at + ": a chat model is recommended");
    if (chat) {
      verdict(gb === null || chat.minVramGB <= gb,
              at + ": chat pick " + chat.name + " fits the budget",
              "needs " + chat.minVramGB + " GB");
      const bigger = chatCat.filter((c) => c.minVramGB <= gb &&
                                           c.sizeMB > chat.sizeMB);
      verdict(bigger.length === 0,
              at + ": chat pick is the largest that fits",
              "bigger and fitting: " + bigger.map((c) => c.name).join(", "));
    }
    for (const kind of ["image", "video"]) {
      const pick = row.rec.gen[kind];
      if (!pick) continue;
      verdict(Tiers.entryFits(pick, { vramGB: gb, arch: row.arch }),
              at + ": " + kind + " pick " + pick.name + " fits this machine");
      // A pick that is demoted (experimental, or a mode-change slow here)
      // may only win when nothing solid fits the kind.
      const demoted = !!pick.experimental ||
        (typeof pick.slowBelowGB === "number" && gb < pick.slowBelowGB);
      if (demoted) {
        const solid = genCat.filter((e) =>
          (e.kind === "video" ? "video" : "image") === kind &&
          Tiers.entryRecommendable(e, { vramGB: gb, arch: row.arch }) &&
          !e.experimental &&
          !(typeof e.slowBelowGB === "number" && gb < e.slowBelowGB));
        verdict(solid.length === 0,
                at + ": " + kind + " pick is demoted only because nothing " +
                "solid fits",
                "solid alternatives: " + solid.map((e) => e.name).join(", "));
      }
    }

    // 3. the handoff
    for (const flow in row.plans.auto) {
      const auto = row.plans.auto[flow].decision;
      const always = row.plans.always[flow].decision;
      const never = row.plans.never[flow].decision;
      const chatRunning = row.plans.auto[flow].chat.running;
      const what = at + " / " + flow + ": ";

      if (!chatRunning) {
        verdict(auto.mode === "concurrent" && never.mode === "concurrent",
                what + "with no chat model there is nothing to pause",
                auto.mode + " / " + never.mode);
        continue;
      }
      verdict(always.mode === "handoff",
              what + "'always' pauses whatever the arithmetic says",
              always.mode);
      // 'never' is 'auto' with the pause taken away: it may only ever
      // answer what auto answered, or refuse.
      verdict(never.mode === (auto.mode === "concurrent" ? "concurrent"
                                                         : "refuse"),
              what + "'never' mirrors auto or refuses",
              "auto=" + auto.mode + " never=" + never.mode);
      if (row.tier.mandatory) {
        verdict(auto.mode === "handoff" && never.mode === "refuse",
                what + "a mandatory tier never shares the card",
                "auto=" + auto.mode + " never=" + never.mode);
      }
      // The sentence a user reads. Both numbers in it are true and only
      // one of them is measured, so an impersonated budget has to say so
      // (measured 2026-08-30: "~20 GB of the card's 8 GB").
      for (const d of [auto, never]) {
        if (d.reason.indexOf("the card's " + gb + " GB") === -1) continue;
        verdict(row.overridden === (d.reason.indexOf("(VRAM override)") !== -1),
                what + "an impersonated budget is labelled in the sentence",
                d.reason);
      }
      // Arithmetic: a fit is a fit, and the panel must not claim one it
      // cannot prove.
      const p = row.plans.auto[flow];
      if (p.genNeedMB !== null && p.chat.mb !== null && gb !== null) {
        const fits = p.chat.mb + p.genNeedMB + row.tier.headroomGB * 1024
                     <= gb * 1024;
        verdict((auto.mode === "concurrent") ===
                (fits && !row.tier.mandatory),
                what + "concurrency follows the arithmetic (" + p.chat.mb +
                " + " + p.genNeedMB + " + " + (row.tier.headroomGB * 1024) +
                " vs " + gb * 1024 + " MB)",
                auto.mode);
      } else {
        verdict(auto.mode !== "concurrent",
                what + "an unprovable bill never runs beside chat",
                auto.mode);
      }
    }
  }

  // Across the ladder: the picks may only ever grow with the budget.
  const order = rows.filter((r) => r.overridden);
  for (let i = 1; i < order.length; i++) {
    const lo = order[i - 1], hi = order[i];
    if (hi.budget <= lo.budget) continue;
    verdict(!lo.rec.chat || !hi.rec.chat ||
            hi.rec.chat.sizeMB >= lo.rec.chat.sizeMB,
            "chat pick never shrinks as the budget grows (" + lo.budget +
            " -> " + hi.budget + " GB)",
            lo.rec.chat.name + " -> " + hi.rec.chat.name);
    for (const kind of ["image", "video"]) {
      const a = lo.rec.gen[kind], b = hi.rec.gen[kind];
      if (!a || !b) continue;
      verdict((Tiers.recommendFloor(b) || 0) >= (Tiers.recommendFloor(a) || 0),
              kind + " pick never shrinks as the budget grows (" + lo.budget +
              " -> " + hi.budget + " GB)",
              a.name + " -> " + b.name);
    }
  }
}

// ------------------------------------------------------------------ finish

function finish(rows, gpu, chatState) {
  if (!OPT.noServer && !OPT.reuseServer) {
    say("info", "stopping llama-server");
    try { Llama.stop(); } catch (e) {}
  }
  const lines = [];
  lines.push("# Tier impersonation ladder — " + new Date().toISOString());
  lines.push("");
  lines.push("GPU: " + (gpu.hasNvidia
    ? gpu.name + ", " + gpu.vramGB + " GB, compute " + gpu.computeCap
    : "none") + "  |  chat: " + chatState);
  lines.push("");
  lines.push("| budget | tier | chat pick | image | video |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows) {
    lines.push("| " + label(r) + " | " + r.tier.id + " | " +
      (r.rec.chat ? r.rec.chat.name : "-") + " | " +
      (r.rec.gen.image ? r.rec.gen.image.name : "-") + " | " +
      (r.rec.gen.video ? r.rec.gen.video.name : "-") + " |");
  }
  lines.push("");
  lines.push("| budget | workflow | need MB | auto | always | never |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    for (const flow in r.plans.auto) {
      lines.push("| " + label(r) + " | " + flow + " | " +
        (r.plans.auto[flow].genNeedMB === null
          ? "?" : r.plans.auto[flow].genNeedMB) + " | " +
        r.plans.auto[flow].decision.mode + " | " +
        r.plans.always[flow].decision.mode + " | " +
        r.plans.never[flow].decision.mode + " |");
    }
  }
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  for (const t of transcript) lines.push("- `" + t.kind + "` " + t.text);
  const dir = path.join(ROOT, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const out = path.join(dir, "tier-ladder-" +
    new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  say("info", "transcript: " + out);
  console.log(failures === 0
    ? "\nLADDER OK — every rung consistent"
    : "\nLADDER FAILED — " + failures + " invariant(s) broken");
  process.exit(failures === 0 ? 0 : 1);
}

run();
