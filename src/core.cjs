/* Shared native Excel validation. No TXT parsing or header renaming. */
(function (root) {
  'use strict';
  const key = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const blank = v => v === null || v === undefined || v === '';
  function ranges(total, size) {
    if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(size) || size < 1)
      throw Error('记录总数和批次大小必须是正整数');
    return Array.from({length: Math.ceil(total / size)}, (_, i) => [i * size + 1, Math.min(total, (i + 1) * size)]);
  }
  function inspect(XLSX, bytes, expected) {
    const a = new Uint8Array(bytes);
    const zip = a[0] === 0x50 && a[1] === 0x4b && a[2] === 3 && a[3] === 4;
    const ole = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((v,i) => a[i] === v);
    if (!zip && !ole) throw Error('响应不是原生 XLS/XLSX（二进制签名不符）；可能是登录页、验证页或接口错误');
    const book = XLSX.read(a, {type:'array', cellDates:false, cellFormula:true, cellNF:true});
    if (book.SheetNames.length !== 1) throw Error('预期单表原生导出；收到多表文件，请核实来源');
    const sheet = book.Sheets[book.SheetNames[0]];
    const bounds=XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if(bounds.s.r!==0 || bounds.s.c!==0) throw Error('原生表头应从 A1 开始');
    const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:null, raw:true, blankrows:true});
    while(rows.length && rows[rows.length-1].every(blank)) rows.pop();
    const headers = rows.shift();
    if (!headers || headers.some(v => typeof v !== 'string' || !v.trim()) || new Set(headers).size !== headers.length)
      throw Error('原生表头为空或重复');
    const ks = headers.map(key);
    if (headers.some(h => h.includes('_')) || ['id','project','category','isdownpdf','fulltextuuid','filename'].some(h=>ks.includes(h)))
      throw Error('发现后加工表头/项目字段，请提供未经整理的 WoS Excel 批次');
    for (const required of ['publicationtype','articletitle','authors','abstract','authorkeywords'])
      if (!ks.includes(required)) throw Error('缺少完整记录字段：' + required);
    const utCol = ks.findIndex(k => k === 'utuniquewosid' || k === 'utwosaccessionnumber');
    if (utCol < 0) throw Error('缺少原生 UT 标识列');
    const seen = new Set();
    for (const [i,row] of rows.entries()) {
      if(row.every(blank)) throw Error('记录中间出现空行');
      const ut = String(row[utCol] ?? '').trim();
      if (!/^WOS:\S+$/.test(ut)) throw Error(`第 ${i+2} 行 UT 缺失或格式错误`);
      if (seen.has(ut)) throw Error('同一批次重复 UT：' + ut);
      seen.add(ut);
    }
    if (expected !== undefined && rows.length !== expected)
      throw Error(`批次缺失或范围错误：应有 ${expected} 条，实际 ${rows.length} 条`);
    return {book, sheet, headers, rows, utCol, extension:zip?'xlsx':'xls'};
  }
  // Narrowly normalizes prose only when explicitly requested. Raw batches stay unchanged.
  function prose(value) {
    return typeof value === 'string' ? value.replace(/[\t ]*\r?\n[\t ]*/g, ' ') : value;
  }
  function payload(body, start, end) {
    const p = JSON.parse(body);
    if (!Object.hasOwn(p,'markFrom') || !Object.hasOwn(p,'markTo')) throw Error('请求没有记录起止范围');
    p.markFrom = typeof p.markFrom === 'number' ? start : String(start);
    p.markTo = typeof p.markTo === 'number' ? end : String(end);
    return JSON.stringify(p);
  }
  const api = {key, blank, ranges, inspect, prose, payload};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WosNative = api;
})(globalThis);
