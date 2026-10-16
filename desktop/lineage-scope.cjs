const {createHash}=require('node:crypto');

// This parser consumes a trusted contract, never sources, feedback or query IDs.
// A grammar mismatch returns control to the planner; it is not a partial scope.
const label=/^(?:区域\s*([A-Za-z][\w-]*)[，,\s]*)?(?:([零〇一二两三四五六七八九十百千\d]+)个)?(?:入口|起点|root)(?:任务)?\s*(IDs?)?\s*[:：]\s*(.*)$/i;
const entry=/^\s*(?:[-*+]\s+|\d+[.)、]\s+)?(?:`(\d+)`|(\d+))\s*(?:→|->|=>)\s*(?:[A-Za-z_]\w*\.[A-Za-z_]\w*|`[A-Za-z_]\w*\.[A-Za-z_]\w*`|`[A-Za-z_]\w*`\.`[A-Za-z_]\w*`)\s*$/;
const idsLine=/^\d+(?:(?:\s*[,，、/]\s*|\s+)\d+)*$/;
const referenceHeading=/(?:历史|旧范围|已取消|示例|参考|historical|example)/i;

function declaredCount(value){
 if(value===undefined)return null;
 if(/^\d+$/.test(value)){const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:NaN;}
 const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000};
 let total=0,digit=null,lastUnit=10000;
 for(const char of value){
  if(Object.hasOwn(digits,char)){
   if(digit!==null&&digit!==0)return NaN;
   digit=digits[char];
  }else if(units[char]){
   const unit=units[char];
   if(unit>=lastUnit||digit===0||digit===null&&(total!==0||unit!==10))return NaN;
   total+=(digit??1)*unit;lastUnit=unit;digit=null;
  }else return NaN;
 }
 return total+(digit??0)||NaN;
}

function canonicalId(value){
 const n=Number(value);
 return /^\d+$/.test(value)&&Number.isSafeInteger(n)&&n>0?String(n):null;
}

function looksLikeEntry(line){
 return /(?:→|->|=>)/.test(line)||/^\s*(?:[-*+]\s+)?`?\d+(?:`|\s|$)/.test(line)||/^\s*[-*+]\s+/.test(line);
}

function sectionBoundary(line){
 return /^\s*#{1,6}\s+/.test(line)||/[:：]\s*$/.test(line)||/^\s*\d+[.)、]\s+\D/.test(line);
}

function hasUnlabelledContinuation(lines,start){
 for(const line of lines.slice(start)){
  if(!line.trim())continue;
  if(sectionBoundary(line))return false;
  if(looksLikeEntry(line))return true;
 }
 return false;
}

function resolve(job){
 const contract=job?.executionContract;
 const hasContract=contract!==undefined&&contract!==null;
 const raw=hasContract?contract?.text:job?.goal;
 const text=typeof raw==='string'?raw.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\r\n?/g,'\n'):'';
 const suppliedRevision=hasContract?contract?.revision:undefined;
 const revision=typeof suppliedRevision==='string'&&suppliedRevision.trim()?suppliedRevision:
  typeof suppliedRevision==='number'&&Number.isFinite(suppliedRevision)?String(suppliedRevision):
  'scope:'+createHash('sha256').update((hasContract?'contract:':'goal:')+text).digest('hex');
 const result=(status,reason,rootIds=[])=>({status,rootIds,region:'sg',revision,...(reason?{reason}:{})});
 if(!text.trim())return result('unavailable',hasContract?'current_contract_text_missing':'goal_text_missing');

 const lines=text.split('\n'),blocks=[];
 let fence=null,referenceSection=false,otherRegion=false;
 for(let i=0;i<lines.length;i++){
  const rawLine=lines[i].trim(),fenceMatch=rawLine.match(/^(`{3,}|~{3,})/);
  if(fenceMatch){
   const marker=fenceMatch[1];
   if(!fence)fence=marker;
   else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;
   continue;
  }
  const quoted=/^>/.test(rawLine),line=rawLine.replace(/^>\s*/,'').replace(/^#{1,6}\s+/,'');
  const match=line.match(label);
  if(match){blocks.push({index:i,region:match[1],count:declaredCount(match[2]),ids:!!match[3],tail:match[4],reference:!!fence||quoted||referenceSection});continue;}
  if(fence||quoted)continue;
  const region=line.match(/^区域\s*[:：]?\s*([A-Za-z][\w-]*)\s*$/i);
  if(region&&region[1].toLowerCase()!=='sg')otherRegion=true;
  if(/[:：]$/.test(line)||/^#{1,6}\s+/.test(rawLine))referenceSection=referenceHeading.test(line);
 }
 if(!blocks.length)return result('unavailable','explicit_entry_scope_missing');
 if(blocks.length!==1)return result('ambiguous','multiple_entry_blocks');
 const block=blocks[0];
 if(block.reference)return result('ambiguous','entry_block_is_reference');
 if(otherRegion||block.region&&block.region.toLowerCase()!=='sg')return result('unavailable','entry_region_is_not_sg');
 if(Number.isNaN(block.count))return result('ambiguous','invalid_declared_count');

 const rawIds=[];
 if(block.tail){
  if(!block.ids||!idsLine.test(block.tail))return result('ambiguous','invalid_entry_ids_line');
  rawIds.push(...block.tail.split(/[\s,，、/]+/));
  // Blank lines or intervening prose cannot hide an unlabelled continuation.
  if(hasUnlabelledContinuation(lines,block.index+1))return result('ambiguous','entry_ids_line_has_continuation');
 }else{
  let separated=false;
  for(let i=block.index+1;i<lines.length;i++){
   const line=lines[i];
   if(!line.trim()){separated=true;continue;}
   const row=line.match(entry);
   if(row){rawIds.push(row[1]||row[2]);separated=false;continue;}
   if(!rawIds.length||looksLikeEntry(line))return result('ambiguous','invalid_entry_row');
   // Only a paragraph/section boundary ends a list. Unexpected text within it
   // invalidates the entire block instead of retaining the parsed prefix.
   if(sectionBoundary(line))break;
   if(separated){
    if(hasUnlabelledContinuation(lines,i+1))return result('ambiguous','incomplete_entry_block');
    break;
   }
   return result('ambiguous','incomplete_entry_block');
  }
 }
 if(!rawIds.length)return result('ambiguous','empty_entry_block');
 const rootIds=rawIds.map(canonicalId);
 if(rootIds.some(id=>id===null))return result('ambiguous','invalid_entry_id');
 if(new Set(rootIds).size!==rootIds.length)return result('ambiguous','duplicate_entry_id');
 if(block.count!==null&&block.count!==rootIds.length)return result('ambiguous','entry_count_mismatch');
 return result('ready',null,rootIds);
}

module.exports={resolve};
