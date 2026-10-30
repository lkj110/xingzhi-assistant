'use strict';
const base=require('./identity.cjs');
module.exports={...base,frozen:(executable,options={})=>base.frozen(executable,{...options,phase:'business'})};
