// The .mogrt reader ships from extension/ (package-zxp.ps1 stages only
// that tree); scripts/ and tests/ reach it through this path so a move
// of the shipped file is a one-line change here.
"use strict";
module.exports = require("../../extension/js/mogrt-read.js");
