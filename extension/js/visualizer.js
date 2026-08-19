/*
 * visualizer.js — the Visualizer pane: an interactive cubic-bezier editor
 * (two draggable handles, cubic-bezier.com style) driving curve-based tools:
 *
 *   stagger   -> stagger_layers        (distribute layer start times)
 *   property  -> distribute_property   (ramp a value across layers)
 *   ease      -> apply_keyframe_ease   (temporal ease between keyframes)
 *
 * The pane is a thin GUI over the same host tools the LLM can call, so
 * everything here is also scriptable by chat. Future visual tools live here.
 */
(function (global) {
  "use strict";

  var canvas = null;
  var ctx = null;
  var bez = [0.25, 0.25, 0.75, 0.75];      // x1,y1,x2,y2
  var dragging = -1;                        // 0 = P1, 1 = P2
  var previewCount = 8;                     // ticks along the bottom
  var deps = null;                          // {appendMsg, callHostTool, $}

  // Curve area inside the canvas (padding for overshoot headroom).
  var PAD = 28;

  function toPx(x, y) {
    var w = canvas.width - PAD * 2;
    var h = canvas.height - PAD * 2;
    return [PAD + x * w, canvas.height - PAD - y * h];
  }

  function fromPx(px, py) {
    var w = canvas.width - PAD * 2;
    var h = canvas.height - PAD * 2;
    return [(px - PAD) / w, (canvas.height - PAD - py) / h];
  }

  function bezY(x) {
    var x1 = bez[0], y1 = bez[1], x2 = bez[2], y2 = bez[3];
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var lo = 0, hi = 1, u = x, i, cx, v;
    for (i = 0; i < 40; i++) {
      v = 1 - u;
      cx = 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u;
      if (Math.abs(cx - x) < 0.00001) break;
      if (cx < x) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    v = 1 - u;
    return 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u;
  }

  function draw() {
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // unit box + midlines
    var p00 = toPx(0, 0), p11 = toPx(1, 1);
    ctx.strokeStyle = "#2e2e2e";
    ctx.lineWidth = 1;
    ctx.strokeRect(p00[0], p11[1], p11[0] - p00[0], p00[1] - p11[1]);
    ctx.beginPath();
    var mid = toPx(0.5, 0);
    ctx.moveTo(mid[0], p00[1]); ctx.lineTo(mid[0], p11[1]);
    mid = toPx(0, 0.5);
    ctx.moveTo(p00[0], mid[1]); ctx.lineTo(p11[0], mid[1]);
    ctx.stroke();

    // handle arms
    var h1 = toPx(bez[0], bez[1]);
    var h2 = toPx(bez[2], bez[3]);
    ctx.strokeStyle = "#666";
    ctx.beginPath();
    ctx.moveTo(p00[0], p00[1]); ctx.lineTo(h1[0], h1[1]);
    ctx.moveTo(p11[0], p11[1]); ctx.lineTo(h2[0], h2[1]);
    ctx.stroke();

    // curve
    ctx.strokeStyle = "#57b757";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= 60; i++) {
      var t = i / 60;
      var p = toPx(t, bezY(t));
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();

    // landing ticks: where each of n layers falls in normalized time
    ctx.fillStyle = "#2d6ca2";
    var n = Math.max(2, previewCount);
    for (i = 0; i < n; i++) {
      var y = bezY(i / (n - 1));
      var tp = toPx(Math.max(-0.1, Math.min(1.1, y)), 0);
      ctx.fillRect(tp[0] - 1, p00[1] + 6, 3, 8);
    }
    ctx.fillStyle = "#888";
    ctx.font = "9px sans-serif";
    ctx.fillText("landing times (" + n + " layers)", p00[0], p00[1] + 24);

    // handles
    for (i = 0; i < 2; i++) {
      var hp = i === 0 ? h1 : h2;
      ctx.fillStyle = i === 0 ? "#e2ae98" : "#6db3e8";
      ctx.beginPath();
      ctx.arc(hp[0], hp[1], 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function nearHandle(px, py) {
    var h1 = toPx(bez[0], bez[1]);
    var h2 = toPx(bez[2], bez[3]);
    var d1 = Math.pow(px - h1[0], 2) + Math.pow(py - h1[1], 2);
    var d2 = Math.pow(px - h2[0], 2) + Math.pow(py - h2[1], 2);
    if (Math.min(d1, d2) > 400) return -1;
    return d1 <= d2 ? 0 : 1;
  }

  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width),
            (e.clientY - r.top) * (canvas.height / r.height)];
  }

  function setBez(next) {
    bez = [Math.max(0, Math.min(1, next[0])),
           Math.max(-1, Math.min(2, next[1])),
           Math.max(0, Math.min(1, next[2])),
           Math.max(-1, Math.min(2, next[3]))];
    try { global.Settings.set({ vizBezier: bez.slice() }); } catch (e) {}
    draw();
  }

  function refreshPreviewCount() {
    deps.callHostTool("get_comp_details", {}, function (r) {
      if (r.ok && r.data && r.data.layers) {
        var sel = 0;
        for (var i = 0; i < r.data.layers.length; i++) {
          if (r.data.layers[i].selected) sel++;
        }
        previewCount = sel >= 2 ? sel : Math.min(8, r.data.numLayers || 8);
        draw();
      }
    });
  }

  function currentMode() {
    return deps.$("viz-mode").value;
  }

  function apply() {
    var mode = currentMode();
    var hint = deps.$("viz-hint");
    hint.textContent = "Applying…";

    function done(r) {
      if (!r.ok) {
        hint.textContent = "";
        deps.appendMsg("error", "Visualizer: " + r.error);
        return;
      }
      hint.textContent = "Applied — Ctrl+Z undoes, tweak and re-apply.";
      deps.appendMsg("tool",
        JSON.stringify(r.data).slice(0, 300), "visualizer:" + mode);
    }

    if (mode === "stagger") {
      var spread = parseFloat(deps.$("viz-spread").value);
      if (!(spread > 0)) {
        hint.textContent = "Spread must be > 0.";
        return;
      }
      var args = { bezier: bez.slice(), spread: spread,
                   order: deps.$("viz-order").value };
      var startAt = deps.$("viz-startat").value;
      if (startAt !== "") args.startAt = parseFloat(startAt);
      deps.callHostTool("stagger_layers", args, done);
    } else if (mode === "property") {
      deps.callHostTool("distribute_property", {
        bezier: bez.slice(),
        property: deps.$("viz-prop").value,
        from: parseFloat(deps.$("viz-from").value),
        to: parseFloat(deps.$("viz-to").value)
      }, done);
    } else {
      var layerRef = deps.$("viz-ease-layer").value;
      var args2 = {
        bezier: bez.slice(),
        property: deps.$("viz-ease-prop").value || "position",
        allPairs: !!deps.$("viz-ease-all").checked
      };
      if (layerRef !== "") {
        args2.layer = layerRef;
        deps.callHostTool("apply_keyframe_ease", args2, done);
      } else {
        // blank layer = the single selected layer
        deps.callHostTool("get_comp_details", {}, function (r) {
          var sel = [];
          if (r.ok && r.data && r.data.layers) {
            for (var i = 0; i < r.data.layers.length; i++) {
              if (r.data.layers[i].selected) sel.push(r.data.layers[i].name);
            }
          }
          if (sel.length !== 1) {
            hint.textContent = "";
            deps.appendMsg("error", "Visualizer: select exactly one layer " +
              "(or type its name) for keyframe easing — got " + sel.length);
            return;
          }
          args2.layer = sel[0];
          deps.callHostTool("apply_keyframe_ease", args2, done);
        });
      }
    }
  }

  function modeChanged() {
    var mode = currentMode();
    deps.$("viz-params-stagger").classList.toggle("hidden", mode !== "stagger");
    deps.$("viz-params-property").classList.toggle("hidden", mode !== "property");
    deps.$("viz-params-ease").classList.toggle("hidden", mode !== "ease");
    deps.$("viz-apply").textContent =
      mode === "ease" ? "Apply ease" : "Apply to selection";
  }

  global.Viz = {
    init: function (d) {
      deps = d;
      canvas = deps.$("viz-canvas");
      ctx = canvas.getContext("2d");

      var saved = null;
      try { saved = global.Settings.get().vizBezier; } catch (e) {}
      if (saved && saved.length === 4) bez = saved.slice();

      canvas.addEventListener("mousedown", function (e) {
        var p = canvasPos(e);
        dragging = nearHandle(p[0], p[1]);
      });
      global.addEventListener("mousemove", function (e) {
        if (dragging < 0) return;
        var p = canvasPos(e);
        var xy = fromPx(p[0], p[1]);
        var next = bez.slice();
        next[dragging * 2] = xy[0];
        next[dragging * 2 + 1] = xy[1];
        setBez(next);
      });
      global.addEventListener("mouseup", function () { dragging = -1; });

      var presets = deps.$("viz-presets").getElementsByTagName("button");
      for (var i = 0; i < presets.length; i++) {
        (function (btn) {
          btn.addEventListener("click", function () {
            var parts = btn.getAttribute("data-bez").split(",");
            setBez([parseFloat(parts[0]), parseFloat(parts[1]),
                    parseFloat(parts[2]), parseFloat(parts[3])]);
          });
        })(presets[i]);
      }

      deps.$("viz-mode").addEventListener("change", modeChanged);
      deps.$("viz-apply").addEventListener("click", apply);

      modeChanged();
      draw();
    },
    onShow: function () { refreshPreviewCount(); }
  };

})(window);
