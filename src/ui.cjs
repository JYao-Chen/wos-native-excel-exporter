'use strict';
// Locators observed on the actual English WoS Core Collection UI, 2026-09-10.
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout:sleep}=require('node:timers/promises');
const C = require('./core.cjs');
const X = require('../vendor/xlsx.cjs');
const groups = ['authorTitleSource','abstractKeywordAddress','citedRefUse','fundingOther'];

function resultCount(text) {
  const m = text.match(/^\s*([\d,]+) results? from Web of Science Core Collection for:/i);
  if (!m) throw Error('检索结果标题格式变化，停止而不推测数量：' + text);
  const n = Number(m[1].replaceAll(',',''));
  if (!Number.isSafeInteger(n) || n < 0) throw Error('结果数不合法');
  return n;
}
function fullRecord(bytes, expected) {
  const data = C.inspect(X, bytes, expected);
  for (const h of ['Cited References','Funding Text','Affiliations','Keywords Plus','Document Type','DOI']) {
    if (!data.headers.includes(h)) throw Error('网页未导出全部字段，缺少：' + h);
  }
  return data;
}
async function dismissCookie(page) {
  const banner = page.getByRole('dialog', {name:'您必须与横幅进行交互才能将其关闭。'});
  if (await banner.isVisible()) await banner.getByRole('button',{name:'关闭',exact:true}).click();
}
async function waitResult(page, timeout = 90000) {
  const heading = page.getByRole('heading',{name:/^[\d,]+ results? from Web of Science Core Collection for:/i});
  // A missing result heading is NOT a zero result. Only the actual WoS zero-result notice counts.
  const zero = page.getByText('Your search found no results', {exact:true});
  const error=page.getByText('An unknown error has occurred.',{exact:true});
  await heading.or(zero).or(error).first().waitFor({state:'visible', timeout});
  if(await error.isVisible()) throw Error('WoS显示服务器错误页；未计为零结果，请稍后续传');
  if (await heading.isVisible()) return resultCount(await heading.innerText());
  return 0;
}
async function search(page, url, query) {
  await page.goto(url, {waitUntil:'domcontentloaded'});
  const input = page.getByRole('textbox',{name:'Query Preview',exact:true});
  const error=page.getByText('An unknown error has occurred.',{exact:true});
  for(let attempt=0;attempt<3;attempt++) {
    await input.or(error).first().waitFor({state:'visible',timeout:90000});
    if(await input.isVisible()) break;
    const temporary=/\b50[234]\b/.test(await page.locator('body').innerText());
    if(!temporary || attempt===2) throw Error('WoS高级检索页加载失败；请稍后续传');
    console.log('WoS临时服务器错误，等待后重载高级检索页（'+(attempt+1)+'/2）');
    await sleep(5000*(attempt+1));
    await page.goto(url,{waitUntil:'domcontentloaded'});
  }
  await dismissCookie(page);
  await input.fill(query);
  if (await input.inputValue() !== query) throw Error('检索式写入不一致');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  return waitResult(page);
}
async function prepareExport(page, start, end) {
  // Open the real native export UI, not a replayed internal API request.
  await page.getByRole('region',{name:'summaryRecordsTop',exact:true})
    .getByRole('button').filter({hasText:/Export/}).click();
  await page.getByRole('menuitem',{name:'Excel',exact:true}).click();
  const heading=page.getByRole('heading',{name:'Export Records to Excel',exact:true});
  await heading.waitFor({state:'visible'});
  await page.getByRole('radio',{name:'Records from:',exact:true}).check();
  const from=page.getByRole('spinbutton',{name:'Input starting record range',exact:true});
  const to=page.getByRole('spinbutton',{name:/^Input ending record range\./});
  const label=await to.getAttribute('aria-label');
  const maximum=label?.match(/maximum of ([\d,]+) records/i);
  if (!maximum) throw Error('页面未显示单批导出上限，请核实导出窗口');
  if(end-start+1>Number(maximum[1].replaceAll(',',''))) throw Error('批次大小超过页面当前上限：'+maximum[1]);
  await from.fill(String(start)); await to.fill(String(end));
  await to.press('Tab');
  if(await from.inputValue()!==String(start) || await to.inputValue()!==String(end)) throw Error('网页更改了记录范围，停止导出');
  await page.getByRole('combobox',{name:/^Filter by,/}).click();
  const edit=page.getByRole('option',{name:/^Custom selection/}).getByRole('button',{name:'Edit',exact:true});
  try {await edit.waitFor({state:'visible',timeout:15000});}
  catch(e) {
    if(e.name!=='TimeoutError') throw e;
    const error=Error('WoS未加载自定义字段选项，未执行下载');error.code='FIELDS_NOT_READY';throw error;
  }
  await edit.click();
  // The website resets custom fields for each batch. Select all four groups EVERY time.
  for(const name of groups) {
    const box=page.getByRole('checkbox',{name,exact:true});
    if(await box.evaluate(e => e.indeterminate || e.getAttribute('aria-checked')==='mixed') || !await box.isChecked()) await box.click();
  }
  for(const name of groups) {
    const boxes=page.getByRole('checkbox',{name:new RegExp('^'+name+'(?:_|$)')});
    for(const box of await boxes.all()) {
      if(!await box.isChecked() || await box.evaluate(e => e.indeterminate || e.getAttribute('aria-checked')==='mixed'))
        throw Error('完整字段未全选：'+await box.getAttribute('aria-label'));
    }
  }
  await page.getByRole('button',{name:'Save selections',exact:true}).click();
  const choice=page.getByRole('combobox',{name:/^Filter by,/});
  if(!/Custom selection/.test(await choice.innerText())) throw Error('网页未保存自定义完整字段');
}
async function exportBatch(page, start, end, directory, stem, timeout=120000, validate=()=>{}) {
  for(let attempt=0;attempt<2;attempt++) {
    try {await prepareExport(page,start,end);break;}
    catch(e) {
      if(e.code!=='FIELDS_NOT_READY' || attempt===1) throw e;
      console.log('WoS字段选项未加载，重载原结果页后重试一次（尚未执行下载）');
      const url=page.url().replace(/\(overlay:export\/exc\)$/,'');
      await sleep(3000);
      await page.goto(url,{waitUntil:'domcontentloaded'});
      await waitResult(page);
    }
  }
  const heading=page.getByRole('heading',{name:'Export Records to Excel',exact:true});
  // Listener registered BEFORE the click; original download bytes are never reconstructed.
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout}),
    page.locator('#exportButton').click(),
  ]);
  fs.mkdirSync(directory,{recursive:true});
  const staging=path.join(directory,stem+'.part');
  await download.saveAs(staging);
  const error=await download.failure();
  if(error) throw Error('下载失败：'+error);
  const data=fullRecord(fs.readFileSync(staging),end-start+1);
  const file=stem+'.'+data.extension;
  if(fs.existsSync(path.join(directory,file))) throw Error('目标批次已存在，停止覆盖：'+file);
  validate(data);
  // Success also requires the native export window to finish, not just a download event.
  await heading.waitFor({state:'hidden',timeout:30000});
  fs.renameSync(staging,path.join(directory,file));
  return {data,batch:{start,end,file,rows:data.rows.length},suggestedFilename:download.suggestedFilename()};
}
module.exports={resultCount,fullRecord,waitResult,search,exportBatch,groups};
