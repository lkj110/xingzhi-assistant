#!/usr/bin/env node
'use strict';
// Compatibility entrypoint: all admission and verification lives in release.cjs.
require('./release.cjs').cli(['verify', ...process.argv.slice(2)]);
