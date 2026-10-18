'use strict';
const {test}=require('node:test');
const {unavailable}=require('./private-history-unavailable.cjs');
test('private historical release evidence is unavailable in the public distribution',()=>{throw unavailable();});
