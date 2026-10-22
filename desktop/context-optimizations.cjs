'use strict';
// Internal per-package switches for evaluation/rollback, never model-controlled.
const enabled=(a,part)=>a.data?.settings?.evidenceGrounding===true&&a.contextOptimizationOverrides?.[part]!==false;
module.exports={enabled};
