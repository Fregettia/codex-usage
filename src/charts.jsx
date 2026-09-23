import React from 'react';
import {createRoot} from 'react-dom/client';
import {ResponsiveBar} from '@nivo/bar';
import {ResponsiveLine} from '@nivo/line';
import {ResponsivePie} from '@nivo/pie';
import {ResponsiveCalendar} from '@nivo/calendar';
let charts=[], roots=[];
const theme={text:{fontFamily:'Inter, -apple-system, BlinkMacSystemFont, sans-serif',fontSize:11,fill:'#8991a2'},axis:{ticks:{line:{stroke:'transparent'},text:{fill:'#8991a2'}}},grid:{line:{stroke:'#eef0f5',strokeDasharray:'3 4'}},tooltip:{container:{background:'#fff',color:'#30374a',fontSize:12,borderRadius:10,boxShadow:'0 5px 24px #25304d20',padding:'12px 16px'}}};
const compact=n=>{const v=Number(n)||0,a=Math.abs(v),units=a>=1e9?[1e9,'b']:a>=1e6?[1e6,'m']:a>=1e3?[1e3,'k']:null;return units?new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(v/units[0])+units[1]:new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(v)};
const display=(n,key)=>key==='cost'?'$'+Number(n).toFixed(4):Number(n).toLocaleString('en-US');
export function resetCharts(){roots.forEach(r=>r.unmount());roots=[];charts=[];}
export function chartSlot(kind,props,height=260,extra=''){const id='nivo-'+charts.length;charts.push({id,kind,props});return `<div id="${id}" class="nivo-chart ${extra}" style="height:${height}px" role="img" aria-label="${kind} usage visualization"></div>`;}
function Tip({title,items}){return <div style={theme.tooltip.container}><strong>{title}</strong>{items.map((x,i)=><div key={i} style={{display:'flex',gap:16,justifyContent:'space-between',marginTop:7}}><span><span style={{color:x.color}}>● </span>{x.label}</span><b>{x.value}</b></div>)}</div>}
function Chart({kind,props:p}){
 const common={theme,animate:false};
 if(kind==='calendar'){
  const rawByDay=new Map(p.rows.map(d=>[d.date,d[p.metric]||0]));
  const maxRaw=Math.max(1,...p.rows.map(d=>d[p.metric]||0));
  const tokenLn=v=>{
   if(v<=10000)return .1*Math.log1p(v)/Math.log1p(10000);
   if(v<=1000000)return .1+.3*(Math.log(v)-Math.log(10000))/(Math.log(1000000)-Math.log(10000));
   if(v<=100000000)return .4+.4*(Math.log(v)-Math.log(1000000))/(Math.log(100000000)-Math.log(1000000));
   if(v<=1000000000)return .8+.2*(Math.log(v)-Math.log(100000000))/(Math.log(1000000000)-Math.log(100000000));
   return 1;
  };
  const scale=p.scaleType==='normal'?v=>v/maxRaw:p.metric==='total_tokens'?tokenLn:v=>Math.log1p(v)/Math.log1p(maxRaw);
  const calendarData=p.rows.filter(d=>(d[p.metric]||0)>0).map(d=>({day:d.date,value:scale(d[p.metric])}));
  return <ResponsiveCalendar {...common} data={calendarData} from={p.from} to={p.to} emptyColor="#f5f6f9" colors={['#eef1fc','#dfe5fb','#cbd5fa','#adbef6','#8fa8f1','#708eea','#5876dd','#3f5fc9']} minValue={0} maxValue={1} margin={{top:64,right:20,bottom:10,left:35}} yearSpacing={35} monthBorderColor="#fff" dayBorderWidth={1} dayBorderColor="#fff" onClick={d=>p.onDayClick?.(d.day)} tooltip={d=>{const raw=rawByDay.get(d.day)||0;return <Tip title={d.day} items={[{label:p.metric,value:p.metric==='total_tokens'?compact(raw):display(raw,p.metric),color:d.color}]}/>}}/>;
 }
 if(kind==='pie')return <ResponsivePie {...common} data={p.series.filter(s=>s.value>0)} margin={{top:12,right:12,bottom:12,left:12}} innerRadius={.76} padAngle={2} cornerRadius={3} colors={d=>d.data.color} enableArcLabels={false} enableArcLinkLabels={false} activeOuterRadiusOffset={5} tooltip={({datum})=><Tip title={datum.label} items={[{label:p.metric,value:display(datum.value,p.metric),color:datum.color},{label:'Share',value:(datum.value/p.total*100).toFixed(1)+'%',color:datum.color}]}/>}/>;
 const series=p.series||[],rows=p.rows||[],ticks=rows.filter((_,i)=>i%Math.max(1,Math.ceil(rows.length/6))===0).map(d=>d.date);
 const dates=new Map(rows.map(d=>[d.date,d.through&&d.through!==d.date?`${d.date} – ${d.through}`:d.date]));
 const axes={axisBottom:{tickSize:0,tickPadding:12,tickValues:ticks,format:v=>v.slice(5).replace('-','/')},axisLeft:{tickSize:0,tickPadding:10,tickValues:4,format:n=>p.metric==='cost'?'$'+compact(n):compact(n)}};
 if(kind==='line'||kind==='spark')return <ResponsiveLine {...common} {...axes} data={series.map(s=>({id:s.label,color:s.color,data:rows.map(d=>({x:d.date,y:s.get(d)}))}))} colors={d=>d.color} margin={kind==='spark'?{top:3,right:2,bottom:3,left:2}:{top:15,right:20,bottom:35,left:60}} xScale={{type:'point'}} yScale={{type:'linear',min:0,max:'auto',stacked:false}} axisBottom={kind==='spark'?null:axes.axisBottom} axisLeft={kind==='spark'?null:axes.axisLeft} enableGridX={false} enableGridY={kind!=='spark'} enablePoints={false} lineWidth={kind==='spark'?1.8:2.3} curve="monotoneX" enableArea={kind==='spark'} areaOpacity={.08} enableSlices={kind==='spark'?false:'x'} isInteractive={kind!=='spark'} sliceTooltip={({slice})=><Tip title={dates.get(slice.points[0]?.data.x)||slice.points[0]?.data.x} items={slice.points.map(pt=>({label:pt.seriesId,color:pt.seriesColor,value:display(pt.data.y,p.metric)}))}/>}/>;
 return <ResponsiveBar {...common} {...axes} data={rows.map(d=>Object.fromEntries([['date',d.date],...series.map(s=>[s.label,s.get(d)])]))} keys={series.map(s=>s.label)} indexBy="date" margin={{top:15,right:15,bottom:35,left:60}} padding={.32} borderRadius={2} colors={({id})=>series.find(s=>s.label===id)?.color||'#8991a2'} enableLabel={false} enableGridY enableGridX={false} valueScale={{type:'linear',min:0,max:'auto'}} tooltip={({indexValue,data})=><Tip title={dates.get(indexValue)||indexValue} items={series.map(s=>({label:s.label,color:s.color,value:display(data[s.label],p.metric)}))}/>} role="img" ariaLabel="Usage stacked bar chart" isFocusable/>;
}
export function mountCharts(){charts.forEach(({id,kind,props})=>{const el=document.getElementById(id);if(el){const root=createRoot(el);roots.push(root);root.render(<Chart kind={kind} props={props}/>);}});}
