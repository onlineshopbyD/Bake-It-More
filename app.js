/* ==========================================================================
   Bake It More — live dashboard app logic
   Auth (Google Identity Services) + Drive fetch + XLSX parsing + orchestration.
   UI rendering lives in ui.js (shared render functions) — this file only
   produces the same-shaped data objects (SALES, FIN, INVENTORY, PRICELIST)
   that ui.js already knows how to draw.
   ========================================================================== */

let accessToken = null;
let tokenClient = null;
let refreshTimer = null;
const REFRESH_MS = 5 * 60 * 1000; // poll every 5 minutes while the tab is open

/* ---------------------------------- AUTH --------------------------------- */
function initAuth(onSignedIn){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: (resp) => {
      if(resp.error){ showAuthError(resp); return; }
      accessToken = resp.access_token;
      onSignedIn();
    },
  });
}
function signIn(){
  if(!tokenClient){ showAuthError({error:"not_ready", error_description:"Still loading Google's sign-in script — try again in a second."}); return; }
  tokenClient.requestAccessToken({prompt: accessToken ? '' : 'consent'});
}
function signOut(){
  if(accessToken){ google.accounts.oauth2.revoke(accessToken, () => {}); }
  accessToken = null;
  clearInterval(refreshTimer);
  location.reload();
}

/* --------------------------------- DRIVE ---------------------------------- */
const DRIVE = "https://www.googleapis.com/drive/v3";
async function driveFetch(url){
  // cache: 'no-store' + a cache-busting param — otherwise the browser (or an
  // intermediate cache) can serve a stale copy of the file on "refresh" and
  // the numbers silently stop updating even though nothing looks wrong.
  const bust = (url.includes("?") ? "&" : "?") + "_ts=" + Date.now();
  const res = await fetch(url + bust, { headers: { Authorization: "Bearer " + accessToken }, cache: "no-store" });
  if(!res.ok) throw new Error("Drive API " + res.status + " for " + url);
  return res;
}
async function listFolder(folderId){
  const url = `${DRIVE}/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`;
  const res = await driveFetch(url);
  return (await res.json()).files || [];
}
async function getMeta(fileId){
  const res = await driveFetch(`${DRIVE}/files/${fileId}?fields=id,name,mimeType,modifiedTime`);
  return res.json();
}
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
async function downloadWorkbook(fileId){
  const meta = await getMeta(fileId);
  let res;
  if(meta.mimeType === "application/vnd.google-apps.spreadsheet"){
    res = await driveFetch(`${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`);
  } else {
    res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  }
  const buf = await res.arrayBuffer();
  return { meta, workbook: XLSX.read(buf, {type:"array", cellDates:true}) };
}

/* pick "current" order tracker: most recently modified file in the folder */
async function resolveOrderTrackerFile(){
  const files = await listFolder(CONFIG.ORDER_TRACKER_FOLDER_ID);
  const xlsx = files.filter(f => /BIM Order Tracker/i.test(f.name));
  if(!xlsx.length) throw new Error("No 'BIM Order Tracker' file found in the configured folder.");
  return xlsx[0]; // orderBy modifiedTime desc already
}
/* every Income Statement file in the folder, tagged with the year found in
   its name (works for both "BakeItMore IS <Year>.xlsx" and
   "BakeItMore_IS_<Year>.xlsx" naming) — lets the Financials tab offer any
   year that has a file sitting in Drive, current or future/blank template,
   without needing the folder ID or naming convention hardcoded per year. */
async function listIncomeStatementFiles(){
  const files = await listFolder(CONFIG.INCOME_STATEMENT_FOLDER_ID);
  return files
    .map(f => { const m = f.name.match(/20\d\d/); return m ? Object.assign({year: +m[0]}, f) : null; })
    .filter(Boolean)
    .sort((a,b) => a.year - b.year);
}
/* pick income statement matching current year, fallback to most recent */
function pickDefaultIncomeStatementFile(files){
  const year = new Date().getFullYear();
  return files.find(f => f.year === year) || files[files.length-1] || files[0];
}
/* year -> {workbook, fin, months} cache so switching years in the Financials
   tab doesn't re-download/re-parse a file you've already looked at. */
const FIN_CACHE = {};
async function loadFinancialsForYear(year){
  if(FIN_CACHE[year]) return FIN_CACHE[year];
  const files = window.IS_FILES || (window.IS_FILES = await listIncomeStatementFiles());
  const file = files.find(f => f.year === year);
  if(!file) throw new Error("No Income Statement file found for " + year);
  const workbook = (await downloadWorkbook(file.id)).workbook;
  const fin = extractFinancials(workbook);
  const months = sortMonthNames(findAvailablePlatformMonths(workbook));
  FIN_CACHE[year] = { workbook, fin, months };
  return FIN_CACHE[year];
}

