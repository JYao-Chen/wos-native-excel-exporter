#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseArgs}=require('node:util');
const {setTimeout:sleep}=require('node:timers/promises');
const {createInterface}=require('node:readline/promises');
const {chromium}=require('playwright');
const C=require('./core.cjs');
const {merge}=require('./merge.cjs');
const UI=require('./ui.cjs');

function validateConfig(c) {
  if(!c || !Array.isArray(c.queries) || !c.queries.length) throw Error('配置需要非空 queries 数组');
  const url=new URL(c.url);
  if(url.protocol!=='https:' || !['webofscience.clarivate.cn','www.webofscience.com'].includes(url.hostname) || url.pathname!=='/wos/woscc/advanced-search')
    throw Error('url 应为 WoS Core Collection 高级检索页面');
  const size=c.batchSize??1000,delay=c.delayMs??3000;
  if(!Number.isSafeInteger(size)||size<1||size>1000) throw Error('batchSize 应为 1–1000 的整数');
  if(!Number.isFinite(delay)||delay<1000) throw Error('delayMs 应至少为 1000，串行下载');
  const ids=new Set();
  for(const q of c.queries) {
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(q.id??'') || ids.has(q.id)) throw Error('集合 id 需唯一且仅含字母、数字、横线、下划线');
    if(typeof q.query!=='string'||!q.query.trim()||/#\d+/.test(q.query)) throw Error('请使用完整展开检索式，不依赖其他会话的 #编号');
    ids.add(q.id);
  }
  return {...c,batchSize:size,delayMs:delay};
}
function saveJSON(file,value) {
  fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');
  fs.renameSync(file+'.tmp',file);
}
function verifySaved(m, directory) {
  const seen=new Set();
  if(m.total===0) {
    if(!m.complete||m.batches.length) throw Error('零结果任务状态不一致');
    return seen;
  }
  const plan=C.ranges(m.total,m.size);
  if(m.batches.length>plan.length || m.complete&&m.batches.length!==plan.length) throw Error('已保存批次数量不正确');
  for(const [i,b] of m.batches.entries()) {
    if(b.start!==plan[i][0] || b.end!==plan[i][1] || b.rows!==b.end-b.start+1 || path.basename(b.file)!==b.file) throw Error('已保存批次范围不连续');
    const d=UI.fullRecord(fs.readFileSync(path.join(directory,b.file)),b.rows);
    if(JSON.stringify(d.headers)!==JSON.stringify(m.headers)) throw Error('已保存批次表头不一致');
    for(const r of d.rows) {
      const ut=r[d.utCol]; if(seen.has(ut)) throw Error('已保存批次重叠：'+ut);seen.add(ut);
    }
  }
  return seen;
}
async function run(config,options={}) {
  const c=validateConfig(config);
  const out=path.resolve(options.out);
  if(fs.existsSync(out) && !options.resume) throw Error('输出目录已存在。使用新目录，或用 --resume 续传');
  fs.mkdirSync(out,{recursive:true});
  const configFile=path.join(out,'searches.json');
  if(options.resume) {
    if(!fs.existsSync(configFile)||JSON.stringify(JSON.parse(fs.readFileSync(configFile)))!==JSON.stringify(c)) throw Error('续传配置与原检索配置不一致，请使用新输出目录');
  } else saveJSON(configFile,c);
  const statusFile=path.join(out,'status.json');
  let state=fs.existsSync(statusFile)?JSON.parse(fs.readFileSync(statusFile)):{startedAt:new Date().toISOString(),jobs:{}};
  if(options.resume && state.status==='complete') {
    for(const job of c.queries) {
      const directory=path.join(out,'raw',job.id);
      const m=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));
      if(!m.complete || m.query!==job.query) throw Error('完成状态与原始任务不一致');
      verifySaved(m,directory);
    }
    if(state.result.outputCount) UI.fullRecord(fs.readFileSync(state.result.output),state.result.outputCount);
    if(!fs.existsSync(path.join(out,'set-membership.csv'))) throw Error('集合归属文件缺失');
    console.log('此任务已完成；已核对原始批次及合并文件，不重复下载或覆盖。');
    return state;
  }
  state.status='running';delete state.error;saveJSON(statusFile,state);
  const profile=path.resolve(options.profile??path.join(os.homedir(),'.local/share/wos-native-exporter/profile'));
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  const manifests=[];
  let current,context,page;
  const interrupted=()=>{
    state.status='paused';state.error={job:current,message:'用户中断（Ctrl+C）；可用 --resume 继续'};
    saveJSON(statusFile,state);
  };
  process.once('SIGINT',interrupted);
  try {
    context=await chromium.launchPersistentContext(profile,{headless:false,acceptDownloads:true,viewport:{width:1440,height:1000}});
    page=context.pages()[0]??await context.newPage();
    page.setDefaultTimeout(30000);
    for(const job of c.queries) {
      current=job.id;
      const dir=path.join(out,'raw',job.id);fs.mkdirSync(dir,{recursive:true});
      const mf=path.join(dir,'manifest.json');
      let m=fs.existsSync(mf)?JSON.parse(fs.readFileSync(mf)):null;
      if(m&&(m.query!==job.query||m.size!==c.batchSize||m.job!==job.id)) throw Error('已保存任务与当前检索式不一致');
      let seen=m?verifySaved(m,dir):new Set();
      if(m?.complete) {
        console.log(`${job.id}：已核对 ${m.total} 条原始文件，跳过完成任务`);
      } else {
        if(m) {
          console.log(`${job.id}：恢复同一结果集，已保存 ${seen.size}/${m.total}`);
          await page.goto(m.resultURL,{waitUntil:'domcontentloaded'});
          const count=await UI.waitResult(page);
          if(count!==m.total || new URL(page.url()).pathname!==new URL(m.resultURL).pathname) throw Error('原会话结果集已失效或变化。请用新目录重新运行该任务，不混用新旧批次');
        } else {
          console.log(`${job.id}：检索中`);
          const total=await UI.search(page,c.url,job.query);
          m={version:1,job:job.id,name:job.name??job.id,query:job.query,total,size:c.batchSize,headers:null,batches:[],complete:total===0,resultURL:page.url(),qid:page.url().match(/\/summary\/([^/]+)/)?.[1]??'',searchedAt:new Date().toISOString()};
          saveJSON(mf,m);
          console.log(`${job.id}：${total} 条`);
        }
        for(const [start,end] of m.total?C.ranges(m.total,m.size).slice(m.batches.length):[]) {
          console.log(`${job.id}：原生 Excel ${start}–${end}`);
          const result=await UI.exportBatch(page,start,end,dir,`${job.id}_${String(start).padStart(6,'0')}_${String(end).padStart(6,'0')}`,120000,d=>{
            if(m.headers && JSON.stringify(m.headers)!==JSON.stringify(d.headers)) throw Error('不同批次原生字段名称或顺序变化');
            for(const row of d.rows) if(seen.has(row[d.utCol])) throw Error('跨批次重复 UT：'+row[d.utCol]);
          });
          const d=result.data;
          for(const r of d.rows) seen.add(r[d.utCol]);
          m.headers=d.headers;m.batches.push({...result.batch,suggestedFilename:result.suggestedFilename,downloadedAt:new Date().toISOString()});
          m.complete=seen.size===m.total;saveJSON(mf,m);
          state.jobs[job.id]={total:m.total,downloaded:seen.size,complete:m.complete};saveJSON(statusFile,state);
          await sleep(c.delayMs);
        }
      }
      if(!m.complete) throw Error('任务尚未导出完整');
      state.jobs[job.id]={total:m.total,downloaded:m.total,complete:true};saveJSON(statusFile,state);
      if(m.total) manifests.push(mf);
    }
    const output=path.join(out,'WoS-native-merged.xlsx');
    // A failed prior merge does not license overwriting an existing delivery workbook.
    const result=manifests.length?merge(manifests,output):{inputCount:0,outputCount:0,duplicates:0};
    const csv=rows=>'\ufeff'+rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
    const rows=[['UT (Unique WOS ID)','Search sets']];
    if(manifests.length) {
      const provenance=JSON.parse(fs.readFileSync(result.provenance));const membership=new Map();
      for(const s of provenance.sources){if(!membership.has(s.ut))membership.set(s.ut,new Set());membership.get(s.ut).add(s.job);}
      for(const [ut,sets] of membership)rows.push([ut,[...sets].join('; ')]);
    }
    fs.writeFileSync(path.join(out,'set-membership.csv'),csv(rows));
    state={...state,status:'complete',finishedAt:new Date().toISOString(),result};saveJSON(statusFile,state);
    console.log(JSON.stringify(result,null,2));
    return state;
  } catch(e) {
    state.status='paused';state.error={job:current,message:e.message};saveJSON(statusFile,state);
    // No network traces, cookies or credentials in diagnostics. Only the visible page.
    if(page) await page.screenshot({path:path.join(out,'last-page.png')}).catch(()=>{});
    console.error('已暂停，已保存批次保留：'+e.message);
    if(page && options.interactive && process.stdin.isTTY) {
      console.error('如页面要求登录或验证，请在浏览器人工完成。完成后在终端按回车，浏览器将关闭；随后以同一命令加 --resume 继续。');
      const rl=createInterface({input:process.stdin,output:process.stdout});
      await rl.question('');rl.close();
    }
    throw e;
  } finally {process.removeListener('SIGINT',interrupted);if(context) await context.close();}
}
async function main() {
  const {values:v}=parseArgs({options:{config:{type:'string'},out:{type:'string'},profile:{type:'string'},resume:{type:'boolean'},'non-interactive':{type:'boolean'},help:{type:'boolean'}}});
  if(v.help||!v.config||!v.out) {
    console.log('用法：node src/export.cjs --config 检索配置.json --out 新输出目录 [--profile 浏览器配置目录] [--resume] [--non-interactive]\n默认打开可见 Chromium；登录/验证由人工完成。--resume 仅续传相同配置和仍有效的原结果集。');
    if(!v.help)process.exitCode=1;return;
  }
  await run(JSON.parse(fs.readFileSync(v.config,'utf8')),{...v,interactive:!v['non-interactive']});
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run,validateConfig,verifySaved};
