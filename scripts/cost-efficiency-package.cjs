#!/usr/bin/env node
'use strict';
// Compatibility entrypoint: all admission and verification lives in release.cjs.
require('./release.cjs').cli(['build', ...process.argv.slice(2)]);
