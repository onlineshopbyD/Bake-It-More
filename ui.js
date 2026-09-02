/* ==========================================================================
   Bake It More — UI rendering (shared chart/table components + 4 views)
   Consumes globals SALES, FIN, INVENTORY, INV_SCORECARD, INV_PLATFORM, PRICELIST
   populated by renderAll() from the live-parsed data in app.js.
   ========================================================================== */

const ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V10M12 19V5M20 19v-7"/></svg>',
  inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l9-5 9 5-9 5-9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  pricelist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 12.9 12.7 21a2 2 0 0 1-2.8 0L3.5 14.6a2 2 0 0 1 0-2.8L11.4 3.7a2 2 0 0 1 1.4-.6H19a2 2 0 0 1 2 2v6.4a2 2 0 0 1-.4 1.4Z"/><circle cx="15.5" cy="7.5" r="1.4"/></svg>',
  financials: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2.4"/><circle cx="12" cy="12" r="3"/><path d="M6 6v12M18 6v12"/></svg>',
  platform: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8.5 12h7M8.5 15.5h7M8.5 8.5h3"/></svg>',
};

let SALES=null, FIN=null, INVENTORY=[], INV_SCORECARD={totalValue:0,totalStock:0,outOfStock:0}, INV_PLATFORM={}, PRICELIST=[];