/* ------------------------------ SHEET HELPERS ----------------------------- */
function sheetRows(workbook, sheetName){
  const sheet = workbook.Sheets[sheetName];
  if(!sheet) return null;
  return XLSX.utils.sheet_to_json(sheet, {header:1, defval:"", raw:false});
}
function findSheetByHeaderText(workbook, mustContain){
  for(const name of workbook.SheetNames){
    const rows = sheetRows(workbook, name);
    if(!rows) continue;
    for(const row of rows){
      const joined = row.join(" | ").toLowerCase();
      if(mustContain.every(t => joined.includes(t.toLowerCase()))) return {name, rows};
    }
  }
  return null;
}
function cellText(v){ return (v===undefined||v===null) ? "" : String(v).trim(); }
function toNum(v){
  if(v===undefined||v===null||v==="") return 0;
  let s = String(v).trim();
  if(s==="") return 0;
  const negParen = /^\(.*\)$/.test(s);
  if(negParen) s = s.slice(1,-1);
  // pull out the first plain numeric run instead of trying to strip every
  // possible currency prefix (₱, PHP, P, etc.) — far more robust across
  // whatever formatting a given sheet actually uses.
  const m = s.match(/-?\d[\d,]*\.?\d*/);
  if(!m) return 0;
  const n = parseFloat(m[0].replace(/,/g,""));
  if(isNaN(n)) return 0;
  return negParen ? -n : n;
}
/* label above, value in the same column one row below (dashboard KPI style) */
function findValueBelow(rows, label){
  for(let r=0; r<rows.length; r++){
    for(let c=0; c<rows[r].length; c++){
      if(cellText(rows[r][c]).toLowerCase() === label.toLowerCase()){
        const below = rows[r+1];
        if(below) return below[c];
      }
    }
  }
  return undefined;
}
/* label, then next non-empty cell to the right on the same row */
function findValueRight(rows, label){
  for(let r=0; r<rows.length; r++){
    for(let c=0; c<rows[r].length; c++){
      if(cellText(rows[r][c]).toLowerCase() === label.toLowerCase()){
        for(let c2=c+1; c2<rows[r].length; c2++){
          if(cellText(rows[r][c2]) !== "") return rows[r][c2];
        }
      }
    }
  }
  return undefined;
}
function findKpi(rows, label){
  const v = findValueBelow(rows, label);
  if(v !== undefined && cellText(v) !== "") return v;
  return findValueRight(rows, label);
}
function findHeaderRow(rows, colNamesLower){
  for(let r=0; r<rows.length; r++){
    const lower = rows[r].map(c => cellText(c).toLowerCase());
    if(colNamesLower.every(n => lower.includes(n))) return {rowIdx:r, cols: colNamesLower.map(n => lower.indexOf(n))};
  }
  return null;
}

/* ============================== EXTRACTORS =============================== */

function extractSales(workbook){
  const dash = findSheetByHeaderText(workbook, ["total sales", "total cost", "net profit"]);
  if(!dash) throw new Error("Couldn't find the sales Dashboard sheet/KPI block.");
  const rows = dash.rows;

  const period = (() => {
    for(const row of rows){ for(const c of row){ const t = cellText(c); if(/[A-Za-z]+\s+\d+\s*[-–—]\s*[A-Za-z]*\s*\d+,\s*20\d\d/.test(t)) return t; } }
    return "";
  })();

  const kpi = {
    totalSales: toNum(findKpi(rows,"TOTAL SALES")),
    totalCost: toNum(findKpi(rows,"TOTAL COST")),
    netProfit: toNum(findKpi(rows,"NET PROFIT")),
    totalOrders: toNum(findKpi(rows,"TOTAL ORDERS")),
    unitsSold: toNum(findKpi(rows,"UNITS SOLD")),
    topChannel: cellText(findKpi(rows,"TOP CHANNEL")) || "—",
  };
  kpi.margin = kpi.totalSales ? +((kpi.netProfit/kpi.totalSales)*100).toFixed(1) : 0;
  kpi.topChannelSales = 0; // filled in below once channel table parsed

  const chanHeader = findHeaderRow(rows, ["channel","orders","qty","sales","cost","profit"]);
  const channels = [];
  if(chanHeader){
    const [nameCol, ordersCol, qtyCol, salesCol, costCol, profitCol] = chanHeader.cols;
    for(let r=chanHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name || /^total$/i.test(name)) break;
      channels.push({
        name, orders: toNum(rows[r][ordersCol]), qty: toNum(rows[r][qtyCol]),
        sales: toNum(rows[r][salesCol]), cost: toNum(rows[r][costCol]), profit: toNum(rows[r][profitCol]),
      });
    }
  }
  const top = [...channels].sort((a,b)=>b.sales-a.sales)[0];
  if(top){ kpi.topChannel = kpi.topChannel==="—" ? top.name : kpi.topChannel; kpi.topChannelSales = top.sales; }
  const totals = channels.reduce((a,c)=>({orders:a.orders+c.orders, qty:a.qty+c.qty, sales:a.sales+c.sales, cost:a.cost+c.cost, profit:a.profit+c.profit}), {orders:0,qty:0,sales:0,cost:0,profit:0});

  // top 5 products: same row as the channel header, but "Product" col + the *next*
  // "Qty"/"Sales" columns after it — the channel table already used the first
  // occurrence of those two labels, so search strictly after the Product column.
  let topProducts = [];
  const prodHeaderRowIdx = rows.findIndex(row => row.some(c => cellText(c).toLowerCase()==="product"));
  const prodHeader = prodHeaderRowIdx>=0 ? (() => {
    const lower = rows[prodHeaderRowIdx].map(c=>cellText(c).toLowerCase());
    const nameCol = lower.indexOf("product");
    const qtyCol = lower.indexOf("qty", nameCol+1);
    const salesCol = lower.indexOf("sales", nameCol+1);
    return (qtyCol>=0 && salesCol>=0) ? {rowIdx:prodHeaderRowIdx, cols:[nameCol,qtyCol,salesCol]} : null;
  })() : null;
  if(prodHeader){
    const nameCol = prodHeader.cols[0], qtyCol = prodHeader.cols[1], salesCol = prodHeader.cols[2];
    for(let r=prodHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name || /^total$/i.test(name)) break;
      topProducts.push({ name, qty: toNum(rows[r][qtyCol]), sales: toNum(rows[r][salesCol]) });
    }
  }
  topProducts = topProducts.filter(p=>p.sales>0).sort((a,b)=>b.sales-a.sales).slice(0,5);

  // daily trend: header row Date/Lazada/Shopee/Tiktok/Marketplace
  const dailyHeader = findHeaderRow(rows, ["date","lazada","shopee","marketplace"]);
  const daily = [];
  if(dailyHeader){
    const {rowIdx} = dailyHeader;
    const dateCol = rows[rowIdx].findIndex(c=>cellText(c).toLowerCase()==="date");
    for(let r=rowIdx+1; r<rows.length; r++){
      const label = cellText(rows[r][dateCol]);
      if(!label || /^total$/i.test(label)) break;
      const laz = toNum(rows[r][dateCol+1]), shp = toNum(rows[r][dateCol+2]), ttk = toNum(rows[r][dateCol+3]), mkt = toNum(rows[r][dateCol+4]);
      if(laz||shp||ttk||mkt) daily.push([label, laz, shp, ttk, mkt]);
    }
  }

  const stats = {
    avgDailySales: toNum(findKpi(rows,"AVG DAILY SALES")),
    avgDailyOrders: toNum(findKpi(rows,"AVG DAILY ORDERS")),
    bestChannel: cellText(findKpi(rows,"BEST CHANNEL")),
    bestDay: cellText(findKpi(rows,"BEST DAY")),
    avgOrderValue: toNum(findKpi(rows,"AVG ORDER VALUE")),
  };

  return { period, kpi, channels, totals, topProducts, daily, stats };
}

