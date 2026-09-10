'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const UI=require('../src/ui.cjs');
const {run,validateConfig,verifySaved}=require('../src/export.cjs');
const X=require('../vendor/xlsx.cjs');
const {merge}=require('../src/merge.cjs');
const headers=['Publication Type','Article Title','Authors','Abstract','Author Keywords','UT (Unique WOS ID)','Cited References','Funding Text','Affiliations','Keywords Plus','Document Type','DOI'];
function bytes(start,end) {
 const book=X.utils.book_new();
 X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([headers,...Array.from({length:end-start+1},(_,i)=>['J','Test '+(start+i),'Author','Prose without wrap','wear','WOS:TEST'+(start+i),'Reference A; Reference B','Funding prose','Institution','steel','Article','10.test/'+(start+i)])]),'Sheet1');
 return X.write(book,{type:'buffer',bookType:'xls'});
}
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'wos-pw-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const config={url:'https://webofscience.clarivate.cn/wos/woscc/advanced-search',queries:[{id:'P1',query:'TS=(steel)'}]};
test('配置拒绝旧会话集合编号、重复任务和超出上限的批次',()=>{
 assert.equal(validateConfig(config).batchSize,1000);
 assert.throws(()=>validateConfig({...config,queries:[{id:'P1',query:'#1 OR #2'}]}),/展开/);
 assert.throws(()=>validateConfig({...config,queries:[...config.queries,...config.queries]}),/唯一/);
 assert.throws(()=>validateConfig({...config,batchSize:1001}),/1–1000/);
});
test('结果数量只接受 Core Collection 标题，不把错误当零结果',()=>{
 assert.equal(UI.resultCount('1,294 results from Web of Science Core Collection for:'),1294);
 assert.throws(()=>UI.resultCount('No records available due to error'));
});
test('完整字段缺失或 HTML 假下载必须停止',()=>{
 assert.equal(UI.fullRecord(bytes(1,2),2).rows.length,2);
 assert.throws(()=>UI.fullRecord(Buffer.from('<html>login</html>'),2),/不是原生/);
 const book=X.utils.book_new();X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([headers.slice(0,6),['J','Title','A','Ab','K','WOS:T']]),'Sheet1');
 assert.throws(()=>UI.fullRecord(X.write(book,{type:'buffer',bookType:'xlsx'}),1),/缺少/);
});
test('续传验证读取真实文件并发现缺批、重复 UT、字段变化',t=>{
 const d=temp(t);fs.writeFileSync(path.join(d,'1.xls'),bytes(1,2));fs.writeFileSync(path.join(d,'2.xls'),bytes(2,3));
 const m={total:4,size:2,headers,batches:[{start:1,end:2,rows:2,file:'1.xls'}],complete:false};
 assert.equal(verifySaved(m,d).size,2);
 assert.throws(()=>verifySaved({...m,complete:true},d),/批次/);
 assert.throws(()=>verifySaved({...m,batches:[...m.batches,{start:3,end:4,rows:2,file:'2.xls'}]},d),/重叠/);
 assert.throws(()=>verifySaved({...m,headers:[...headers].reverse()},d),/表头/);
 fs.unlinkSync(path.join(d,'1.xls'));assert.throws(()=>verifySaved(m,d),/ENOENT/);
});
test('真实浏览器菜单缺失重载→两次原生下载；每批重选字段；原字节保留并合并',async t=>{
 const dir=temp(t),requests=[];
 const markup=`<!doctype html><html><body><h1>7 results from Web of Science Core Collection for:</h1><section aria-label="summaryRecordsTop"><button onclick="document.querySelector('[role=menuitem]').hidden=false">Export</button></section>
 <button role="menuitem" hidden onclick="openExport()">Excel</button><div id="modal" hidden>
 <h1>Export Records to Excel</h1><input type="radio" aria-label="Records from:">
 <input type="number" aria-label="Input starting record range" value="1">
 <input type="number" aria-label="Input ending record range. A maximum of 1000 records can be exported at one time." value="7">
 <button role="combobox" aria-label="Filter by, Author, Title, Source" onclick="document.querySelector('[role=option]').hidden=sessionStorage.getItem('menuReady')!=='yes';sessionStorage.setItem('menuReady','yes')">Author, Title, Source</button>
 <div role="option" aria-label="Custom selection (10)" hidden><button onclick="document.querySelector('#fields').hidden=false">Edit</button></div>
 <div id="fields" hidden>${UI.groups.map(g=>`<input type="checkbox" aria-label="${g}" onchange="document.querySelector('[aria-label=${g}_CHILD]').checked=this.checked"><input type="checkbox" aria-label="${g}_CHILD">`).join('')}<button onclick="save()">Save selections</button></div>
 <button id="exportButton" onclick="downloadFile()">Export</button></div>
 <script>
 function openExport(){document.querySelector('#modal').hidden=false;document.querySelectorAll('[type=checkbox]').forEach(e=>e.checked=false);document.querySelector('[role=combobox]').textContent='Author, Title, Source';document.querySelector('[role=option]').hidden=true;document.querySelector('#fields').hidden=true;}
 function save(){if([...document.querySelectorAll('[type=checkbox]')].some(e=>!e.checked))throw Error('Missing fields');document.querySelector('[role=combobox]').textContent='Custom selection (30)';document.querySelector('#fields').hidden=true;document.querySelector('[role=option]').hidden=true;}
 function downloadFile(){let n=document.querySelectorAll('[type=number]');let a=document.createElement('a');a.href='/download?start='+n[0].value+'&end='+n[1].value+'&all='+[...document.querySelectorAll('[type=checkbox]')].every(e=>e.checked);a.download='savedrecs.xls';a.click();document.querySelector('#modal').hidden=true;document.querySelector('[role=menuitem]').hidden=true;}
 </script></body></html>`;
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/download') {
   requests.push(Object.fromEntries(u.searchParams));
   res.writeHead(200,{'Content-Type':'application/vnd.ms-excel','Content-Disposition':'attachment; filename="savedrecs.xls"'});
   res.end(bytes(+u.searchParams.get('start'),+u.searchParams.get('end')));
  }else{res.writeHead(200,{'Content-Type':'text/html'});res.end(markup);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({acceptDownloads:true});await page.goto('http://127.0.0.1:'+server.address().port);
 const a=await UI.exportBatch(page,1,4,dir,'first');const b=await UI.exportBatch(page,5,7,dir,'last');
 assert.deepEqual(requests,[{start:'1',end:'4',all:'true'},{start:'5',end:'7',all:'true'}]);
 assert.ok(fs.readFileSync(path.join(dir,a.batch.file)).equals(bytes(1,4)));
 assert.ok(fs.readFileSync(path.join(dir,b.batch.file)).equals(bytes(5,7)));
 const m={version:1,job:'Test',qid:'local',total:7,size:4,headers,batches:[a.batch,b.batch],complete:true};
 const manifest=path.join(dir,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(m));
 assert.equal(verifySaved(m,dir).size,7);
 await assert.rejects(UI.exportBatch(page,1,1,dir,'rejected',5000,()=>{throw Error('跨批次重复 UT');}),/重复/);
 assert.equal(fs.existsSync(path.join(dir,'rejected.xls')),false);
 const result=merge([manifest],path.join(dir,'merged.xlsx'));assert.equal(result.outputCount,7);
 await page.setContent('<h1>Your search found no results</h1>');assert.equal(await UI.waitResult(page,300),0);
 await page.setContent('<h1>An unknown error has occurred.</h1>');await assert.rejects(UI.waitResult(page,200),/服务器错误/);
 await page.setContent('<h1>Verify you are human</h1>');await assert.rejects(UI.waitResult(page,200),/Timeout/);
});

test('已完成任务再次续传只核对文件，不启动浏览器或覆盖交付',async t=>{
 const out=temp(t),c=validateConfig(config);const dir=path.join(out,'raw','P1');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'first.xls'),bytes(1,1));
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({version:1,job:'P1',query:c.queries[0].query,total:1,size:1000,headers,batches:[{start:1,end:1,rows:1,file:'first.xls'}],complete:true}));
 const merged=path.join(out,'WoS-native-merged.xlsx');const m=merge([path.join(dir,'manifest.json')],merged);
 fs.writeFileSync(path.join(out,'searches.json'),JSON.stringify(c));fs.writeFileSync(path.join(out,'set-membership.csv'),'UT,Search sets');
 fs.writeFileSync(path.join(out,'status.json'),JSON.stringify({status:'complete',result:m}));const before=fs.statSync(merged).mtimeMs;
 assert.equal((await run(c,{out,resume:true})).status,'complete');assert.equal(fs.statSync(merged).mtimeMs,before);
});
