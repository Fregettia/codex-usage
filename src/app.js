import {chartSlot, resetCharts, mountCharts} from './charts.jsx';
'use strict';
const $ = s => document.querySelector(s);
const escape = v => String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => {const v=Number(n)||0,a=Math.abs(v),units=a>=1e9?[1e9,'b']:a>=1e6?[1e6,'m']:a>=1e3?[1e3,'k']:null;return units?new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v/units[0])+units[1]:new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v);};
const exact = n => new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n||0);
const money = n => '$'+new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0);
const pct = (a,b) => b ? (a/b*100).toFixed(1)+'%' : '—';
const COLORS = {'gpt-6-luna':'#5070df','gpt-6-sol':'#8760cf','gpt-5.6-luna':'#8295ed','gpt-5.6-sol':'#b18be4','gpt-6-astra':'#2fb598','gpt-5.6-terra':'#e3a344','gpt-5.5':'#6e9fd1','gpt-5.4':'#d8899e','gpt-5.4-mini':'#a4b87c','codex-auto-review':'#99a2b7'};
const color = m => COLORS[m]||'#b0b6c3';
const names = {'gpt-6-luna':'Luna 6','gpt-6-sol':'Sol 6','gpt-5.6-luna':'Luna 5.6','gpt-5.6-sol':'Sol 5.6','gpt-6-astra':'Astra','gpt-5.6-terra':'Terra','gpt-reserve':'Reserve · Luna','codex-auto-review':'Auto-review','gpt-5.3-codex-spark':'5.3 Codex Spark'};
const name = m => names[m]||m;
const params = new URLSearchParams(location.search);
let range = ['7d','30d','mtd','all'].includes(params.get('range'))?params.get('range'):'mtd';
let tz = params.get('tz')||'Asia/Singapore';
if (![...$('#timezone').options].some(o=>o.value===tz)) tz='Asia/Singapore';
$('#timezone').value=tz;
let page=['/activity','/logs'].includes(location.pathname)?location.pathname.slice(1):'summary', metric='total_tokens', data=null, chartRows=[], sequence=0;
let logPage=1, logLimit=50, logModel='', logDate=params.get('date')||'';
let heatYear=null, heatScale='ln', selectedHeatDate='', heatLogs=null, heatLoading=false, heatSequence=0;
const label = k => ({total_tokens:'Tokens',cost:'Spend',requests:'Requests'}[k]||k);
const value = (n,k=metric)=>k==='cost'?money(n):fmt(n);
const dot = c=>`<i class="swatch" style="background:${c}"></i>`;
const legend = series=>`<div class="legend">${series.map(s=>`<span class="legend-item">${dot(s.color)}${escape(s.label)}</span>`).join('')}</div>`;
function navigate(next, push=true){page=next;if(next!=='logs')logDate='';if(push)history.pushState({},'',`/${page}?range=${range}&tz=${encodeURIComponent(tz)}${logDate?`&date=${logDate}`:''}`);load();}
// Keep daily data for the calendar and logs; chart at weekly resolution for long ranges.
function trendRows(days){
 if(days.length<=90)return days;
 const result=[];
 for(let i=0;i<days.length;i+=7){
  const week=days.slice(i,i+7),row={date:week[0].date,through:week.at(-1).date,models:{}};
  for(const day of week){
   for(const [key,value] of Object.entries(day))if(typeof value==='number')row[key]=(row[key]||0)+value;
   for(const [model,metrics] of Object.entries(day.models)){
    const target=row.models[model]||={};
    for(const [key,value] of Object.entries(metrics))target[key]=(target[key]||0)+value;
   }
  }
  result.push(row);
 }
 return result;
}
const trendCaption=()=>chartRows.length<data.daily.length?' · weekly totals':'';
function spark(key){return chartSlot('spark',{rows:chartRows,metric:key,series:[{label:key,color:'#9c87cc',get:d=>d[key]||0}]},28,'mini-spark');}
function change(key){if(!data.previous)return '全量已记录使用';const a=data.totals[key],b=data.previous[key];if(!b)return a?'前一时段无记录':'暂无变化';const d=(a-b)/b*100;return `<span class="change">${d>=0?'↑':'↓'} ${Math.abs(d).toFixed(1)}%</span> vs previous period`;}
function metrics(){const t=data.totals;return `<div class="metrics">
<section class="card metric"><div class="metric-label">Total tokens <span>◈</span></div><div class="metric-value" title="${exact(t.total_tokens)}">${fmt(t.total_tokens)}</div>${spark('total_tokens')}<div class="metric-sub">${change('total_tokens')}</div></section>
<section class="card metric"><div class="metric-label">API equivalent <span>$</span></div><div class="metric-value">${money(t.cost)}</div>${spark('cost')}<div class="metric-sub">基础单价${t.unpriced_requests?' · 部分模型未定价':' · USD'}</div></section>
<section class="card metric"><div class="metric-label">Requests <span>↗</span></div><div class="metric-value" title="${exact(t.requests)}">${fmt(t.requests)}</div>${spark('requests')}<div class="metric-sub">${change('requests')}</div></section>
<section class="card metric"><div class="metric-label">Cache hit rate <span>⟳</span></div><div class="metric-value">${pct(t.cached_input_tokens,t.input_tokens)}</div><div class="metric-sub">${fmt(t.cached_input_tokens)} / ${fmt(t.input_tokens)} input tokens</div></section></div>`;}
function chart(series,key='total_tokens',height=260,kind='bar'){return chartSlot(kind,{series,metric:key,rows:chartRows},height);}
function modelSeries(key){return data.models.filter(m=>m[key]>0&&(key!=='cost'||m.unpriced_requests<m.requests)).map(m=>({label:name(m.id),color:color(m.id),get:d=>d.models[m.id]?.[key]||0}));}
function topModels(){const models=data.models.filter(m=>m[metric]>0).sort((a,b)=>b[metric]-a[metric]);return `<aside class="top-models"><h2>Top models <span class="caption">by ${label(metric).toLowerCase()}</span></h2><div class="top-models-body">${chartSlot('pie',{series:models.map(m=>({id:m.id,label:name(m.id),value:m[metric],color:color(m.id)})),metric,total:data.totals[metric]},125)}<div class="top-model-list">${models.slice(0,5).map(m=>`<div class="model-row"><div class="model-line"><span class="model-badge" style="color:${color(m.id)}">${escape(name(m.id).slice(0,1).toUpperCase())}</span><span>${escape(name(m.id))}</span><span class="model-num">${value(m[metric])}</span></div><div class="model-meta"><span>${fmt(m.requests)} requests</span><span>${pct(m[metric],data.totals[metric])}</span></div></div>`).join('')}</div></div></aside>`;}
function metricSwitch(){return `<div class="segmented metric-switch">${['total_tokens','cost','requests'].map(k=>`<button data-metric="${k}" class="${k===metric?'selected':''}">${label(k)}</button>`).join('')}</div>`;}
function summary(){const s=modelSeries(metric);return `<section class="card chart-card"><div class="section-title"><h2>Usage overview</h2><div class="chart-toolbar">${metricSwitch()}<a href="/activity" data-page="activity" class="export-link">View activity ↗</a></div></div><div class="summary-chart"><div><div class="big-total">${value(data.totals[metric])}</div><div class="big-caption">${label(metric)} · ${data.start} — ${data.end}${trendCaption()}</div>${chart(s,metric)}${legend(s)}</div>${topModels()}</div></section>${heatmap()}${modelTable()}`;}
function heatmap(){
 const dates=data.calendar, palette=['#f5f6f9','#eef1fc','#dfe5fb','#cbd5fa','#adbef6','#8fa8f1','#708eea','#5876dd','#3f5fc9'];
 const years=[...new Set(dates.map(d=>Number(d.date.slice(0,4))))].sort((a,b)=>b-a);
 if(!years.includes(heatYear))heatYear=years[0];
 const from=`${heatYear}-01-01`, yearEnd=`${heatYear}-12-31`, to=heatYear===Number(data.end.slice(0,4))?data.end:yearEnd;
 const rows=dates.filter(d=>d.date>=from&&d.date<=to);
 const yearIndex=years.indexOf(heatYear);
 const scales=[['normal','Normal'],['ln','ln']];
 const scaleSwitch=`<div class="segmented calendar-scale" aria-label="热力图色阶">${scales.map(([id,text])=>`<button data-heat-scale="${id}" class="${id===heatScale?'selected':''}" aria-pressed="${id===heatScale}">${text}</button>`).join('')}</div>`;
 const controls=`<div class="calendar-controls">${scaleSwitch}<button data-heat-year="${years[yearIndex+1]||''}" ${yearIndex===years.length-1?'disabled':''} aria-label="上一年">←</button><label class="sr-only" for="heat-year">热力图年份</label><select id="heat-year">${years.map(y=>`<option value="${y}" ${y===heatYear?'selected':''}>${y}</option>`).join('')}</select><button data-heat-year="${years[yearIndex-1]||''}" ${yearIndex===0?'disabled':''} aria-label="下一年">→</button></div>`;
 const scaleNote=heatScale==='normal'?'普通线性色阶，按当前年份峰值归一化。':metric==='total_tokens'?'ln 固定强度：10k ≈ 0.1 · 1m ≈ 0.4 · 100m ≈ 0.8 · 1b ≈ 1.0。':'ln 色阶，按当前年份峰值归一化。';
 return `<section class="card chart-card"><div class="section-title"><h2>Activity calendar</h2><div class="chart-toolbar"><span class="caption">${label(metric)} · ${data.timezone}</span>${controls}</div></div><div class="activity-stats"><div class="activity-stat"><label>Longest streak</label><strong>${data.longest_streak}<small>days</small></strong></div><div class="activity-stat"><label>Avg / day</label><strong>${value(data.totals[metric]/data.days)}</strong></div><div class="activity-stat"><label>Avg / week</label><strong>${value(data.totals[metric]/data.days*7)}</strong></div><div class="activity-stat"><label>Active days</label><strong>${data.active_days}<small>/ ${data.days} days</small></strong></div></div><div class="heat-scroll">${chartSlot('calendar',{rows,metric,from,to,scaleType:heatScale,onDayClick:loadHeatLogs},230,'calendar-chart')}</div><div class="heat-footer"><span>零用量显示浅底色；${scaleNote} 点击有用量的日期查看请求。</span><div class="heat-key"><em>0</em>${palette.map(c=>`<span style="background:${c}"></span>`).join('')}<em>1.0</em></div></div><div id="heat-day-logs">${heatLogsPanel()}</div></section>`;
}
function heatLogsPanel(){
 if(heatLoading)return `<div class="heat-log-panel loading">正在读取 ${escape(selectedHeatDate)} 的请求…</div>`;
 if(!selectedHeatDate||!heatLogs)return `<div class="heat-log-panel empty-log">点击热力图中有用量的一天，查看当天的请求记录。</div>`;
 if(heatLogs.error)return `<div class="heat-log-panel error">读取失败：${escape(heatLogs.error)}</div>`;
 const l=heatLogs.logs, time=t=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(t));
 const rows=l.items.map(r=>`<tr><td><time datetime="${escape(r.timestamp)}">${time(r.timestamp)}</time></td><td><span class="table-model">${dot(color(r.model))}${escape(name(r.model))}</span></td><td>${exact(r.input_tokens)}</td><td>${exact(r.cached_input_tokens)}</td><td>${exact(r.output_tokens)}</td><td>${exact(r.reasoning_output_tokens)}</td><td>${preciseMoney(r.cost)}</td></tr>`).join('');
 return `<div class="heat-log-panel"><div class="heat-log-heading"><div><h3>${escape(selectedHeatDate)} <span>${exact(l.total)} requests</span></h3><p>按时间倒序显示当天前 ${Math.min(25,l.total)} 条请求</p></div><button data-open-day-logs>查看全部 logs →</button></div><div class="table-wrap"><table class="heat-log-table"><thead><tr><th>Time</th><th>Model</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function updateHeatLogs(){const panel=$('#heat-day-logs');if(panel)panel.innerHTML=heatLogsPanel();}
async function loadHeatLogs(day){
 const id=++heatSequence;selectedHeatDate=day;heatLogs=null;heatLoading=true;updateHeatLogs();
 try{const res=await fetch(`/api/logs?range=all&tz=${encodeURIComponent(tz)}&date=${day}&page=1&limit=25`);const result=await res.json();if(!res.ok)throw new Error(result.error||'无法读取请求');if(id!==heatSequence)return;heatLogs=result;}
 catch(e){if(id!==heatSequence)return;heatLogs={error:e.message};}
 finally{if(id===heatSequence){heatLoading=false;updateHeatLogs();}}
}
function activity(){const models=modelSeries(metric),req=modelSeries('requests'), breakdown=[{label:'Prompt',color:'#5a83ed',get:d=>d.input_tokens},{label:'Completion',color:'#a574df',get:d=>d.output_tokens-d.reasoning_output_tokens},{label:'Reasoning',color:'#e78b9c',get:d=>d.reasoning_output_tokens}],caching=[{label:'Cached',color:'#73aa99',get:d=>d.cached_input_tokens},{label:'Uncached',color:'#bbc4d4',get:d=>d.uncached_input_tokens}],cost=modelSeries('cost');
 return `<section class="card chart-card"><div class="section-title"><h2>Usage by model <span class="caption">${chartRows.length<data.daily.length?'weekly':'daily'}</span></h2>${metricSwitch()}</div>${chart(models,metric,280,'line')}${legend(models)}</section><div class="chart-grid"><section class="card"><div class="section-title"><h2>API equivalent ${chartRows.length<data.daily.length?'by week':'by day'}</h2><span class="pill">USD · 基础单价</span></div>${chart(cost,'cost')}${legend(cost)}</section><section class="card"><div class="section-title"><h2>Request volume</h2><span class="caption">by model${trendCaption()}</span></div>${chart(req,'requests')}${legend(req)}</section><section class="card"><div class="section-title"><h2>Token breakdown</h2><span class="caption">${fmt(data.totals.total_tokens)} tokens${trendCaption()}</span></div>${chart(breakdown)}${legend(breakdown)}</section><section class="card"><div class="section-title"><h2>Prompt caching</h2><span class="pill">${pct(data.totals.cached_input_tokens,data.totals.input_tokens)} hit rate${trendCaption()}</span></div>${chart(caching)}${legend(caching)}</section></div>${heatmap()}${modelTable()}`;
}
function modelTable(){return `<section class="card"><div class="section-title"><h2>Model breakdown</h2><button class="link-button" id="export">Export CSV ↓</button></div><div class="table-wrap"><table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Uncached input</th><th>Output</th><th>Reasoning ⓘ</th><th>Requests</th><th>Cache hit</th><th>API equiv.</th></tr></thead><tbody>${data.models.filter(m=>m.requests>0).map(m=>`<tr><td><span class="table-model">${dot(color(m.id))}<span title="${escape(m.id)}">${escape(name(m.id))}</span></span></td>${['input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','reasoning_output_tokens','requests'].map(k=>`<td title="${exact(m[k])}">${fmt(m[k])}</td>`).join('')}<td>${pct(m.cached_input_tokens,m.input_tokens)}</td><td>${m.unpriced_requests===m.requests?'<span class="muted">未定价</span>':money(m.cost)}</td></tr>`).join('')}</tbody></table></div><div class="detail-note">Input 包含 Cached input；Output 包含 Reasoning。Total = Input + Output，不重复累加子项。请求数为去重后的用量事件数。</div></section>`;}
function methodology(){const p=data.pricing;return `<details class="card details"><summary>统计口径与价格依据</summary><p>${escape(p.note)}</p><p>价格核对日期：${p.as_of}。公式：(未缓存输入 − 缓存写入) × input + 缓存写入 × cache write + 缓存命中 × cached + 输出 × output，均除以 1,000,000。Reasoning 不额外计费；未公布独立 cache write 单价时按普通 input 费率估算。模型别名 gpt-5.6 归入 Sol 5.6、gpt-5.0 归入 GPT-5；gpt-reserve 按 Luna 5.6、5.3 Codex Spark 按 GPT-5.3-Codex 计价。Auto-review 在 ${escape(p.temporal_aliases['codex-auto-review'].from)} 前按 5.4 Mini，之后按 Luna 5.6；切换时间来自用户提供的公告；可在 pricing.json 修改。原始模型名称保留在明细中。</p><div class="table-wrap"><table class="pricing-table"><thead><tr><th>Model · 官方来源</th><th>Input / 1M</th><th>Cached / 1M</th><th>Cache write / 1M</th><th>Output / 1M</th></tr></thead><tbody>${Object.entries(p.models).map(([m,r])=>`<tr><td><a href="${escape(p.source_overrides?.[m]||p.source_base+m)}" target="_blank" rel="noreferrer">${escape(m)} ↗</a></td><td>$${r.input}</td><td>$${r.cached}</td><td>${r.cache_write==null?'—':'$'+r.cache_write}</td><td>$${r.output}</td></tr>`).join('')}</tbody></table></div><p>按所选时区划分自然日。7d / 30d 包含今天；MTD 为本月至今；All 从首个用量事件算至今天。周均 = 日均 × 7。重复累计计数不计为新请求；复制到分叉文件的相同时间、模型与用量事件去重。日志缺失或未记录的请求无法恢复，工具调用数量不等于模型请求数。</p><p>扫描 ${data.scan.files} 个文件 · 去除 ${data.scan.duplicates_removed} 条跨文件重复事件 · 跳过 ${data.scan.malformed_lines} 条异常用量/元数据行。${data.scan.errors.length?'文件读取异常：'+escape(data.scan.errors.join('; ')):'日志仅读取；缓存仅包含用量、时间、模型及扫描位置。'}</p></details>`;}
function render(){
 $('#page-title').textContent=page==='logs'?'Logs':page==='summary'?'Usage summary':'Activity';
 $('#page-description').textContent=page==='logs'?'逐条查看请求消耗、缓存命中与 API 等效花费。':page==='summary'?'了解你的 Codex 使用习惯与模型分布。':'按日追踪模型用量、请求与 prompt caching。';
 document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===page));
 document.querySelectorAll('[data-range]').forEach(b=>{b.classList.toggle('selected',b.dataset.range===range);b.setAttribute('aria-pressed',b.dataset.range===range);});
 if(!data)return;
 $('#date-label').textContent=`${data.start} — ${data.end}`;
 const warnings=[];
 if(data.totals.unpriced_requests)warnings.push(`${exact(data.totals.unpriced_requests)} 个请求的模型没有公开单价，已计入 tokens 与 requests，未计入 API 等效。`);
 if(data.scan.errors.length)warnings.push(`${data.scan.errors.length} 个日志文件读取失败，统计可能不完整，见页面底部详情。`);
 $('#notice').hidden=!warnings.length;$('#notice').textContent=warnings.join(' ');$('#notice').className='notice';
 resetCharts();
 $('#content').innerHTML=(page==='logs'?'':metrics())+(data.totals.requests?'':`<div class="empty">这段时间还没有使用记录。试试 All，或确认日志目录中存在 rollout 文件。</div>`)+(page==='logs'?logsView():page==='summary'?summary():activity())+methodology();
 mountCharts();
 $('#scan-label').textContent=`${data.scan.files} rollout files · ${data.scan.changed_files} updated · ${(data.scan.bytes_read/1e6).toFixed(2)} MB read · ${data.scan.duration_ms} ms`;
 $('#content').setAttribute('aria-busy','false');
}
async function load(refresh=false){const id=++sequence;$('#content').setAttribute('aria-busy','true');$('#refresh').disabled=true;try{const res=await fetch(`/api/${page==='logs'?'logs':'usage'}?range=${range}&tz=${encodeURIComponent(tz)}${page==='logs'?`&page=${logPage}&limit=${logLimit}&model=${encodeURIComponent(logModel)}&date=${encodeURIComponent(logDate)}`:''}${refresh?'&refresh=1':''}`);const result=await res.json();if(!res.ok)throw new Error(result.error||'无法读取数据');if(id!==sequence)return;data=result;chartRows=trendRows(data.daily);render();}catch(e){if(id!==sequence)return;$('#notice').hidden=false;$('#notice').className='notice error';$('#notice').textContent=`读取失败：${e.message}。请确认本地服务正在运行，然后点击刷新重试。`;$('#content').setAttribute('aria-busy','false');}finally{if(id===sequence)$('#refresh').disabled=false;}}
function exportCSV(){const keys=['id','input_tokens','cached_input_tokens','uncached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','requests','cost'];const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';const csv=[keys,...data.models.map(m=>keys.map(k=>k==='cost'&&m.unpriced_requests===m.requests?'':m[k]))].map(r=>r.map(cell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`codex-usage-${data.start}-${data.end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
document.addEventListener('click',e=>{const p=e.target.closest('[data-page]'),r=e.target.closest('[data-range]'),m=e.target.closest('[data-metric]'),y=e.target.closest('[data-heat-year]'),s=e.target.closest('[data-heat-scale]'),open=e.target.closest('[data-open-day-logs]');if(p){e.preventDefault();navigate(p.dataset.page);}if(r){logPage=1;logDate='';range=r.dataset.range;history.replaceState({},'',`/${page}?range=${range}&tz=${encodeURIComponent(tz)}`);load();}if(m){metric=m.dataset.metric;render();}if(y&&y.dataset.heatYear){heatYear=Number(y.dataset.heatYear);selectedHeatDate='';heatLogs=null;render();}if(s){heatScale=s.dataset.heatScale;render();}if(open){page='logs';range='all';logDate=selectedHeatDate;logPage=1;history.pushState({},'',`/logs?range=all&tz=${encodeURIComponent(tz)}&date=${logDate}`);load();}if(e.target.closest('#export'))exportCSV();});
$('#refresh').onclick=()=>load(true);
$('#timezone').onchange=e=>{logPage=1;tz=e.target.value;history.replaceState({},'',`/${page}?range=${range}&tz=${encodeURIComponent(tz)}`);load();};
window.onpopstate=()=>{const p=new URLSearchParams(location.search);range=p.get('range')||'mtd';tz=p.get('tz')||'Asia/Singapore';logDate=p.get('date')||'';$('#timezone').value=tz;page=['/activity','/logs'].includes(location.pathname)?location.pathname.slice(1):'summary';load();};
function tooltip(e){const target=e.target.closest('[data-tip]');const tip=$('#tooltip');if(!target){tip.hidden=true;return;}tip.textContent=target.dataset.tip;tip.hidden=false;const rect=target.getBoundingClientRect();const x=e.clientX??rect.x,y=e.clientY??rect.y;tip.style.left=Math.min(x+14,innerWidth-tip.offsetWidth-12)+'px';tip.style.top=Math.min(y+14,innerHeight-tip.offsetHeight-12)+'px';}
document.addEventListener('pointermove',tooltip);document.addEventListener('focusin',tooltip);document.addEventListener('focusout',()=>$('#tooltip').hidden=true);document.addEventListener('scroll',()=>$('#tooltip').hidden=true,true);

const preciseMoney=n=>n==null?'未定价':'$'+n.toFixed(6);
function logsView(){
 const l=data.logs;if(!l)return '<div class="empty">正在加载请求…</div>';
 logPage=l.page;
 const time=t=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(t));
 const rows=l.items.map((r,i)=>`<tr>
 <td><button class="request-toggle" data-request="${i}" aria-expanded="false" aria-controls="request-${i}">＋ <time datetime="${escape(r.timestamp)}">${time(r.timestamp)}</time></button></td>
 <td><span class="table-model" title="${escape(r.model)}">${dot(color(r.model))}${escape(name(r.model))}</span></td>
 ${['input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].map(k=>`<td>${exact(r[k])}</td>`).join('')}
 <td>${pct(r.cached_input_tokens,r.input_tokens)}</td><td class="request-cost">${preciseMoney(r.cost)}</td></tr>
 <tr id="request-${i}" class="request-detail" hidden><td colspan="10"><div class="request-detail-grid"><div><h3>Request details</h3><p>模型：${escape(r.model)}<br>计价模型：${escape(r.priced_as||'未定价')}<br>UTC：${escape(r.timestamp)}<br>Total tokens：${exact(r.total_tokens)}<br>Cache write tokens：${exact(r.cache_write_input_tokens)}</p></div><div><h3>Cost breakdown · USD</h3>${r.costs?`<p>Uncached input：${preciseMoney(r.costs.input)}<br>Cached input：${preciseMoney(r.costs.cached)}<br>Cache writes：${preciseMoney(r.costs.cache_write)}<br>Output（含 reasoning）：${preciseMoney(r.costs.output)}</p>`:'<p>此模型未配置单价，用量照常计入。</p>'}</div><div><h3>Source</h3><p class="source-file">${escape(r.source)}</p><p>字节位置：${exact(r.byte_offset)}<br>事件 ID：${r.id.slice(0,16)}</p></div></div></td></tr>`).join('');
 return `<section class="card logs-card"><div class="section-title"><div><h2>Requests <span class="caption">${exact(l.total)} records</span></h2><p>${logDate?`${escape(logDate)} · `:''}按时间倒序 · ${tz} · 每条为去重后的用量事件</p></div><div class="chart-toolbar"><label class="sr-only" for="log-date">筛选日期</label><input id="log-date" type="date" value="${escape(logDate)}" max="${escape(data.end)}"><button class="clear-date" data-clear-log-date ${logDate?'':'hidden'}>清除日期</button><label class="sr-only" for="log-model">筛选模型</label><select id="log-model"><option value="">All models</option>${l.available_models.map(m=>`<option value="${escape(m)}" ${m===logModel?'selected':''}>${escape(name(m))}</option>`).join('')}</select><label class="sr-only" for="log-limit">每页条数</label><select id="log-limit">${[25,50,100].map(n=>`<option value="${n}" ${n===logLimit?'selected':''}>${n} / page</option>`).join('')}</select></div></div>
 ${logDate?'':`<div class="logs-chart">${chart([{label:'Requests',color:'#35b782',get:d=>d.requests}],'requests',160)}</div>`}
 <div class="table-wrap"><table class="logs-table"><thead><tr><th>Date</th><th>Model</th><th>Input</th><th>Cached input</th><th>Uncached</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Cache hit</th><th>Cost · USD</th></tr></thead><tbody>${rows||'<tr><td colspan="10" class="empty">没有匹配的请求，请调整时间范围或模型。</td></tr>'}</tbody></table></div>
 <div class="logs-pagination"><span>${l.total?exact((l.page-1)*l.limit+1):0}–${exact(Math.min(l.page*l.limit,l.total))} of ${exact(l.total)} requests</span><div><button data-log-page="${l.page-1}" ${l.page<=1?'disabled':''}>← Previous</button><span>${l.page} / ${l.pages}</span><button data-log-page="${l.page+1}" ${l.page>=l.pages?'disabled':''}>Next →</button></div></div></section><p class="detail-note">点击请求时间展开来源与费用拆分。所有 token 显示精确整数；费用保留 6 位小数。Cached 属于 Input，Reasoning 属于 Output，不重复相加。费用为基础单价 API 等效。</p>`;
}
document.addEventListener('change',e=>{if(e.target.id==='log-model'){logModel=e.target.value;logPage=1;load();}if(e.target.id==='log-limit'){logLimit=Number(e.target.value);logPage=1;load();}if(e.target.id==='log-date'){logDate=e.target.value;logPage=1;history.replaceState({},'',`/logs?range=${range}&tz=${encodeURIComponent(tz)}${logDate?`&date=${logDate}`:''}`);load();}if(e.target.id==='heat-year'){heatYear=Number(e.target.value);selectedHeatDate='';heatLogs=null;render();}});
document.addEventListener('click',e=>{const p=e.target.closest('[data-log-page]'),r=e.target.closest('[data-request]'),clear=e.target.closest('[data-clear-log-date]');if(p){logPage=Number(p.dataset.logPage);load();}if(r){const detail=$('#request-'+r.dataset.request);detail.hidden=!detail.hidden;r.setAttribute('aria-expanded',!detail.hidden);}if(clear){logDate='';logPage=1;history.replaceState({},'',`/logs?range=${range}&tz=${encodeURIComponent(tz)}`);load();}});
render();load();