function extractFinancials(workbook){
  const dash = findSheetByHeaderText(workbook, ["total revenue", "total expenses", "net income"]);
  if(!dash) throw new Error("Couldn't find the Income Statement KPI block.");
  const rows = dash.rows;
  const kpi = {
    revenue: toNum(findKpi(rows,"TOTAL REVENUE (YTD)")),
    expenses: Math.abs(toNum(findKpi(rows,"TOTAL EXPENSES (YTD)"))),
    netIncome: toNum(findKpi(rows,"NET INCOME (YTD)")),
    avgNetIncomeMo: toNum(findKpi(rows,"AVG NET INCOME / MO.")),
    totalCollections: toNum(findKpi(rows,"TOTAL COLLECTIONS")),
  };
  kpi.margin = kpi.revenue ? +((kpi.netIncome/kpi.revenue)*100).toFixed(1) : 0;

  const monthHeader = findHeaderRow(rows, ["php","jan","feb","dec"]);
  const monthly = [];
  if(monthHeader){
    const hdrRow = rows[monthHeader.rowIdx];
    const monthCols = [];
    hdrRow.forEach((c,i)=>{ if(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(cellText(c))) monthCols.push({i, m: cellText(c)}); });
    // search every column for the row label, not a hardcoded index — the
    // label's exact column position can shift depending on the sheet.
    const findRow = (label) => { for(let r=monthHeader.rowIdx+1;r<rows.length;r++){ if(rows[r].some(c => cellText(c).toLowerCase()===label.toLowerCase())) return rows[r]; } return null; };
    const revRow = findRow("Revenue"), expRow = findRow("Expenses"), niRow = findRow("Net Income");
    monthCols.forEach(({i,m}) => {
      monthly.push({ m, rev: revRow?toNum(revRow[i]):0, exp: Math.abs(expRow?toNum(expRow[i]):0), ni: niRow?toNum(niRow[i]):0 });
    });
  }

  const collections = {
    cheque: toNum(findKpi(rows,"CHEQUE COLLECTED")),
    cash: toNum(findKpi(rows,"CASH COLLECTED")),
    total: kpi.totalCollections,
  };
  // NOTE: "Total Amount" labels appear once in the Cheque KPI block and again
  // in the Cash KPI block, so a plain label search would grab whichever comes
  // first. The top-of-sheet "CHEQUE/CASH COLLECTED" figures are unambiguous —
  // use those for the totals instead of re-deriving from the detail tables.
  const cheque = {
    total: collections.cheque,
    cleared: toNum(findValueRight(rows,"Cleared Amount")),
    pending: toNum(findValueRight(rows,"Pending Amount")),
    bounced: toNum(findValueRight(rows,"Bounced Amount")),
    totalCount: toNum(findValueRight(rows,"Total Cheques")),
    clearedCount: toNum(findValueRight(rows,"Cleared Count")),
    pendingCount: toNum(findValueRight(rows,"Pending Count")),
    bouncedCount: toNum(findValueRight(rows,"Bounced Count")),
    avgPendingAge: toNum(findValueRight(rows,"Avg Pending Age (days)")),
  };
  const cash = {
    total: collections.cash,
    count: toNum(findValueRight(rows,"Record Count")),
    avg: toNum(findValueRight(rows,"Average Amount")),
  };

  // top payers table: "Payer/Payee" appears twice (the full alphabetical list,
  // and the curated top-10 "Rank" list) — anchor on the unique "Rank" column
  // and take the Payer/Payee + Amount columns immediately after it.
  const rankRowIdx = rows.findIndex(row => row.some(c => cellText(c).toLowerCase()==="rank"));
  const payerHeader = (() => {
    if(rankRowIdx<0) return null;
    const lower = rows[rankRowIdx].map(c=>cellText(c).toLowerCase());
    const rankCol = lower.indexOf("rank");
    const nameCol = lower.indexOf("payer/payee", rankCol+1);
    const amtCol = lower.indexOf("amount", rankCol+1);
    return (nameCol>=0 && amtCol>=0) ? {rowIdx:rankRowIdx, cols:[nameCol,amtCol]} : null;
  })();
  let topPayers = [];
  if(payerHeader){
    const nameCol = payerHeader.cols[0], amtCol = payerHeader.cols[1];
    for(let r=payerHeader.rowIdx+1; r<rows.length; r++){
      const name = cellText(rows[r][nameCol]);
      if(!name) continue;
      if(/grand total/i.test(name)) break;
      const amt = toNum(rows[r][amtCol]);
      if(amt>0) topPayers.push({name, amount: amt});
    }
  }
  topPayers = topPayers.sort((a,b)=>b.amount-a.amount).slice(0,10);

  return { kpi, monthly, collections, cheque, cash, topPayers };
}

