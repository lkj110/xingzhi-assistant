'use strict';
const {hash}=require('./evidence-basis.cjs');
const rows=v=>Array.isArray(v)?v:[];
// Titles are exact source fields, never normalized labels or body coordinates.
function titleBasis(catalog){
 return hash(rows(catalog).filter(r=>r.type==='source'&&r.purpose==='input'&&!r.ambiguous)
  .map(r=>[r.id,r.version,hash(r.title)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en')));
}
function field(citation){return citation?.field===undefined?'content':['content','title'].includes(citation.field)?citation.field:null;}
function observeTitles(seen,supplied){
 seen.titles ||= new Map();
 const reads=[...rows(supplied.contextReads).map(r=>r.result),...rows(supplied.generationEvidence),...rows(supplied.requestedSections),...rows(supplied.retrievedEvidence)];
 const catalog=[...rows(supplied.sourceCatalog),...rows(supplied.sources),...reads.filter(r=>r?.directory===true).flatMap(r=>rows(r.sources))];
 for(const r of [...catalog.filter(r=>r?.type==='source'&&r.purpose==='input'&&!r.ambiguous),...reads.filter(r=>r?.sourceId&&!r.artifactId&&r.ok!==false)]){
  const id=r.sourceId||r.id;
  if(!id||!r.version||typeof r.title!=='string')continue;
  const key=id+':'+r.version,values=seen.titles.get(key)||new Set();values.add(r.title);seen.titles.set(key,values);
 }
}
const substantive=citation=>citation&&citation.field!=='title';
module.exports={field,titleBasis,observeTitles,substantive};