function peso(n, opts){
  opts = opts || {};
  n = n || 0;
  const abs = Math.abs(n);
  let s;
  if(opts.compact && abs >= 1000000){ s = (n/1000000).toFixed(2)+"M"; }
  else if(opts.compact && abs >= 1000){ s = (n/1000).toFixed(1)+"k"; }
  else { const d = opts.decimals !== undefined ? opts.decimals : 0; s = n.toLocaleString("en-PH", {maximumFractionDigits:d, minimumFractionDigits:d}); }
  return "₱" + s;
}
function num(n){ return (n||0).toLocaleString("en-US"); }
function esc(s){ return (s||"").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function kpiGrid(items){
  return `<div class="grid kpi-grid">${items.map(k => `
    <div class="kpi">
      <div class="lbl">${esc(k.label)}</div>
      <div class="val">${k.value}</div>
      ${k.sub ? `<div class="sub ${k.tone||''}">${k.sub}</div>` : ''}
    </div>`).join('')}</div>`;
}
function barList(rows){
  const max = Math.max(...rows.map(r=>Math.abs(r.value)), 1);
  return `<div class="barlist">${rows.map(r => {
    const w = Math.max((Math.abs(r.value)/max*100), r.value===0?0:1.2);
    return `<div class="row" title="${esc(r.label)}: ${esc(r.formatted)}">
      <div class="name">${esc(r.label)}</div>
      <div class="track"><div class="fill" style="width:${w}%;background:${r.color}"></div></div>
      <div class="value">${esc(r.formatted)}</div>
    </div>`;
  }).join('')}</div>`;
}
function divergingBars(rows){
  const max = Math.max(...rows.map(r=>Math.abs(r.value)), 1);
  return `<div class="chart-panel"><div class="divbars">${rows.map(r=>{
    const pct = Math.abs(r.value)/max*50;
    const neg = r.value < 0;
    const color = neg ? 'var(--div-neg)' : 'var(--div-pos)';
    const style = neg ? `right:50%; width:${pct}%;` : `left:50%; width:${pct}%;`;
    return `<div class="drow">
      <div style="color:var(--cv-text-secondary);font-weight:600;">${esc(r.label)}</div>
      <div class="dtrack"><div class="dmid"></div><div class="dfill" style="${style}background:${color}"></div></div>
      <div class="dval" style="color:${color}">${r.value<0?'−':''}${peso(Math.abs(r.value),{compact:true})}</div>
    </div>`;
  }).join('')}</div></div>`;
}
function lineChart(containerId, points){
  const holder = document.getElementById(containerId);
  if(!points.length){ holder.innerHTML = '<div style="padding:20px;color:var(--cv-text-secondary);font-size:12.5px;">No daily data found yet.</div>'; return; }
  const W = 640, H = 200, padL = 46, padR = 14, padT = 14, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxY = Math.max(...points.map(p=>p.y), 1) * 1.12;
  const x = i => padL + (points.length===1 ? innerW/2 : (i/(points.length-1)) * innerW);
  const y = v => padT + innerH - (v/maxY)*innerH;
  let path = points.map((p,i) => (i===0?'M':'L') + x(i).toFixed(1) + ',' + y(p.y).toFixed(1)).join(' ');
  let area = path + ` L${x(points.length-1).toFixed(1)},${(padT+innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT+innerH).toFixed(1)} Z`;
  const gridLines = [0,0.25,0.5,0.75,1].map(f => {
    const yy = padT + innerH * f; const val = maxY * (1-f);
    return `<line class="lc-grid" x1="${padL}" x2="${W-padR}" y1="${yy}" y2="${yy}"/><text class="lc-axis" x="${padL-6}" y="${yy+3}" text-anchor="end">${peso(val,{compact:true})}</text>`;
  }).join('');
  const dots = points.map((p,i) => `<circle class="lc-dot" cx="${x(i)}" cy="${y(p.y)}" r="3" data-i="${i}"/>`).join('');
  holder.innerHTML = `<svg class="linechart" viewBox="0 0 ${W} ${H}" id="${containerId}-svg">${gridLines}<path class="lc-area" d="${area}"/><path class="lc-line" d="${path}"/>${dots}</svg><div class="lc-tip" id="${containerId}-tip"></div>`;
  const svgEl = document.getElementById(containerId+'-svg'), tip = document.getElementById(containerId+'-tip');
  svgEl.querySelectorAll('circle').forEach(c => {
    c.addEventListener('mouseenter', () => {
      const i = +c.getAttribute('data-i'), p = points[i], rect = svgEl.getBoundingClientRect();
      tip.style.left = (rect.width*(x(i)/W))+'px'; tip.style.top = (rect.height*(y(p.y)/H))+'px'; tip.style.opacity = 1;
      tip.textContent = p.label + ': ' + peso(p.y); c.setAttribute('r','4.5');
    });
    c.addEventListener('mouseleave', () => { tip.style.opacity = 0; c.setAttribute('r','3'); });
  });
}

/* ---------------------------------- TABS ---------------------------------- */
const TABS = [
  {id:'overview', label:'Overview'}, {id:'inventory', label:'Inventory'},
  {id:'pricelist', label:'Price List'}, {id:'financials', label:'Financials'},
  {id:'platform', label:'Platform Report'},
];
function buildTabs(){
  ['tabsDesktop','tabsMobile'].forEach(hostId => {
    const host = document.getElementById(hostId);
    host.innerHTML = TABS.map(t => `<button class="tab-btn" data-tab="${t.id}">${ICONS[t.id]}<span>${t.label}</span></button>`).join('');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab'))));
}
let activeTab = 'overview';
function switchTab(id){
  activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab')===id));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-'+id));
  renderActiveTab();
}
function renderActiveTab(){
  if(activeTab==='overview') renderOverview();
  if(activeTab==='inventory') renderInventory();
  if(activeTab==='pricelist') renderPriceList();
  if(activeTab==='financials') renderFinancials();
  if(activeTab==='platform') renderPlatformReport();
}
function renderAll(){
  SALES = window.SALES_LIVE || SALES;
  FIN = window.FIN_LIVE || FIN;
  if(window.INV_LIVE){ INVENTORY = window.INV_LIVE.items; INV_SCORECARD = window.INV_LIVE.scorecard; INV_PLATFORM = window.INV_LIVE.platform; }
  PRICELIST = window.PL_LIVE || PRICELIST;
  if(window.PLATFORM_INCOME_MONTHS && window.PLATFORM_INCOME_MONTHS.length && !platformMonth){
    platformMonth = window.PLATFORM_INCOME_MONTHS[window.PLATFORM_INCOME_MONTHS.length-1];
  }
  renderActiveTab();
}

/* ============================= OVERVIEW / SALES ============================= */
function renderOverview(){
  const v = document.getElementById('view-overview');
  if(!SALES){ v.innerHTML = emptyState('Sales data not loaded yet.'); return; }
  const k = SALES.kpi;
  v.innerHTML = `
    <div class="view-head"><h2>Sales Overview</h2><span class="period">${esc(SALES.period||'')}</span></div>
    ${kpiGrid([
      {label:'Total Sales', value:peso(k.totalSales)},
      {label:'Total Cost', value:peso(k.totalCost)},
      {label:'Net Profit', value:peso(k.netProfit), sub:k.margin+'% margin', tone:'good'},
      {label:'Total Orders', value:num(k.totalOrders)},
      {label:'Units Sold', value:num(k.unitsSold)},
      {label:'Top Channel', value:k.topChannel, sub:peso(k.topChannelSales,{compact:true})+' in sales'},
    ])}
    <div class="row2">
      <div class="card"><h3>Daily sales trend</h3><div class="cap">Total sales across all channels</div><div class="chart-panel" id="dailyChart"></div></div>
      <div class="card"><h3>Sales by channel</h3><div class="cap">Month-to-date, all channels</div>
        ${barList(SALES.channels.map((c,i)=>({label:c.name, value:c.sales, formatted:peso(c.sales,{compact:true}), color:['var(--s1)','var(--s2)','var(--s3)','var(--s4)'][i%4]})))}
      </div>
    </div>
    <div class="row2">
      <div class="card"><h3>Top 5 products</h3><div class="cap">By sales, month-to-date</div>
        ${SALES.topProducts.length ? barList(SALES.topProducts.map(p=>({label:p.name, value:p.sales, formatted:peso(p.sales,{compact:true}), color:'var(--accent)'}))) : emptyState('No product data found.')}
      </div>
      <div class="card"><h3>At a glance</h3><div class="cap">&nbsp;</div>
        <div class="barlist">
          <div class="row"><div class="name">Avg daily sales</div><div></div><div class="value">${peso(SALES.stats.avgDailySales)}</div></div>
          <div class="row"><div class="name">Avg daily orders</div><div></div><div class="value">${SALES.stats.avgDailyOrders||'—'}</div></div>
          <div class="row"><div class="name">Best day</div><div></div><div class="value">${esc(SALES.stats.bestDay)||'—'}</div></div>
          <div class="row"><div class="name">Avg order value</div><div></div><div class="value">${peso(SALES.stats.avgOrderValue)}</div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:12px;">
      <h3>Channel summary</h3><div class="cap">Orders, quantity, sales, cost and profit by channel</div>
      <div class="table-wrap"><table class="dt">
        <thead><tr><th>Channel</th><th>Orders</th><th>Qty</th><th>Sales</th><th>Cost</th><th>Profit</th></tr></thead>
        <tbody>
          ${SALES.channels.map(c=>`<tr><td>${esc(c.name)}</td><td class="num">${num(c.orders)}</td><td class="num">${num(c.qty)}</td><td class="num">${peso(c.sales)}</td><td class="num">${peso(c.cost)}</td><td class="num">${peso(c.profit)}</td></tr>`).join('')}
          <tr style="font-weight:700;"><td>Total</td><td class="num">${num(SALES.totals.orders)}</td><td class="num">${num(SALES.totals.qty)}</td><td class="num">${peso(SALES.totals.sales)}</td><td class="num">${peso(SALES.totals.cost)}</td><td class="num">${peso(SALES.totals.profit)}</td></tr>
        </tbody>
      </table></div>
    </div>`;
  lineChart('dailyChart', SALES.daily.map(d => ({label:d[0], y:d[1]+d[2]+d[3]+d[4]})));
}

/* ================================ INVENTORY ================================ */
function daysUntil(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  if(isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
function invStatusBadges(item){
  const badges = [];
  if(item.stock <= 0) badges.push('<span class="badge critical">Out of stock</span>');
  else if(item.stock <= 10) badges.push('<span class="badge warn">Low stock</span>');
  const du = daysUntil(item.exp);
  if(du !== null){
    if(du < 0) badges.push('<span class="badge critical">Expired</span>');
    else if(du <= 60) badges.push('<span class="badge warn">Expiring ≤ 60d</span>');
  }
  if(!badges.length) badges.push('<span class="badge good">OK</span>');
  return badges.join(' ');
}
let invFilter = { q:'', vendor:'', status:'all', sortKey:'val', sortDir:-1 };
function invFilteredRows(){
  let rows = INVENTORY.filter(r => {
    if(invFilter.q && !((r.v+' '+r.n+' '+r.p).toLowerCase().includes(invFilter.q.toLowerCase()))) return false;
    if(invFilter.vendor && r.v !== invFilter.vendor) return false;
    if(invFilter.status === 'oos' && r.stock > 0) return false;
    if(invFilter.status === 'low' && !(r.stock > 0 && r.stock <= 10)) return false;
    if(invFilter.status === 'exp'){ const du = daysUntil(r.exp); if(du === null || du > 60) return false; }
    return true;
  });
  rows.sort((a,b) => (a[invFilter.sortKey] - b[invFilter.sortKey]) * invFilter.sortDir);
  return rows;
}
function renderInventoryTable(){
  const rows = invFilteredRows();
  document.getElementById('invCount').textContent = rows.length + ' of ' + INVENTORY.length + ' items';
  document.getElementById('invTbody').innerHTML = rows.map(r => `
    <tr><td>${esc(r.v)}</td><td>${esc(r.n)}${r.p?' <span style="color:var(--ink-3)">'+esc(r.p)+'</span>':''}</td>
      <td class="num">${peso(r.cost,{decimals:2})}</td><td class="num">${num(r.stock)}</td><td class="num">${peso(r.val,{decimals:2})}</td>
      <td>${esc(r.exp)||'—'}</td><td>${invStatusBadges(r)}</td></tr>`).join('');
}
function emptyState(msg){ return `<div style="padding:24px;color:var(--ink-3);font-size:12.5px;text-align:center;">${esc(msg)}</div>`; }
function renderInventory(){
  const v = document.getElementById('view-inventory');
  if(!INVENTORY.length){ v.innerHTML = `<div class="view-head"><h2>Inventory</h2></div>${emptyState('Inventory data not loaded yet.')}`; return; }
  const vendors = [...new Set(INVENTORY.map(r=>r.v))].sort();
  const oosCount = INVENTORY.filter(r=>r.stock<=0).length;
  const expSoon = INVENTORY.filter(r=>{const du=daysUntil(r.exp); return du!==null && du>=0 && du<=60;}).sort((a,b)=>daysUntil(a.exp)-daysUntil(b.exp));
  const expired = INVENTORY.filter(r=>{const du=daysUntil(r.exp); return du!==null && du<0;});
  const topByValue = [...INVENTORY].sort((a,b)=>b.val-a.val).slice(0,10);

  v.innerHTML = `
    <div class="view-head"><h2>Inventory</h2><span class="period">${INVENTORY.length} SKUs tracked</span></div>
    ${kpiGrid([
      {label:'Total Inventory Value', value:peso(INV_SCORECARD.totalValue,{compact:true})},
      {label:'Total Stock Qty', value:num(INV_SCORECARD.totalStock)},
      {label:'Out of Stock', value:num(oosCount), sub:'items at zero or negative stock', tone:'bad'},
      {label:'Expiring ≤ 60 days', value:num(expSoon.length), sub:expired.length+' already expired', tone: expSoon.length ? 'bad':''},
    ])}
    <div class="row2">
      <div class="card"><h3>Top 10 products by inventory value</h3><div class="cap">Cost × realtime stock</div>
        ${barList(topByValue.map(r=>({label:r.n+(r.p?' – '+r.p:''), value:r.val, formatted:peso(r.val,{compact:true}), color:'var(--accent)'})))}
      </div>
      <div class="card"><h3>Units by platform</h3><div class="cap">Allocated units across channels</div>
        ${barList(Object.entries(INV_PLATFORM).map(([k,val],i)=>({label:k, value:val, formatted:num(val), color:['var(--s1)','var(--s2)','var(--s3)','var(--s4)'][i%4]})))}
      </div>
    </div>
    <div class="row2">
      <div class="alertbox"><div class="ahead"><h3>Expiring soon</h3><span class="badge warn">${expSoon.length}</span></div>
        <div class="alertlist">${expSoon.length ? expSoon.map(r=>`<div class="alertrow"><span class="an">${esc(r.n)}${r.p?' – '+esc(r.p):''}</span><span class="av">${esc(r.exp)}</span></div>`).join('') : emptyState('Nothing expiring in the next 60 days.')}</div>
      </div>
      <div class="alertbox"><div class="ahead"><h3>Out of stock</h3><span class="badge critical">${oosCount}</span></div>
        <div class="alertlist">${INVENTORY.filter(r=>r.stock<=0).map(r=>`<div class="alertrow"><span class="an">${esc(r.n)}${r.p?' – '+esc(r.p):''}</span><span class="av">${esc(r.v)}</span></div>`).join('')}</div>
      </div>
    </div>
    <div class="card" style="margin-top:12px;">
      <h3>Full inventory</h3><div class="cap">Search, filter and sort every tracked SKU</div>
      <div class="toolbar">
        <input type="search" id="invSearch" placeholder="Search product or vendor…">
        <select id="invVendor"><option value="">All vendors</option>${vendors.map(v2=>`<option value="${esc(v2)}">${esc(v2)}</option>`).join('')}</select>
      </div>
      <div class="chipbar">
        <button class="chip active" data-status="all">All</button>
        <button class="chip" data-status="oos">Out of stock</button>
        <button class="chip" data-status="low">Low stock</button>
        <button class="chip" data-status="exp">Expiring ≤60d</button>
      </div>
      <div style="font-size:11.5px;color:var(--ink-3);margin-bottom:8px;" id="invCount"></div>
      <div class="table-wrap"><table class="dt">
        <thead><tr><th data-sort="v">Vendor</th><th data-sort="n">Product</th><th data-sort="cost">Cost/item</th><th data-sort="stock">Stock</th><th data-sort="val">Value</th><th data-sort="exp">Expiry</th><th>Status</th></tr></thead>
        <tbody id="invTbody"></tbody>
      </table></div>
    </div>`;
  document.getElementById('invSearch').addEventListener('input', e => { invFilter.q = e.target.value; renderInventoryTable(); });
  document.getElementById('invVendor').addEventListener('change', e => { invFilter.vendor = e.target.value; renderInventoryTable(); });
  v.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { v.querySelectorAll('.chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); invFilter.status = c.getAttribute('data-status'); renderInventoryTable(); }));
  v.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => { const key = th.getAttribute('data-sort'); if(invFilter.sortKey === key) invFilter.sortDir *= -1; else { invFilter.sortKey = key; invFilter.sortDir = 1; } renderInventoryTable(); }));
  renderInventoryTable();
}

/* ================================ PRICE LIST ================================ */
let plFilter = { q:'', cat:'All' };
function renderPriceListGrid(){
  const host = document.getElementById('plGrid');
  const cats = [...new Set(PRICELIST.map(p=>p.cat))];
  let items = PRICELIST.filter(p => (plFilter.cat==='All'||p.cat===plFilter.cat) && (!plFilter.q || (p.n+' '+p.sz).toLowerCase().includes(plFilter.q.toLowerCase())));
  if(plFilter.cat !== 'All'){ host.innerHTML = `<div class="pricegrid">${items.map(priceCard).join('')}</div>`; }
  else {
    host.innerHTML = cats.map(cat => { const rows = items.filter(p=>p.cat===cat); if(!rows.length) return ''; return `<div class="cat-heading">${esc(cat)}</div><div class="pricegrid">${rows.map(priceCard).join('')}</div>`; }).join('');
  }
  document.getElementById('plCount').textContent = items.length + ' of ' + PRICELIST.length + ' products';
}
function priceCard(p){
  return `<div class="pricecard"><div class="pn">${esc(p.n)} ${p.os?'<span class="badge critical">OS</span>':''}</div>
    <div class="pm">${esc(p.sz)}</div>
    <div class="pp">${p.price!==null ? peso(p.price,{decimals: p.price%1?2:0}) : '—'}</div>
    ${p.note ? `<div class="pnote">${esc(p.note)}</div>` : ''}</div>`;
}
function renderPriceList(){
  const v = document.getElementById('view-pricelist');
  if(!PRICELIST.length){ v.innerHTML = `<div class="view-head"><h2>Price List</h2></div>${emptyState('Price list not loaded yet.')}`; return; }
  const cats = [...new Set(PRICELIST.map(p=>p.cat))];
  v.innerHTML = `
    <div class="view-head"><h2>Price List</h2><span class="period">${PRICELIST.length} SKUs</span></div>
    <div class="toolbar"><input type="search" id="plSearch" placeholder="Search product or size…"></div>
    <div class="chipbar" id="plChips"><button class="chip active" data-cat="All">All</button>${cats.map(c=>`<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div style="font-size:11.5px;color:var(--ink-3);margin-bottom:4px;" id="plCount"></div>
    <div id="plGrid"></div>`;
  document.getElementById('plSearch').addEventListener('input', e => { plFilter.q = e.target.value; renderPriceListGrid(); });
  v.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { v.querySelectorAll('.chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); plFilter.cat = c.getAttribute('data-cat'); renderPriceListGrid(); }));
  renderPriceListGrid();
}

/* ================================ FINANCIALS ================================ */
let finYear = null, finLoading = false, finError = null;
function renderFinancials(){
  const v = document.getElementById('view-financials');
  if(finYear === null && window.FIN_YEAR) finYear = window.FIN_YEAR;
  if(!FIN){ v.innerHTML = `<div class="view-head"><h2>Financials</h2></div>${emptyState('Financial data not loaded yet.')}`; return; }
  const years = (window.IS_FILES || []).map(f=>f.year);
  const yearSel = years.length > 1 ? `<select id="finYearSel" ${finLoading?'disabled':''} style="padding:7px 10px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-size:12.5px;font-family:inherit;">
      ${years.map(y=>`<option value="${y}" ${y===finYear?'selected':''}>${y}</option>`).join('')}
    </select>` : '';
  const k = FIN.kpi;
  const revExpMax = Math.max(...FIN.monthly.map(m=>Math.max(m.rev,m.exp)), 1);
  const chequeCashTotal = (FIN.collections.cheque + FIN.collections.cash) || 1;
  v.innerHTML = `
    <div class="view-head"><h2>Financials</h2><span class="period">${finYear||''} · Year to date</span></div>
    ${years.length > 1 ? `<div class="toolbar" style="justify-content:flex-end;">${finLoading?'<span style="font-size:11.5px;color:var(--ink-3);">Loading…</span>':''}${yearSel}</div>` : ''}
    ${finError ? `<div style="font-size:11.5px;color:var(--critical);margin-bottom:12px;">${esc(finError)}</div>` : ''}
    ${kpiGrid([
      {label:'Total Revenue YTD', value:peso(k.revenue,{compact:true})},
      {label:'Total Expenses YTD', value:peso(k.expenses,{compact:true})},
      {label:'Net Income YTD', value:peso(k.netIncome,{compact:true}), sub:k.margin+'% margin', tone:'good'},
      {label:'Avg Net Income/mo', value:peso(k.avgNetIncomeMo,{compact:true})},
      {label:'Total Collections', value:peso(k.totalCollections,{compact:true})},
      {label:'Cheque : Cash split', value: Math.round(FIN.collections.cheque/chequeCashTotal*100)+' : '+Math.round(FIN.collections.cash/chequeCashTotal*100)},
    ])}
    <div class="card" style="margin-top:12px;">
      <h3>Monthly revenue vs. expenses</h3><div class="cap">Actuals as logged in the workbook</div>
      <div class="legend"><span class="item"><span class="sw" style="background:var(--s1)"></span>Revenue</span><span class="item"><span class="sw" style="background:var(--s2)"></span>Expenses</span></div>
      <div class="chart-panel"><div class="barlist">
        ${FIN.monthly.map(m => `<div class="row" style="grid-template-columns:38px 1fr auto;"><div class="name">${esc(m.m)}</div>
          <div><div class="track" style="margin-bottom:3px;"><div class="fill" style="width:${m.rev/revExpMax*100}%;background:var(--s1)"></div></div>
          <div class="track"><div class="fill" style="width:${m.exp/revExpMax*100}%;background:var(--s2)"></div></div></div>
          <div class="value" style="text-align:right;">${peso(m.rev,{compact:true})}<br><span style="color:var(--ink-3);font-weight:500;">${peso(m.exp,{compact:true})}</span></div></div>`).join('')}
      </div></div>
    </div>
    <div class="card" style="margin-top:12px;"><h3>Monthly net income</h3><div class="cap">Positive vs. negative months, PHP</div>
      ${divergingBars(FIN.monthly.map(m=>({label:m.m, value:m.ni})))}
    </div>
    <div class="row3">
      <div class="card"><h3>Collections YTD</h3><div class="cap">Cheque vs. cash</div>
        ${barList([{label:'Cheque', value:FIN.collections.cheque, formatted:peso(FIN.collections.cheque,{compact:true}), color:'var(--s1)'},{label:'Cash', value:FIN.collections.cash, formatted:peso(FIN.collections.cash,{compact:true}), color:'var(--s3)'}])}
      </div>
      <div class="card"><h3>Cheque status</h3><div class="cap">${FIN.cheque.totalCount} cheques issued</div>
        <div class="barlist">
          <div class="row"><div class="name"><span class="badge good">Cleared</span></div><div></div><div class="value">${FIN.cheque.clearedCount}</div></div>
          <div class="row"><div class="name"><span class="badge warn">Pending</span></div><div></div><div class="value">${FIN.cheque.pendingCount}</div></div>
          <div class="row"><div class="name"><span class="badge critical">Bounced</span></div><div></div><div class="value">${FIN.cheque.bouncedCount}</div></div>
          <div class="row"><div class="name" style="color:var(--ink-3)">Avg pending age</div><div></div><div class="value">${FIN.cheque.avgPendingAge}d</div></div>
        </div>
      </div>
      <div class="card"><h3>Cash collections</h3><div class="cap">${FIN.cash.count} records</div>
        <div class="barlist">
          <div class="row"><div class="name">Total</div><div></div><div class="value">${peso(FIN.cash.total,{compact:true})}</div></div>
          <div class="row"><div class="name">Average</div><div></div><div class="value">${peso(FIN.cash.avg,{decimals:2})}</div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:12px;"><h3>Top payers</h3><div class="cap">By cleared &amp; pending cheque amount, YTD</div>
      <div class="table-wrap"><table class="dt"><thead><tr><th>#</th><th>Payer / Payee</th><th>Amount</th></tr></thead>
        <tbody>${FIN.topPayers.length ? FIN.topPayers.map((p,i)=>`<tr><td>${i+1}</td><td>${esc(p.name)}</td><td class="num">${peso(p.amount,{decimals:2})}</td></tr>`).join('') : `<tr><td colspan="3">${emptyState('No payer data found.')}</td></tr>`}</tbody>
      </table></div>
    </div>`;

  const sel = document.getElementById('finYearSel');
  if(sel) sel.addEventListener('change', async e => {
    const y = +e.target.value;
    if(y === finYear) return;
    finLoading = true; finError = null; renderFinancials();
    try{
      const loaded = await loadFinancialsForYear(y);
      FIN = loaded.fin; finYear = y;
      window.PLATFORM_INCOME_WB = loaded.workbook;
      window.PLATFORM_INCOME_MONTHS = loaded.months;
      platformMonth = loaded.months.length ? loaded.months[loaded.months.length-1] : null;
    } catch(err){
      finError = "Couldn't load " + y + ": " + err.message;
    } finally {
      finLoading = false; renderFinancials();
    }
  });
}

/* ============================= PLATFORM REPORT ============================= */
let platformMonth = null;
let platformMode = 'monthly'; // 'monthly' | 'ytd'
function platformRowHtml(r){
  const cls = r.subtotal ? 'subtotal' : (r.group==='grand' ? 'grand' : '');
  const fmt = (v) => v ? peso(v,{decimals:2}) : '—';
  return `<tr class="${cls}">
    <td>${esc(r.label)}</td>
    <td class="num">${fmt(r.shopee)}</td>
    <td class="num">${fmt(r.lazada)}</td>
    <td class="num">${fmt(r.tiktok)}</td>
    <td class="num tot">${fmt(r.total)}</td>
  </tr>`;
}
function platformTablesHtml(rows, netLabel){
  const byKey = (k) => rows.find(r=>r.key===k) || {shopee:0,lazada:0,tiktok:0,total:0};
  const revenueRows = rows.filter(r=>r.group==='revenue');
  const expenseRows = rows.filter(r=>r.group==='expenses');
  const rollupRows = rows.filter(r=>r.group==='rollup');
  const otherRows = rows.filter(r=>r.group==='other');
  const netBeforeTax = byKey('netIncomeBeforeTaxes');
  const netIncome = byKey('netIncome');
  const opEx = byKey('totalExpensesOperating');

  return `
    ${kpiGrid([
      {label:'Total Revenues', value:peso(byKey('totalRevenues').total,{compact:true})},
      {label:'Expenses per Platform', value:peso(expenseRows.find(r=>r.key==='expensesPerPlatform')?.total||0,{compact:true})},
      {label:'Net Income Before Taxes', value:peso(netBeforeTax.total,{compact:true})},
      {label:'Net Income', value:peso(netIncome.total,{compact:true}), sub:netLabel, tone: netIncome.total>=0?'good':'bad'},
    ])}
    <div class="card" style="margin-top:12px;">
      <h3>Revenue &amp; Expenses by Platform</h3>
      <div class="cap">Typed in from each platform's monthly payout statement</div>
      <div class="legend">
        <span class="item"><span class="sw" style="background:var(--s2)"></span>Shopee</span>
        <span class="item"><span class="sw" style="background:var(--s1)"></span>Lazada</span>
        <span class="item"><span class="sw" style="background:var(--s3)"></span>TikTok</span>
      </div>
      <div class="table-wrap"><table class="dt">
        <thead><tr><th>Line item</th><th>Shopee</th><th>Lazada</th><th>TikTok</th><th>Total</th></tr></thead>
        <tbody>
          ${revenueRows.map(platformRowHtml).join('')}
          ${expenseRows.map(platformRowHtml).join('')}
          ${platformRowHtml(netBeforeTax)}
          ${platformRowHtml(opEx)}
        </tbody>
      </table></div>
      <div class="callout" style="font-size:11.5px;color:var(--ink-3);margin-top:10px;">"Total expenses (operating)" is company-wide overhead (rent, salaries, utilities, etc.) — mostly booked under Shopee's column in the source sheet, not split per platform.</div>
    </div>
    <div class="card" style="margin-top:12px;">
      <h3>Capital &amp; Net Income Roll-up</h3>
      <div class="cap">Gross income after cost of goods (capital) deployed per platform</div>
      <div class="table-wrap"><table class="dt">
        <thead><tr><th>Line item</th><th>Shopee</th><th>Lazada</th><th>TikTok</th><th>Total</th></tr></thead>
        <tbody>
          ${rollupRows.map(platformRowHtml).join('')}
          ${otherRows.map(r=>`<tr><td>${esc(r.label)}</td><td class="num" colspan="3"></td><td class="num tot">${r.total?peso(r.total,{decimals:2}):'—'}</td></tr>`).join('')}
          <tr class="grand"><td>${esc(netIncome.label)}</td><td class="num" colspan="3"></td><td class="num tot">${netIncome.total?peso(netIncome.total,{decimals:2}):'—'}</td></tr>
        </tbody>
      </table></div>
    </div>`;
}
function renderPlatformReport(){
  const v = document.getElementById('view-platform');
  const months = window.PLATFORM_INCOME_MONTHS || [];
  if(!months.length){ v.innerHTML = `<div class="view-head"><h2>Platform Report</h2></div>${emptyState('No monthly platform statements found yet — add a tab to the Platform Income Statements sheet to get started.')}`; return; }
  if(!platformMonth) platformMonth = months[months.length-1];

  const modeChips = `<div class="chipbar" style="margin:0;">
      <button class="chip ${platformMode==='monthly'?'active':''}" data-mode="monthly">Monthly</button>
      <button class="chip ${platformMode==='ytd'?'active':''}" data-mode="ytd">YTD</button>
    </div>`;
  const monthSel = platformMode==='monthly' ? `<select id="platformMonthSel" style="padding:7px 10px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-size:12.5px;font-family:inherit;">
        ${months.map(m=>`<option value="${esc(m)}" ${m===platformMonth?'selected':''}>${esc(m)}</option>`).join('')}
      </select>` : '';

  let body, headNote;
  if(platformMode==='monthly'){
    const rows = extractPlatformIncomeMonth(window.PLATFORM_INCOME_WB, platformMonth) || [];
    headNote = platformMonth;
    body = platformTablesHtml(rows, 'grand total for the month');
  } else {
    const ytd = computeYTD(window.PLATFORM_INCOME_WB, months);
    if(!ytd){ body = emptyState('No data available for a YTD roll-up yet.'); headNote = ''; }
    else {
      headNote = ytd.year + ' · ' + ytd.months.length + ' month' + (ytd.months.length===1?'':'s') + ' (' + ytd.months.join(', ') + ')';
      body = platformTablesHtml(ytd.rows, 'year-to-date grand total');
    }
  }

  v.innerHTML = `
    <div class="view-head"><h2>Platform Report</h2><span class="period">${esc(headNote)}</span></div>
    <div class="toolbar" style="justify-content:space-between;">${modeChips}${monthSel}</div>
    ${body}`;

  v.querySelectorAll('.chip[data-mode]').forEach(c => c.addEventListener('click', () => { platformMode = c.getAttribute('data-mode'); renderPlatformReport(); }));
  const sel = document.getElementById('platformMonthSel');
  if(sel) sel.addEventListener('change', e => { platformMonth = e.target.value; renderPlatformReport(); });
}