function extractInventory(workbook){
  // stock-qty / inventory-value column headers have been renamed at least
  // once already — match on any known wording rather than one fixed string.
  const STOCK_HEADERS = ["realtime stocks quantity","total stock qty","stock qty","stock quantity"];
  const VALUE_HEADERS = ["inventory value","total inventory value"];

  // Prefer a sheet whose NAME contains "business" + "inventory" (fuzzy, in
  // case of extra spacing/wording) — the workbook has other tabs (Dashboard,
  // etc.) whose headers can look similar, and a pure content search could
  // grab the wrong one.
  const namedSheet = workbook.SheetNames.find(n => {
    const t = n.trim().toLowerCase();
    return t.includes("business") && t.includes("inventory");
  });
  let table = null;
  if(namedSheet){
    table = { name: namedSheet, rows: sheetRows(workbook, namedSheet) };
  }
  if(!table){
    for(const n of workbook.SheetNames){
      const rows = sheetRows(workbook, n);
      if(!rows) continue;
      const hasProduct = rows.some(row => row.some(c => cellText(c).toLowerCase()==="product name"));
      const hasStock = rows.some(row => row.some(c => STOCK_HEADERS.includes(cellText(c).toLowerCase())));
      if(hasProduct && hasStock){ table = {name:n, rows}; break; }
    }
  }
  if(!table) throw new Error("Couldn't find the main inventory table. Sheets in this file: " + workbook.SheetNames.join(", "));
  window.__DEBUG_INV_SHEET = { usedNamedSheet: !!namedSheet, sheetName: table.name, allSheetNames: workbook.SheetNames };
  const rows = table.rows;
  const hdr = findHeaderRow(rows, ["product name","cost per item","sku"]);
  if(!hdr) throw new Error("Inventory header row didn't match expected columns.");
  const headerRowRaw = rows[hdr.rowIdx].map(c=>cellText(c).toLowerCase());
  const idx = (name) => headerRowRaw.indexOf(name);
  const idxAny = (names) => { for(const n of names){ const i = headerRowRaw.indexOf(n); if(i>=0) return i; } return -1; };
  const cVendor = 0, cName = idx("product name"), cPart = idx("particulars"), cExp = idx("expiry"),
        cCost = idx("cost per item"), cSku = idx("sku"), cStock = idxAny(STOCK_HEADERS), cVal = idxAny(VALUE_HEADERS),
        cLaz = idx("lazada"), cShp = idx("shopee"), cTtk = idx("tiktok"), cDir = idx("direct");
  if(cStock<0 || cVal<0) throw new Error("Couldn't find the Stock Qty / Inventory Value columns — header text: " + JSON.stringify(rows[hdr.rowIdx]));

  window.__DEBUG_INV = {
    headerRow: rows[hdr.rowIdx],
    sampleRawRows: rows.slice(hdr.rowIdx+1, hdr.rowIdx+4),
    colIndex: {cVendor,cName,cPart,cExp,cCost,cSku,cStock,cVal,cLaz,cShp,cTtk,cDir},
  };

  const items = [];
  for(let r=hdr.rowIdx+1; r<rows.length; r++){
    const name = cellText(rows[r][cName]);
    // skip blank rows and any grand-total / subtotal row so it doesn't get
    // counted as a giant phantom "item" and double the real sum.
    if(!name || /^(grand\s*)?total/i.test(name)) continue;
    const vendorText = cellText(rows[r][cVendor]);
    if(/^(grand\s*)?total/i.test(vendorText)) continue;
    items.push({
      v: cellText(rows[r][cVendor]), n: name, p: cellText(rows[r][cPart]), exp: cellText(rows[r][cExp]),
      cost: toNum(rows[r][cCost]), sku: toNum(rows[r][cSku]), stock: toNum(rows[r][cStock]), val: toNum(rows[r][cVal]),
      laz: toNum(rows[r][cLaz]), shp: toNum(rows[r][cShp]), ttk: toNum(rows[r][cTtk]), dir: toNum(rows[r][cDir]),
    });
  }

  // Compute every summary number directly from the Business Inventory
  // Template rows themselves, rather than trusting a separate Dashboard/
  // scorecard cell elsewhere in the workbook — that cell can be a stale
  // pivot/cached value that drifts from the real, live item table.
  const scorecard = {
    totalValue: items.reduce((s,i)=>s+i.val,0),
    totalStock: items.reduce((s,i)=>s+Math.max(i.stock,0),0),
    outOfStock: items.filter(i=>i.stock<=0).length,
  };
  const platform = {
    Lazada: items.reduce((s,i)=>s+i.laz,0),
    Shopee: items.reduce((s,i)=>s+i.shp,0),
    TikTok: items.reduce((s,i)=>s+i.ttk,0),
    Direct: items.reduce((s,i)=>s+i.dir,0),
  };

  return { items, scorecard, platform };
}

