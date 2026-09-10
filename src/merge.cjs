#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const XLSX=require('../vendor/xlsx.cjs');
const C=require('./core.cjs');

function merge(manifests, output, options={}) {
  if(fs.existsSync(output)) throw Error('输出文件已存在，请选择新文件名，保留历史版本');
  const provenance=output.replace(/\.xlsx$/i,'')+'.sources.json';
  if(fs.existsSync(provenance)) throw Error('来源文件已存在，请选择新文件名');
  if(path.extname(output).toLowerCase()!=='.xlsx') throw Error('合并输出必须为 .xlsx');
  let headers, utCol;
  const records=new Map(), sources=[], conflicts=[], linebreaks=[];
  let inputCount=0;
  for(const manifestPath of manifests) {
    const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(m.version!==1 || !m.complete) throw Error('任务未完成或清单版本不支持：'+manifestPath);
    const plan=C.ranges(m.total,m.size);
    if(!Array.isArray(m.batches) || m.batches.length!==plan.length) throw Error('批次缺失：'+manifestPath);
    const jobUT=new Set();
    for(const [i,batch] of m.batches.entries()) {
      const [start,end]=plan[i];
      if(batch.start!==start || batch.end!==end || batch.rows!==end-start+1) throw Error('批次范围不连续：'+manifestPath);
      if(typeof batch.file!=='string' || path.basename(batch.file)!==batch.file) throw Error('批次文件应与清单位于同一目录');
      const file=path.join(path.dirname(manifestPath),batch.file);
      const b=C.inspect(XLSX,fs.readFileSync(file),end-start+1);
      if(!headers) {headers=b.headers;utCol=b.utCol;}
      if(JSON.stringify(headers)!==JSON.stringify(b.headers) || JSON.stringify(b.headers)!==JSON.stringify(m.headers))
        throw Error('字段名称或顺序不一致，请按相同完整字段选项重新导出：'+file);
      for(const [rowIndex,row] of b.rows.entries()) {
        const ut=String(row[utCol]).trim();
        if(jobUT.has(ut)) throw Error('同一检索任务批次重叠：'+ut);
        jobUT.add(ut); inputCount++;
        const source={ut,file:path.resolve(file),row:rowIndex+2,qid:m.qid,job:m.job};
        sources.push(source);
        const cells=headers.map((_,col)=> {
          const cell=b.sheet[XLSX.utils.encode_cell({r:rowIndex+1,c:col})];
          return cell?{...cell,l:cell.l?{...cell.l}:undefined}:null;
        });
        // One original record wins. Duplicate values are not spliced into a synthetic record.
        if(records.has(ut)) {
          const old=records.get(ut);
          for(let col=0;col<headers.length;col++) {
            const first=old.cells[col]?.v??null, next=cells[col]?.v??null;
            if(first!==next) conflicts.push({ut,field:headers[col],kept:first,other:next,keptSource:old.source,otherSource:source});
          }
        } else records.set(ut,{cells,source});
      }
    }
    if(jobUT.size!==m.total) throw Error('任务记录数量不完整');
  }
  if(!headers || !records.size) throw Error('没有可合并的记录');
  if(records.size+1>1048576) throw Error('超出 Excel 单表行数上限');
  const sheet=XLSX.utils.aoa_to_sheet([headers]);
  const proseFields=new Set(['articletitle','abstract','fundingtext']);
  let r=1;
  for(const [ut,{cells}] of records) {
    cells.forEach((cell,col)=>{
      if(!cell) return;
      const c={...cell};
      if(typeof c.v==='string' && /[\r\n]/.test(c.v)) {
        const normalize=Boolean(options.normalizeProse && proseFields.has(C.key(headers[col])));
        linebreaks.push({ut,field:headers[col],action:normalize?'normalized':'preserved'});
        if(normalize) {c.v=C.prose(c.v);delete c.w;}
      }
      if(typeof c.v==='string' && c.v.length>32767) throw Error('字段超出 Excel 字符限制，停止而不截断：'+ut+' '+headers[col]);
      sheet[XLSX.utils.encode_cell({r,c:col})]=c;
    });
    r++;
  }
  sheet['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:headers.length-1}});
  sheet['!autofilter']={ref:sheet['!ref']};
  const book=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,sheet,'Sheet1');
  const bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  // Saved values, native header order and unique row count must survive serialization.
  const check=C.inspect(XLSX,bytes,records.size);
  const expected=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null}).slice(1);
  if(JSON.stringify(check.rows)!==JSON.stringify(expected)) throw Error('Excel 写入后数据不一致，停止交付');
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  fs.writeFileSync(output,bytes,{flag:'wx'});
  const report={inputCount,outputCount:records.size,duplicates:inputCount-records.size,policy:'Exact UT; retain first whole record in supplied manifest order; no DOI-only merge',normalizeProse:Boolean(options.normalizeProse),sources,conflicts,linebreaks};
  try {fs.writeFileSync(provenance,JSON.stringify(report,null,2),{flag:'wx'});}
  catch(e) {throw Error('Excel 已保存，但来源对应表保存失败：'+e.message);}
  return {inputCount,outputCount:records.size,duplicates:inputCount-records.size,conflicts:conflicts.length,linebreaks:linebreaks.length,output,provenance};
}
if(require.main===module) {
  const args=process.argv.slice(2), normalizeProse=args.includes('--normalize-prose');
  const clean=args.filter(a=>a!=='--normalize-prose');
  if(clean.length<2) {console.error('用法：node src/merge.cjs 输出.xlsx 批次清单.json [其他集合清单.json ...] [--normalize-prose]');process.exitCode=1;}
  else try {console.log(JSON.stringify(merge(clean.slice(1),clean[0],{normalizeProse}),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={merge};
