'use strict';
// Internal per-package switches for evaluation/rollback, never model-controlled.
const enabled=(a,part)=>a.data?.settings?.evidenceGrounding===true&&a.contextOptimizationOverrides?.[part]!==false&&
 (!['A1','A2'].includes(part)||a.contextOptimizationOverrides?.A!==false)&&
 (part!=='A2'||a.contextOptimizationOverrides?.A1!==false);
module.exports={enabled};