function extractPriceList(workbook){
  const out = [];
  for(const name of workbook.SheetNames){
    const rows = sheetRows(workbook, name);
    if(!rows) continue;
    const hdr = findHeaderRow(rows, ["product name","price"]);
    if(!hdr) continue;
    const headerRowRaw = rows[hdr.rowIdx].map(c=>cellText(c).toLowerCase());
    const cName = headerRowRaw.indexOf("product name");
    const cSize = headerRowRaw.findIndex(h=>h.includes("size")||h.includes("variant"));
    const cPrice = headerRowRaw.indexOf("price");
    const cNote = headerRowRaw.indexOf("notes");
    const catLabel = cellText(rows[hdr.rowIdx][0]).replace(/category.*/i,"").trim() || name;
    for(let r=hdr.rowIdx+1; r<rows.length; r++){
      const rowVals = rows[r].map(cellText);
      const pname = cellText(rows[r][cName]);
      if(!pname || /^out of stock$/i.test(pname)) continue;
      const os = rowVals.some(v=>v.toUpperCase()==="OS");
      const priceRaw = cPrice>=0 ? rows[r][cPrice] : "";
      out.push({
        cat: catLabel, n: pname,
        sz: cSize>=0 ? cellText(rows[r][cSize]) : "",
        price: cellText(priceRaw)==="" ? null : toNum(priceRaw),
        note: cNote>=0 ? cellText(rows[r][cNote]) : "",
        os,
      });
    }
  }
  return out;
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Locate the "Income Statement — <Month> <Year>" block for one month inside
// the SAME workbook already used for the Financials tab (BakeItMore IS
// <Year>.xlsx) — your own sheet already has this per-platform breakdown for
// every month you've filled in, so nothing extra needs to be maintained.
function findPlatformIncomeBlock(finWorkbook, monthName, year){
  const monthLower = monthName.toLowerCase();
  for(const name of finWorkbook.SheetNames){
    const rows = sheetRows(finWorkbook, name);
    if(!rows) continue;
    const startIdx = rows.findIndex(r => {
      const joined = r.map(cellText).join(" ").toLowerCase().replace(/[–—]/g,"-");
      return joined.includes("income statement") && joined.includes("- "+monthLower+" "+year);
    });
    if(startIdx < 0) continue;
    let endIdx = rows.length;
    for(let i=startIdx+1; i<rows.length; i++){
      const joined = rows[i].map(cellText).join(" ").toLowerCase().replace(/[–—]/g,"-");
      const isNextMonthMarker = joined.includes("income statement") && MONTH_NAMES.some(m => joined.includes("- "+m.toLowerCase()+" "));
      if(isNextMonthMarker){ endIdx = i; break; }
    }
    return rows.slice(startIdx, endIdx);
  }
  return null;
}
// value columns in this sheet are consistently at index 4/5/6 (Shopee/Lazada/
// Tiktok) with Total at index 7 — except a couple of rows whose Total cell
// sits further right due to extra padding columns, so fall back to summing
// the three platform values whenever the Total cell itself is blank.
function readISRow(blockRows, label){
  const row = blockRows.find(r => r.some(c => cellText(c).toLowerCase() === label.toLowerCase()));
  if(!row) return {shopee:0, lazada:0, tiktok:0, total:0};
  const shopee = toNum(row[4]), lazada = toNum(row[5]), tiktok = toNum(row[6]);
  const total = toNum(row[7]) || (shopee + lazada + tiktok);
  return {shopee, lazada, tiktok, total};
}
// Marketplace income / GCash / Net income are single blended figures with no
// per-platform split — their value sits at index 4, not index 7.
function readISTotalOnly(blockRows, label){
  const row = blockRows.find(r => r.some(c => cellText(c).toLowerCase() === label.toLowerCase()));
  return {shopee:0, lazada:0, tiktok:0, total: row ? toNum(row[4]) : 0};
}
// Individual fee/revenue line items are whatever's typed between two anchor
// rows (e.g. "Revenue" through "Total revenues") — their exact wording
// varies month to month, so read the section generically rather than by a
// fixed label list.
function readISSection(blockRows, headerLabel, endLabel){
  const startI = blockRows.findIndex(r => r.some(c => cellText(c).toLowerCase() === headerLabel.toLowerCase()));
  const endI = blockRows.findIndex(r => r.some(c => cellText(c).toLowerCase() === endLabel.toLowerCase()));
  if(startI<0 || endI<0 || endI<=startI) return [];
  const out = [];
  for(let i=startI+1; i<endI; i++){
    const row = blockRows[i];
    const label = cellText(row[2]) || cellText(row[3]);
    const shopee = toNum(row[4]), lazada = toNum(row[5]), tiktok = toNum(row[6]);
    if(!label || (!shopee && !lazada && !tiktok)) continue;
    out.push({label, shopee, lazada, tiktok, total: shopee+lazada+tiktok});
  }
  return out;
}
function extractPlatformIncomeMonth(finWorkbook, monthName){
  const [name, yearStr] = monthName.split(" ");
  const block = findPlatformIncomeBlock(finWorkbook, name, yearStr);
  if(!block) return null;

  const rows = [];
  readISSection(block, "Revenue", "Total revenues").forEach((r,i) => rows.push({key:"rev"+i, label:r.label, group:"revenue", subtotal:false, ...r}));
  rows.push({key:"totalRevenues", label:"Total revenues", group:"revenue", subtotal:true, ...readISRow(block,"Total revenues")});
  readISSection(block, "Expenses", "Expenses per platform").forEach((r,i) => rows.push({key:"exp"+i, label:r.label, group:"expenses", subtotal:false, ...r}));
  rows.push({key:"expensesPerPlatform", label:"Expenses per platform", group:"expenses", subtotal:true, ...readISRow(block,"Expenses per platform")});
  rows.push({key:"netIncomeBeforeTaxes", label:"Net income before taxes", group:"grand", subtotal:false, ...readISRow(block,"Net Income Before Taxes")});
  rows.push({key:"totalExpensesOperating", label:"Total expenses (operating)", group:"operating", subtotal:false, ...readISRow(block,"Total Expenses")});
  rows.push({key:"totalGrossIncome", label:"Total gross income per platform", group:"rollup", subtotal:false, ...readISRow(block,"Total Gross Income per platform")});
  rows.push({key:"totalCapital", label:"Total capital per platform", group:"rollup", subtotal:false, ...readISRow(block,"Total Capital per Platform")});
  rows.push({key:"netIncomePerPlatform", label:"Net income per platform", group:"rollup", subtotal:true, ...readISRow(block,"Net Income per platform")});
  rows.push({key:"marketplaceIncome", label:"Marketplace income", group:"other", subtotal:false, ...readISTotalOnly(block,"MarketPlace Income")});
  rows.push({key:"gcash", label:"GCash / load / bills payment", group:"other", subtotal:false, ...readISTotalOnly(block,"Gcash/Load/BillsPayment")});
  rows.push({key:"netIncome", label:"Net income", group:"grand", subtotal:false, ...readISTotalOnly(block,"Net Income")});
  return rows;
}
// scan the workbook for every "Income Statement — <Month> <Year>" block that
// actually has revenue logged (skips future empty placeholder months).
function findAvailablePlatformMonths(finWorkbook){
  const found = [];
  for(const name of finWorkbook.SheetNames){
    const rows = sheetRows(finWorkbook, name);
    if(!rows) continue;
    rows.forEach(r => {
      const joined = r.map(cellText).join(" ").replace(/[–—]/g,"-");
      const m = joined.match(/Income Statement\s*-\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
      if(m) found.push(m[1].charAt(0).toUpperCase()+m[1].slice(1).toLowerCase()+" "+m[2]);
    });
  }
  return [...new Set(found)].filter(m => {
    const rows = extractPlatformIncomeMonth(finWorkbook, m);
    const tr = rows && rows.find(r=>r.key==="totalRevenues");
    return tr && tr.total > 0;
  });
}
function sortMonthNames(names){
  const parsed = names.map(n => ({n, d: new Date(n + " 1")}));
  if(parsed.every(p => !isNaN(p.d.getTime()))) return parsed.sort((a,b)=>a.d-b.d).map(p=>p.n);
  return [...names];
}
function monthYear(name){
  const d = new Date(name + " 1");
  return isNaN(d.getTime()) ? null : d.getFullYear();
}
// Only the fixed summary rows have a stable key across every month — the
// detail revenue/expense line items vary in wording month to month (see
// readISSection), so they aren't safe to sum across months by position.
const YTD_FIXED_ROWS = [
  {key:"totalRevenues", label:"Total revenues", group:"revenue", subtotal:true},
  {key:"expensesPerPlatform", label:"Expenses per platform", group:"expenses", subtotal:true},
  {key:"netIncomeBeforeTaxes", label:"Net income before taxes", group:"grand"},
  {key:"totalExpensesOperating", label:"Total expenses (operating)", group:"operating"},
  {key:"totalGrossIncome", label:"Total gross income per platform", group:"rollup"},
  {key:"totalCapital", label:"Total capital per platform", group:"rollup"},
  {key:"netIncomePerPlatform", label:"Net income per platform", group:"rollup", subtotal:true},
  {key:"marketplaceIncome", label:"Marketplace income", group:"other"},
  {key:"gcash", label:"GCash / load / bills payment", group:"other"},
  {key:"netIncome", label:"Net income", group:"grand"},
];
function computeYTD(workbook, months){
  if(!months.length) return null;
  const years = months.map(monthYear).filter(y=>y!==null);
  const thisYear = new Date().getFullYear();
  const targetYear = years.includes(thisYear) ? thisYear : Math.max(...years, 0);
  const ytdMonths = months.filter(m => monthYear(m) === targetYear);
  const perMonth = ytdMonths.map(m => ({ m, rows: extractPlatformIncomeMonth(workbook, m) })).filter(x=>x.rows);
  if(!perMonth.length) return null;
  const agg = YTD_FIXED_ROWS.map(def => ({ key:def.key, label:def.label, group:def.group, subtotal:!!def.subtotal, shopee:0, lazada:0, tiktok:0, total:0 }));
  perMonth.forEach(({rows}) => rows.forEach(r => {
    const a = agg.find(x=>x.key===r.key);
    if(!a) return; // skip dynamic-labeled detail line items
    a.shopee += r.shopee; a.lazada += r.lazada; a.tiktok += r.tiktok; a.total += r.total;
  }));
  return { rows: agg, months: ytdMonths, year: targetYear };
}

/* ========================= YTD PRODUCT PERFORMANCE (LIVE) ========================= */
// Same channel-column logic verified against the live dashboard's own Channel
// Summary totals (Lazada "Item"/qty/subtotal in cols E/G/I; Shopee/Tiktok
// "Product"+"Variation" in cols E/F, qty in col I, subtotal in col K for
// Shopee / col J for Tiktok; Marketplace product/qty in cols D/E and the true
// line subtotal in col I — NOT the "Amount" unit-price column F). Rows start
// at sheet row 5 (index 4) in every monthly tracker.
function normWS(s){ return String(s).replace(/\s+/g,' ').trim(); }
// merge is case-insensitive by key, but prefer a properly-capitalized display
// name over an all-lowercase one when different months typed the same
// product differently (e.g. "conaprole" in Jan-Apr vs "Conaprole" from May on).
function looksProperCased(s){ return /^[A-Z]/.test(s); }
function addYTDAgg(agg, rawName, q, rev){
  const name = normWS(rawName);
  if(!name) return;
  const key = name.toLowerCase();
  if(!agg[key]){
    agg[key] = { n: name, q: 0, r: 0 };
  } else if(!looksProperCased(agg[key].n) && looksProperCased(name)){
    agg[key].n = name;
  }
  agg[key].q += q; agg[key].r += rev;
}
function ytdProcessLazada(rows, agg){
  for(let r=4; r<rows.length; r++){
    const row = rows[r] || [];
    const item = row[4];
    if(cellText(item) === "") continue;
    const q = toNum(row[6]), rev = toNum(row[8]);
    if(q===0 && rev===0) continue;
    addYTDAgg(agg, item, q, rev);
  }
}
function ytdProcessShopeeTiktok(rows, agg, subtotalCol){
  for(let r=4; r<rows.length; r++){
    const row = rows[r] || [];
    const pname = row[4];
    if(cellText(pname) === "") continue;
    const q = toNum(row[8]), rev = toNum(row[subtotalCol]);
    if(q===0 && rev===0) continue;
    let name = cellText(pname);
    const variation = cellText(row[5]);
    if(variation) name += " - " + variation;
    addYTDAgg(agg, name, q, rev);
  }
}
function ytdProcessMarketplace(rows, agg){
  for(let r=4; r<rows.length; r++){
    const row = rows[r] || [];
    const pname = row[3];
    if(cellText(pname) === "") continue;
    const q = toNum(row[4]), rev = toNum(row[8]);
    if(q===0 && rev===0) continue;
    addYTDAgg(agg, pname, q, rev);
  }
}
/* every "<Mon> <year> BIM Order Tracker" file for the current year, sitting
   in the same folder resolveOrderTrackerFile() already reads the "current
   month" file from — completed months are static .xlsx exports, the current
   month is a live native Sheet; both are handled identically by downloadWorkbook. */
async function resolveYTDOrderTrackerFiles(){
  const files = await listFolder(CONFIG.ORDER_TRACKER_FOLDER_ID);
  const year = String(new Date().getFullYear());
  return files.filter(f => /BIM Order Tracker/i.test(f.name) && f.name.includes(year));
}
// fileId -> {modifiedTime, agg} — a completed month's workbook never changes,
// so only the current month's file (whose modifiedTime keeps advancing) gets
// re-downloaded and re-parsed on each refresh.
const YTD_FILE_CACHE = {};
async function computeYTDLive(files){
  const merged = {};
  for(const f of files){
    const cached = YTD_FILE_CACHE[f.id];
    let fileAgg;
    if(cached && cached.modifiedTime === f.modifiedTime){
      fileAgg = cached.agg;
    } else {
      const { workbook } = await downloadWorkbook(f.id);
      fileAgg = {};
      const laz = sheetRows(workbook, 'Lazada');
      const shp = sheetRows(workbook, 'Shopee');
      const ttk = sheetRows(workbook, 'Tiktok');
      const mkt = sheetRows(workbook, 'Marketplace');
      if(laz) ytdProcessLazada(laz, fileAgg);
      if(shp) ytdProcessShopeeTiktok(shp, fileAgg, 10); // col K
      if(ttk) ytdProcessShopeeTiktok(ttk, fileAgg, 9);  // col J
      if(mkt) ytdProcessMarketplace(mkt, fileAgg);
      YTD_FILE_CACHE[f.id] = { modifiedTime: f.modifiedTime, agg: fileAgg };
    }
    for(const key in fileAgg){
      const p = fileAgg[key];
      if(!merged[key]){
        merged[key] = { n: p.n, q: 0, r: 0 };
      } else if(!looksProperCased(merged[key].n) && looksProperCased(p.n)){
        merged[key].n = p.n;
      }
      merged[key].q += p.q; merged[key].r += p.r;
    }
  }
  const round2 = n => Math.round(n * 100) / 100;
  const products = Object.values(merged)
    .map(p => ({ n: p.n, q: round2(p.q), r: round2(p.r) }))
    .sort((a,b) => b.r - a.r);
  const totalRevenue = round2(products.reduce((s,p) => s + p.r, 0));
  const totalUnits = round2(products.reduce((s,p) => s + p.q, 0));
  const now = new Date();
  return {
    asOf: now.toLocaleDateString('en-US', {year:'numeric', month:'short', day:'numeric'}),
    periodLabel: `Jan 1 – ${now.toLocaleDateString('en-US',{month:'short',day:'numeric'})}, ${now.getFullYear()}`,
    totalRevenue, totalUnits, products,
  };
}

/* ============================== ORCHESTRATION ============================== */
async function loadAll(){
  setStatus("loading");
  const errors = [];
  let salesWb, finWb, invWb, plWb;

  try{
    const otFile = await resolveOrderTrackerFile();
    salesWb = (await downloadWorkbook(otFile.id)).workbook;
  } catch(e){ errors.push("Order Tracker: " + e.message); }

  let finYear;
  try{
    window.IS_FILES = await listIncomeStatementFiles();
    const isFile = pickDefaultIncomeStatementFile(window.IS_FILES);
    if(!isFile) throw new Error("No Income Statement file found in the configured folder.");
    finWb = (await downloadWorkbook(isFile.id)).workbook;
    finYear = isFile.year;
  } catch(e){ errors.push("Income Statement: " + e.message); }

  try{
    invWb = (await downloadWorkbook(CONFIG.INVENTORY_FILE_ID)).workbook;
  } catch(e){ errors.push("Inventory: " + e.message); }

  try{
    plWb = (await downloadWorkbook(CONFIG.PRICELIST_FILE_ID)).workbook;
  } catch(e){ errors.push("Price List: " + e.message); }

  try{ if(salesWb) window.SALES_LIVE = extractSales(salesWb); } catch(e){ errors.push("Order Tracker parse: " + e.message); }
  try{ if(finWb) window.FIN_LIVE = extractFinancials(finWb); window.FIN_YEAR = finYear; } catch(e){ errors.push("Income Statement parse: " + e.message); }
  try{ if(invWb) window.INV_LIVE = extractInventory(invWb); } catch(e){ errors.push("Inventory parse: " + e.message); }
  try{ if(plWb) window.PL_LIVE = extractPriceList(plWb); } catch(e){ errors.push("Price List parse: " + e.message); }
  try{
    // Platform Report reuses the same Income Statement workbook — your own
    // sheet already has every month's Shopee/Lazada/TikTok breakdown, so
    // there's no separate file to fetch or keep in sync.
    if(finWb){
      window.PLATFORM_INCOME_WB = finWb;
      window.PLATFORM_INCOME_MONTHS = sortMonthNames(findAvailablePlatformMonths(finWb));
      if(finYear !== undefined) FIN_CACHE[finYear] = { workbook: finWb, fin: window.FIN_LIVE, months: window.PLATFORM_INCOME_MONTHS };
    }
  } catch(e){ errors.push("Platform Income parse: " + e.message); }

  renderAll();
  setStatus(errors.length ? "warn" : "live", errors);

  // YTD Product Performance re-downloads up to 9 monthly workbooks (cached
  // after the first pass — see YTD_FILE_CACHE), so it runs after the rest of
  // the dashboard is already rendered rather than blocking it.
  try{
    const ytdFiles = await resolveYTDOrderTrackerFiles();
    window.YTD_LIVE = await computeYTDLive(ytdFiles);
  } catch(e){
    console.error("YTD Performance:", e);
  }
  if(typeof activeTab !== "undefined" && activeTab === "ytd") renderYTD();
}

function startAutoRefresh(){
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadAll, REFRESH_MS);
}
