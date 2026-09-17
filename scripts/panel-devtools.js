#!/usr/bin/env node
/*
 * panel-devtools.js - drive an OPEN AE Llama panel over CEP's DevTools port.
 *
 * The installed panel ships `.debug` (port 8092). While the panel is open
 * that port is a Chrome DevTools endpoint, so an unattended pass can do
 * what a person at the panel would: type, click, read the chat and log.
 * Measured 2026-09-17: the panel can be OPENED without the UI by an -r
 * script, `app.executeCommand(app.findMenuCommandId("AE Llama"))`
 * (id 5029 on AE 26.3; look it up, do not hardcode it).
 *
 *   node scripts/panel-devtools.js --eval "<expr>" [--watch SEC]
 *        [--until "<expr>"] [--port 8092]
 *
 * --eval   evaluated in the page (promises awaited), result printed as JSON.
 * --watch  keep listening SEC seconds after the eval; every uncaught
 *          exception and console.error in that window is printed.
 * --until  with --watch: stop early once this expression is truthy
 *          (polled every second).
 * Exit 0 = eval ran and no exception was seen; 1 = an exception or
 * console.error was seen; 2 = no panel on the port.
 */
"use strict";

var http = require("http");

function arg(name, dflt) {
  var i = process.argv.indexOf("--" + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

var PORT = Number(arg("port", "8092"));
var EXPR = arg("eval", "document.title");
var WATCH = Number(arg("watch", "0"));
var UNTIL = arg("until", "");

function getTargets(cb) {
  http.get({ host: "127.0.0.1", port: PORT, path: "/json" }, function (res) {
    var body = "";
    res.on("data", function (d) { body += d; });
    res.on("end", function () {
      try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
    });
  }).on("error", cb);
}

getTargets(function (err, list) {
  var page = !err && (list || []).filter(function (t) {
    return t.type === "page" && /com\.cptk\.aellama/.test(t.url);
  })[0];
  if (!page) {
    console.log("no AE Llama panel on port " + PORT +
      (err ? " (" + err.message + ")" : "") + " - is the panel open?");
    process.exit(2);
  }
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  var nextId = 1, pending = {}, problems = 0;

  function send(method, params) {
    return new Promise(function (resolve) {
      var id = nextId++;
      pending[id] = resolve;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  function evaluate(expr) {
    return send("Runtime.evaluate", {
      expression: expr, awaitPromise: true, returnByValue: true
    }).then(function (r) {
      if (r.exceptionDetails) {
        problems++;
        return { exception: (r.exceptionDetails.exception || {}).description ||
                 r.exceptionDetails.text };
      }
      return { value: (r.result || {}).value };
    });
  }

  ws.onmessage = function (m) {
    var msg = JSON.parse(m.data);
    if (msg.id && pending[msg.id]) {
      pending[msg.id](msg.result || { exceptionDetails: msg.error });
      delete pending[msg.id];
    } else if (msg.method === "Runtime.exceptionThrown") {
      problems++;
      var d = msg.params.exceptionDetails;
      console.log("EXCEPTION: " + ((d.exception || {}).description || d.text));
    } else if (msg.method === "Runtime.consoleAPICalled" &&
               msg.params.type === "error") {
      problems++;
      console.log("console.error: " + msg.params.args.map(function (a) {
        return a.value !== undefined ? a.value : a.description;
      }).join(" "));
    }
  };
  ws.onopen = function () {
    send("Runtime.enable").then(function () {
      return evaluate(EXPR);
    }).then(function (r) {
      console.log(JSON.stringify(r, null, 1));
      var end = Date.now() + WATCH * 1000;
      function tick() {
        if (Date.now() >= end) return done();
        if (!UNTIL) return setTimeout(tick, 1000);
        evaluate(UNTIL).then(function (u) {
          if (u.value) {
            console.log("until: met after " +
              Math.round((WATCH * 1000 - (end - Date.now())) / 1000) + " s");
            return done();
          }
          setTimeout(tick, 1000);
        });
      }
      tick();
    });
  };
  function done() {
    ws.close();
    process.exit(problems ? 1 : 0);
  }
});
