// ============================================================
// PharmaAlloc — Pharmaceutical Inventory Allocation System
// script.js — All logic, calculations, rendering, export
// ============================================================

// ─── State ───────────────────────────────────────────────────
const state = {
  branch: [],
  central: [],
  national: [],
  materialCodes: [],
  allocationData: [],
  filteredData: [],
  sortCol: null,
  sortDir: 1,
  charts: {}
};

// ─── Constants ──────────────────────────────────────────────
// Actual 13-column source format: Product ID | Code | Description | Material Type | SOH | AMC | MOS | Forecast | Delivered | Fill Rate Qty% | Forecast Value | Delivered Value | Fill Rate Value%
const COLS = {
  PRODUCT_ID: 0,        // col 1 — Product ID
  MATERIAL_CODE: 1,     // col 2 — Material Code
  DESCRIPTION: 2,       // col 3 — Description
  MATERIAL_TYPE: 3,     // col 4 — Material Type Code
  STOCK_ON_HAND: 4,     // col 5 — Stock on Hand
  AMC: 5,               // col 6 — AMC
  MOS: 6,               // col 7 — MOS
  FORECAST_QTY: 7,      // col 8 — Forecast Qty
  DELIVERED_QTY: 8,     // col 9 — Delivered Qty
  FILL_RATE_QTY: 9,     // col 10 — Fill Rate Qty % (auto-calc)
  FORECAST_VALUE: 10,   // col 11 — Forecast Value
  DELIVERED_VALUE: 11,  // col 12 — Delivered Value
  FILL_RATE_VALUE: 12   // col 13 — Fill Rate Value % (auto-calc)
};

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupTheme();
  setupDragDrop();
  setupFileInputs();
  setupExportDropdown();
  setupMenuToggle();
  setupDashTypeFilter();
  initCharts();
  loadSavedState();
});

// ─── Dashboard Type Filter ────────────────────────────────────
let dashTypeActive = '';

function setupDashTypeFilter() {
  document.querySelectorAll('.dash-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dashTypeActive = btn.dataset.type;
      document.querySelectorAll('.dash-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (state.allocationData.length) {
        updateDashboard(state.allocationData);
      }
    });
  });
}

// ─── Navigation ──────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');

  const titles = {
    'dashboard': ['Dashboard', 'Consolidated inventory overview'],
    'data-input': ['Data Input', 'Upload or paste source data'],
    'allocation': ['Allocation Report', 'Full calculated allocation table'],
    'materials': ['Materials', 'Manage tracked material codes']
  };
  const [title, sub] = titles[tab] || [tab, ''];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = sub;

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

// ─── Theme ───────────────────────────────────────────────────
function setupTheme() {
  const toggle = document.getElementById('themeToggle');
  const saved = localStorage.getItem('pharma-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  toggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pharma-theme', next);
    updateChartTheme();
  });
}

// ─── Menu Toggle (mobile) ────────────────────────────────────
function setupMenuToggle() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

// ─── Export Dropdown ─────────────────────────────────────────
function setupExportDropdown() {
  const btn = document.getElementById('exportBtn');
  const drop = document.getElementById('exportDropdown');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    drop.classList.toggle('open');
  });
  document.addEventListener('click', () => drop.classList.remove('open'));
}

// ─── Drag & Drop ─────────────────────────────────────────────
function setupDragDrop() {
  document.querySelectorAll('.upload-zone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const target = zone.dataset.target;
      const file = e.dataTransfer.files[0];
      if (file) processFile(file, target);
    });
  });
}

function setupFileInputs() {
  ['branch', 'central', 'national'].forEach(target => {
    const input = document.getElementById(`file-${target}`);
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) processFile(file, target);
      input.value = '';
    });
  });
}

// ─── File Processing ─────────────────────────────────────────
function processFile(file, target) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      loadTableData(data, target, file.name);
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = e => {
      const result = Papa.parse(e.target.result, { skipEmptyLines: true });
      loadTableData(result.data, target, file.name);
    };
    reader.readAsText(file);
  }
}

function parsePaste(target) {
  const text = document.getElementById(`paste-${target}`).value.trim();
  if (!text) { showToast('Please paste some data first', 'warn'); return; }
  const result = Papa.parse(text, { skipEmptyLines: true });
  loadTableData(result.data, target, 'pasted data');
}

function loadTableData(rows, target, sourceName) {
  if (!rows || rows.length < 2) {
    showToast(`No data found in ${sourceName}`, 'error'); return;
  }
  // Convert to indexed arrays for fast lookup
  const normalized = rows.slice(1)
    .filter(row => row.length >= 2 && row[0] !== '' && row[0] !== null)
    .map(row => row.map(v => v === '' || v === null || v === undefined ? null : v));

  state[target] = normalized;
  saveState();
  updateSourceStatus(target, normalized.length);
  renderDataPreview(target, normalized);
  showToast(`✓ Loaded ${normalized.length} rows from ${sourceName}`, 'success');
}

function updateSourceStatus(target, count) {
  const statusEl = document.getElementById(`status-${target}`);
  if (count > 0) {
    statusEl.innerHTML = `<span class="dot dot-loaded"></span> ${count} rows loaded`;
  } else {
    statusEl.innerHTML = `<span class="dot dot-error"></span> Empty`;
  }
}

function renderDataPreview(target, data) {
  const preview = document.getElementById(`preview-${target}`);
  if (data.length === 0) { preview.classList.remove('visible'); return; }
  const sample = data.slice(0, 3);
  preview.innerHTML = `<strong>${data.length} rows loaded.</strong> Preview: ${
    sample.map(r => `[${String(r[0]).substring(0,10)} — ${String(r[1]||'').substring(0,15)}]`).join(' ')
  }${data.length > 3 ? ` …+${data.length-3} more` : ''}`;
  preview.classList.add('visible');
}

// ─── Lookup Helpers ──────────────────────────────────────────
function buildIndex(data) {
  const idx = {};
  const duplicates = [];
  data.forEach(row => {
    const key = String(row[COLS.MATERIAL_CODE]).trim().toUpperCase();
    if (!key) return;
    if (idx[key]) {
      // Already seen — record duplicate, do NOT overwrite first occurrence
      if (!duplicates.includes(key)) duplicates.push(key);
    } else {
      // First time seeing this code — keep it
      idx[key] = row;
    }
  });
  if (duplicates.length > 0) {
    const preview = duplicates.slice(0, 5).join(', ');
    const extra = duplicates.length > 5 ? ` +${duplicates.length - 5} more` : '';
    showToast(`⚠️ Duplicate codes found (kept first): ${preview}${extra}`, 'warn');
  }
  return idx;
}

function vlookup(code, index, colIdx) {
  const row = index[String(code).trim().toUpperCase()];
  if (!row) return null;
  const val = row[colIdx];
  return (val === null || val === undefined || val === '') ? null : val;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  // Strip commas (e.g. "1,994,020.00") and % signs before parsing
  const cleaned = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ─── Core Allocation Formulas ────────────────────────────────
// Exactly mirrors the Excel formulas

function calcRow(matCode, branchIdx, centralIdx, nationalIdx) {
  const code = String(matCode).trim();
  if (!code) return null;

  // B: Description — from Branch CDSS col 2
  const description = vlookup(code, branchIdx, COLS.DESCRIPTION) || '';

  // C: Material Type — from Branch CDSS col 3 (updated)
  const materialType = vlookup(code, branchIdx, COLS.MATERIAL_TYPE) || '';

  // D: Branch SOH — from Branch CDSS col 4 (updated)
  const branchSOH = toNum(vlookup(code, branchIdx, COLS.STOCK_ON_HAND));

  // E: Central SOH — from Central Warehouse col 4 (updated)
  const centralSOH = toNum(vlookup(code, centralIdx, COLS.STOCK_ON_HAND));

  // F: National SOH — from National Branches col 4 (updated)
  const nationalSOH = toNum(vlookup(code, nationalIdx, COLS.STOCK_ON_HAND));

  // G: AMC — from Central Warehouse col 5
  const amc = toNum(vlookup(code, centralIdx, COLS.AMC));

  // NEW: Branch value & fill-rate columns (cols 9-12)
  const branchForecastValue  = toNum(vlookup(code, branchIdx, COLS.FORECAST_VALUE));
  const branchDeliveredValue = toNum(vlookup(code, branchIdx, COLS.DELIVERED_VALUE));
  // Fill Rate Qty % = Delivered Qty / Forecast Qty (mirrors Excel =IFERROR(H/G,""))
  // Fill Rate Value % = Delivered Value / Forecast Value
  let fillRateQtyPct = null;
  let fillRateValuePct = null;

  // H: MOS Central = ROUND(E/G, 1)
  let mosCentral = null;
  if (centralSOH !== null && amc !== null && amc !== 0) {
    mosCentral = Math.round(centralSOH / amc * 10) / 10;
  }

  // I: Branch Forecast Qty — from Branch CDSS col 7
  const branchForecast = toNum(vlookup(code, branchIdx, COLS.FORECAST_QTY));

  // J: Delivered Qty — from Branch CDSS col 8
  const deliveredQty = toNum(vlookup(code, branchIdx, COLS.DELIVERED_QTY));

  // K: Branch Remaining Need = Forecast - (SOH + Delivered)
  let branchRemainingNeed = null;
  if (branchForecast !== null && branchSOH !== null) {
    branchRemainingNeed = branchForecast - (branchSOH + (deliveredQty || 0));
  }

  // L: National Remaining Need = NatForecast - (NatSOH + NatDelivered - CentralSOH)
  let nationalRemainingNeed = null;
  if (nationalSOH !== null) {
    const natForecast = toNum(vlookup(code, nationalIdx, COLS.FORECAST_QTY));
    const natDelivered = toNum(vlookup(code, nationalIdx, COLS.DELIVERED_QTY));
    if (natForecast !== null) {
      nationalRemainingNeed = natForecast - (nationalSOH + (natDelivered || 0) - (centralSOH || 0));
    }
  }

  // M: Recommended Allocation
  // =IF(K<=0, 0, IF(L<=0, MIN(K,E), MAX(0, MIN(K, E, ROUND((K/ABS(L))*E, 0)))))
  let recommendedAllocation = null;
  if (branchRemainingNeed !== null) {
    if (branchRemainingNeed <= 0) {
      recommendedAllocation = 0;
    } else if (nationalRemainingNeed !== null && nationalRemainingNeed <= 0) {
      recommendedAllocation = Math.min(branchRemainingNeed, centralSOH || 0);
    } else {
      const rationed = nationalRemainingNeed !== null && nationalRemainingNeed !== 0
        ? Math.round((branchRemainingNeed / Math.abs(nationalRemainingNeed)) * (centralSOH || 0))
        : (centralSOH || 0);
      recommendedAllocation = Math.max(0, Math.min(
        branchRemainingNeed,
        centralSOH || 0,
        rationed
      ));
    }
  }

  // N: Allocation % = M / I
  let allocationPct = null;
  if (branchForecast !== null && branchForecast !== 0 && recommendedAllocation !== null) {
    allocationPct = recommendedAllocation / branchForecast;
  }

  // O: Allocation Status
  let allocationStatus = '';
  if (branchSOH !== null) {
    if (branchSOH === 0) {
      allocationStatus = 'Critical Shortage';
    } else if (branchRemainingNeed !== null) {
      if (branchRemainingNeed <= 0) {
        allocationStatus = 'No Need';
      } else if (recommendedAllocation !== null) {
        if (recommendedAllocation >= branchRemainingNeed) {
          allocationStatus = 'Full';
        } else if (nationalRemainingNeed !== null && nationalRemainingNeed > 0) {
          allocationStatus = 'Rationed';
        } else {
          allocationStatus = 'Partial';
        }
      }
    }
  }

  // P: Overstock Flag (Central) — MOS > 9
  let overstockFlag = '';
  if (mosCentral !== null) {
    overstockFlag = mosCentral > 9 ? 'OVERSTOCK' : 'OK';
  }

  // Q: Comments
  let comments = '';
  if (branchSOH === 0) {
    comments = 'CRITICAL: Zero Stock at Branch - urgent resupply needed';
  } else if (mosCentral !== null && mosCentral > 9) {
    comments = 'Central overstocked (MOS>9) - consider redistribution';
  } else if (allocationStatus === 'Rationed') {
    comments = 'Proportional rationing applied due to national shortage';
  } else if (allocationStatus === 'No Need') {
    comments = 'Branch adequately stocked; no allocation required';
  } else if (allocationStatus === 'Full') {
    comments = 'Full demand can be satisfied from Central';
  } else if (allocationStatus === 'Partial') {
    comments = 'Partial supply only - insufficient Central stock; monitor closely';
  }

  // R: Suggested Redistribution (Overstock)
  // =IF(P<>"OVERSTOCK", "", ROUND(I/NatForecast * E, 0))
  let suggestedRedistribution = null;
  if (overstockFlag === 'OVERSTOCK' && branchForecast !== null) {
    const natForecast = toNum(vlookup(code, nationalIdx, COLS.FORECAST_QTY));
    if (natForecast !== null && natForecast !== 0) {
      suggestedRedistribution = Math.round((branchForecast / natForecast) * (centralSOH || 0));
    }
  }

  // Compute fill rates now that branchForecast & deliveredQty are available
  if (branchForecast !== null && branchForecast !== 0 && deliveredQty !== null) {
    fillRateQtyPct = deliveredQty / branchForecast;
  }
  if (branchForecastValue !== null && branchForecastValue !== 0 && branchDeliveredValue !== null) {
    fillRateValuePct = branchDeliveredValue / branchForecastValue;
  }

  return {
    materialCode: code,
    description,
    materialType,
    branchSOH,
    centralSOH,
    nationalSOH,
    amc,
    mosCentral,
    branchForecast,
    deliveredQty,
    fillRateQtyPct,
    branchForecastValue,
    branchDeliveredValue,
    fillRateValuePct,
    branchRemainingNeed,
    nationalRemainingNeed,
    recommendedAllocation,
    allocationPct,
    allocationStatus,
    overstockFlag,
    comments,
    suggestedRedistribution
  };
}

// ─── Run All Calculations ────────────────────────────────────
function runAllCalculations() {
  if (state.branch.length === 0 && state.central.length === 0 && state.national.length === 0) {
    showToast('Please load at least one data source first', 'warn'); return;
  }

  const branchIdx = buildIndex(state.branch);
  const centralIdx = buildIndex(state.central);
  const nationalIdx = buildIndex(state.national);

  // Auto-populate material codes from loaded data if none set
  if (state.materialCodes.length === 0) {
    importMaterialCodesFromData();
    return; // importMaterialCodesFromData calls runAllCalculations again
  }

  const results = [];
  state.materialCodes.forEach(code => {
    const row = calcRow(code, branchIdx, centralIdx, nationalIdx);
    if (row) results.push(row);
  });

  state.allocationData = results;
  state.filteredData = [...results];
  saveState();
  renderAllocationTable(results);
  updateDashboard(results);
  showToast(`✓ Calculated ${results.length} items`, 'success');
  switchTab('allocation');
}

// ─── Dashboard ───────────────────────────────────────────────
function updateDashboard(data) {
  // Apply dashboard type filter
  const filtered = dashTypeActive
    ? data.filter(r => String(r.materialType || '').toUpperCase() === dashTypeActive)
    : data;

  // Update filter count badge
  const countEl = document.getElementById('dashFilterCount');
  if (countEl) {
    if (dashTypeActive) {
      countEl.textContent = `${filtered.length} of ${data.length} items`;
    } else {
      countEl.textContent = `${data.length} items total`;
    }
  }

  const total = filtered.length;
  const critical = filtered.filter(r => r.allocationStatus === 'Critical Shortage').length;
  const shortage = filtered.filter(r => r.allocationStatus === 'Partial' || r.allocationStatus === 'Rationed').length;
  const overstock = filtered.filter(r => r.overstockFlag === 'OVERSTOCK').length;
  const totalForecast = filtered.reduce((s, r) => s + (r.branchForecast || 0), 0);
  const totalAlloc = filtered.reduce((s, r) => s + (r.recommendedAllocation || 0), 0);
  const pcts = filtered.filter(r => r.allocationPct !== null && r.allocationPct > 0).map(r => r.allocationPct);
  const avgPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
  const totalCentralSOH = filtered.reduce((s, r) => s + (r.centralSOH || 0), 0);

  document.getElementById('kpi-total').textContent = total.toLocaleString();
  document.getElementById('kpi-critical').textContent = critical.toLocaleString();
  document.getElementById('kpi-shortage').textContent = shortage.toLocaleString();
  document.getElementById('kpi-overstock').textContent = overstock.toLocaleString();
  document.getElementById('kpi-forecast').textContent = totalForecast.toLocaleString();
  document.getElementById('kpi-allocation').textContent = totalAlloc.toLocaleString();
  document.getElementById('kpi-avgpct').textContent = (avgPct * 100).toFixed(1) + '%';
  document.getElementById('kpi-centralsoh').textContent = totalCentralSOH.toLocaleString();

  updateStatusChart(filtered);
  updateUrgentChart(filtered);
  renderUrgentTable(filtered);
  renderOverstockTable(filtered);
}

// ─── Charts ──────────────────────────────────────────────────
function initCharts() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#94a3b8' : '#718096';

  // Status Donut
  const sCtx = document.getElementById('statusChart').getContext('2d');
  state.charts.status = new Chart(sCtx, {
    type: 'doughnut',
    data: {
      labels: ['Critical', 'Rationed', 'Partial', 'Full', 'No Need'],
      datasets: [{
        data: [0, 0, 0, 0, 0],
        backgroundColor: ['#e53e3e','#d69e2e','#dd6b20','#38a169','#718096'],
        borderWidth: 2,
        borderColor: isDark ? '#1f2937' : '#ffffff'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, font: { family: 'DM Sans', size: 11 }, padding: 12 } }
      }
    }
  });

  // Urgent Bar
  const uCtx = document.getElementById('urgentChart').getContext('2d');
  state.charts.urgent = new Chart(uCtx, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Remaining Need', data: [], backgroundColor: '#e53e3e', borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textColor, font: { family: 'DM Mono', size: 10 } }, grid: { color: isDark ? '#374151' : '#e2e8f0' } },
        y: { ticks: { color: textColor, font: { family: 'DM Mono', size: 10 } }, grid: { display: false } }
      }
    }
  });
}

function updateStatusChart(data) {
  const counts = {
    'Critical Shortage': 0, 'Rationed': 0, 'Partial': 0, 'Full': 0, 'No Need': 0
  };
  data.forEach(r => { if (r.allocationStatus in counts) counts[r.allocationStatus]++; });
  const c = state.charts.status;
  c.data.datasets[0].data = Object.values(counts);
  c.update();
}

function updateUrgentChart(data) {
  const urgent = [...data]
    .filter(r => r.branchRemainingNeed !== null && r.branchRemainingNeed > 0)
    .sort((a, b) => b.branchRemainingNeed - a.branchRemainingNeed)
    .slice(0, 10);
  const c = state.charts.urgent;
  c.data.labels = urgent.map(r => r.materialCode);
  c.data.datasets[0].data = urgent.map(r => r.branchRemainingNeed);
  c.update();
}

function updateChartTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#94a3b8' : '#718096';
  const gridColor = isDark ? '#374151' : '#e2e8f0';
  const borderColor = isDark ? '#1f2937' : '#ffffff';

  if (state.charts.status) {
    state.charts.status.data.datasets[0].borderColor = borderColor;
    state.charts.status.options.plugins.legend.labels.color = textColor;
    state.charts.status.update();
  }
  if (state.charts.urgent) {
    state.charts.urgent.options.scales.x.ticks.color = textColor;
    state.charts.urgent.options.scales.y.ticks.color = textColor;
    state.charts.urgent.options.scales.x.grid.color = gridColor;
    state.charts.urgent.update();
  }
}

// ─── Dashboard Tables ─────────────────────────────────────────
function renderUrgentTable(data) {
  const top10 = [...data]
    .filter(r => r.branchRemainingNeed !== null && r.branchRemainingNeed > 0)
    .sort((a, b) => b.branchRemainingNeed - a.branchRemainingNeed)
    .slice(0, 10);

  const tbody = document.getElementById('urgentTbody');
  if (!top10.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state"><div class="empty-icon">✅</div><p>No urgent items found</p></td></tr>`;
    return;
  }
  tbody.innerHTML = top10.map(r => `
    <tr>
      <td class="text-mono">${esc(r.materialCode)}</td>
      <td>${esc(r.description)}</td>
      <td>${typeBadge(r.materialType)}</td>
      <td class="num">${fmt(r.branchSOH)}</td>
      <td class="num">${fmt(r.centralSOH)}</td>
      <td class="num">${fmt(r.branchForecast)}</td>
      <td class="num"><strong>${fmt(r.branchRemainingNeed)}</strong></td>
      <td class="num">${fmt(r.recommendedAllocation)}</td>
      <td>${statusChip(r.allocationStatus)}</td>
    </tr>
  `).join('');
}

function renderOverstockTable(data) {
  const top10 = [...data]
    .filter(r => r.overstockFlag === 'OVERSTOCK')
    .sort((a, b) => (b.mosCentral || 0) - (a.mosCentral || 0))
    .slice(0, 10);

  const tbody = document.getElementById('overstockTbody');
  if (!top10.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><div class="empty-icon">✅</div><p>No overstock items found</p></td></tr>`;
    return;
  }
  tbody.innerHTML = top10.map(r => `
    <tr>
      <td class="text-mono">${esc(r.materialCode)}</td>
      <td>${esc(r.description)}</td>
      <td>${typeBadge(r.materialType)}</td>
      <td class="num">${fmt(r.centralSOH)}</td>
      <td class="num">${fmt(r.amc)}</td>
      <td class="num"><strong>${mosCell(r.mosCentral)}</strong></td>
      <td class="num">${fmt(r.branchForecast)}</td>
      <td><span class="status-chip overstock-yes">OVERSTOCK</span></td>
    </tr>
  `).join('');
}

// ─── Allocation Table ─────────────────────────────────────────
function renderAllocationTable(data) {
  state.filteredData = [...data];
  applyFilters();
}

function filterTable() { applyFilters(); }

function clearFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterType').value = '';
  document.getElementById('filterOverstock').value = '';
  applyFilters();
}

function applyFilters() {
  let data = [...state.allocationData];
  const search = document.getElementById('searchInput').value.toLowerCase();
  const fStatus = document.getElementById('filterStatus').value;
  const fType = document.getElementById('filterType').value;
  const fOverstock = document.getElementById('filterOverstock').value;

  if (search) {
    data = data.filter(r =>
      r.materialCode.toLowerCase().includes(search) ||
      r.description.toLowerCase().includes(search)
    );
  }
  if (fStatus) data = data.filter(r => r.allocationStatus === fStatus);
  if (fType) data = data.filter(r => String(r.materialType).toUpperCase() === fType.toUpperCase());
  if (fOverstock) data = data.filter(r => r.overstockFlag === fOverstock);

  // Highlight active selects
  ['filterStatus','filterType','filterOverstock'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.toggle('filter-active', !!el.value);
  });

  // Show/hide clear button
  const hasFilter = search || fStatus || fType || fOverstock;
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.style.display = hasFilter ? '' : 'none';

  if (state.sortCol) {
    data.sort((a, b) => {
      const va = a[state.sortCol] ?? '';
      const vb = b[state.sortCol] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * state.sortDir;
      return String(va).localeCompare(String(vb)) * state.sortDir;
    });
  }

  state.filteredData = data;
  document.getElementById('filterCount').textContent = `${data.length} item${data.length !== 1 ? 's' : ''}`;
  drawAllocationTbody(data);
}

function sortTable(col) {
  if (state.sortCol === col) {
    state.sortDir *= -1;
  } else {
    state.sortCol = col;
    state.sortDir = 1;
  }
  applyFilters();
}

function drawAllocationTbody(data) {
  const tbody = document.getElementById('allocationTbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="15" class="empty-state"><div class="empty-icon">🔍</div><p>No matching records found.</p></td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => `
    <tr>
      <td class="text-mono mat-code">${esc(r.materialCode)}</td>
      <td>${esc(r.description)}</td>
      <td>${typeBadge(r.materialType)}</td>
      <td class="num"><strong>${fmt(r.recommendedAllocation)}</strong></td>
      <td class="num">${fmt(r.branchSOH)}</td>
      <td class="num">${fmt(r.centralSOH)}</td>
      <td class="num">${fmt(r.nationalSOH)}</td>
      <td class="num">${fmt(r.branchForecast)}</td>
      <td class="num">${fmt(r.deliveredQty)}</td>
      <td class="num">${fillRateCell(r.fillRateQtyPct)}</td>
      <td class="num ${r.branchRemainingNeed > 0 ? 'text-danger' : ''}">${fmt(r.branchRemainingNeed)}</td>
      <td class="num">${fmt(r.nationalRemainingNeed)}</td>
      <td>${statusChip(r.allocationStatus)}</td>
      <td style="max-width:220px;font-size:.72rem;color:var(--text-3)">${esc(r.comments)}</td>
      <td class="num">${fmt(r.suggestedRedistribution)}</td>
    </tr>
  `).join('');
}

// ─── Material Codes Management ────────────────────────────────
function addMaterialRow() {
  const tbody = document.getElementById('materialTbody');
  const idx = tbody.querySelectorAll('tr').length;
  const tr = document.createElement('tr');
  tr.className = 'material-row';
  tr.dataset.idx = idx;
  tr.innerHTML = `
    <td>${idx + 1}</td>
    <td><input type="text" class="mat-code-input" placeholder="e.g. MAT${String(idx+1).padStart(3,'0')}" /></td>
    <td><input type="text" class="mat-note-input" placeholder="Optional note" /></td>
    <td><button class="btn-icon btn-danger-icon" onclick="removeMaterialRow(this)">×</button></td>
  `;
  tbody.appendChild(tr);
}

function removeMaterialRow(btn) {
  btn.closest('tr').remove();
  renumberMaterialRows();
}

function renumberMaterialRows() {
  document.querySelectorAll('#materialTbody tr').forEach((tr, i) => {
    tr.querySelector('td:first-child').textContent = i + 1;
  });
}

function applyMaterialCodes() {
  const inputs = document.querySelectorAll('.mat-code-input');
  const codes = [...inputs].map(i => i.value.trim().toUpperCase()).filter(c => c);
  if (!codes.length) { showToast('No material codes entered', 'warn'); return; }
  state.materialCodes = codes;
  runAllCalculations();
}

function importMaterialCodesFromData() {
  const allCodes = new Set();
  [...state.branch, ...state.central, ...state.national].forEach(row => {
    const code = String(row[COLS.MATERIAL_CODE] || '').trim().toUpperCase();
    if (code) allCodes.add(code);
  });
  if (!allCodes.size) { showToast('No data loaded to detect codes from', 'warn'); return; }
  state.materialCodes = [...allCodes].sort();
  populateMaterialTable(state.materialCodes);
  showToast(`Detected ${state.materialCodes.length} material codes`, 'success');
  if (state.branch.length || state.central.length || state.national.length) {
    runAllCalculations();
  }
}

function populateMaterialTable(codes) {
  const tbody = document.getElementById('materialTbody');
  tbody.innerHTML = codes.map((code, i) => `
    <tr class="material-row" data-idx="${i}">
      <td>${i+1}</td>
      <td><input type="text" class="mat-code-input" value="${esc(code)}" /></td>
      <td><input type="text" class="mat-note-input" placeholder="Optional note" /></td>
      <td><button class="btn-icon btn-danger-icon" onclick="removeMaterialRow(this)">×</button></td>
    </tr>
  `).join('');
}

function clearMaterialCodes() {
  document.getElementById('materialTbody').innerHTML = `
    <tr class="material-row" data-idx="0">
      <td>1</td>
      <td><input type="text" class="mat-code-input" placeholder="e.g. MAT001" /></td>
      <td><input type="text" class="mat-note-input" placeholder="Optional note" /></td>
      <td><button class="btn-icon btn-danger-icon" onclick="removeMaterialRow(this)">×</button></td>
    </tr>`;
  state.materialCodes = [];
}

function parseMaterialPaste() {
  const text = document.getElementById('pasteMaterials').value.trim();
  if (!text) { showToast('No codes to load', 'warn'); return; }
  const codes = text.split('\n').map(l => l.trim().toUpperCase()).filter(c => c);
  state.materialCodes = codes;
  populateMaterialTable(codes);
  showToast(`Loaded ${codes.length} material codes`, 'success');
}

// ─── Sample Data ──────────────────────────────────────────────
function loadSampleData() {
  // New 12-column format: Code|Description|MatType|SOH|AMC|MOS|ForecastQty|DeliveredQty|FillRateQty%|ForecastValue|DeliveredValue|FillRateValue%
  const sampleBranch = [
    ['Material Code','Description','Material Type Code','Stock on Hand','AMC','MOS','Forecast Qty','Delivered Qty','Fill Rate Qty %','Forecast Value','Delivered Value','Fill Rate Value %'],
    ['MAT001','Paracetamol 500mg Tablets','ZME','1200','300','4','500','200','','25000','10000',''],
    ['MAT002','Amoxicillin 250mg Capsules','ZME','0','150','0','300','0','','15000','0',''],
    ['MAT003','Metformin 500mg Tablets','ZME','450','180','2.5','400','100','','20000','5000',''],
    ['MAT004','Atorvastatin 20mg Tablets','ZME','800','120','6.7','200','80','','10000','4000',''],
    ['MAT005','Omeprazole 20mg Capsules','ZME','50','200','0.25','350','20','','17500','1000',''],
    ['MAT006','Amlodipine 5mg Tablets','ZME','0','100','0','150','0','','7500','0',''],
    ['MAT007','Metronidazole 400mg Tablets','ZMS','300','90','3.3','180','60','','9000','3000',''],
    ['MAT008','Ciprofloxacin 500mg Tablets','ZME','750','250','3','300','100','','15000','5000',''],
    ['MAT009','Ibuprofen 400mg Tablets','ZME','100','400','0.25','600','50','','30000','2500',''],
    ['MAT010','Furosemide 40mg Tablets','ZME','200','80','2.5','120','40','','6000','2000',''],
    ['MAT011','Salbutamol 100mcg Inhaler','ZMS','60','30','2','80','10','','4000','500',''],
    ['MAT012','Prednisolone 5mg Tablets','ZME','900','60','15','100','50','','5000','2500',''],
    ['MAT013','Doxycycline 100mg Capsules','ZME','0','70','0','100','0','','5000','0',''],
    ['MAT014','Chloroquine 250mg Tablets','ZMS','1500','200','7.5','400','200','','20000','10000',''],
    ['MAT015','Co-trimoxazole 480mg Tablets','ZME','250','350','0.71','500','0','','25000','0',''],
  ];
  const sampleCentral = [
    ['Material Code','Description','Material Type Code','Stock on Hand','AMC','MOS','Forecast Qty','Delivered Qty','Fill Rate Qty %','Forecast Value','Delivered Value','Fill Rate Value %'],
    ['MAT001','Paracetamol 500mg Tablets','ZME','8500','300','28.3','1500','600','','75000','30000',''],
    ['MAT002','Amoxicillin 250mg Capsules','ZME','1200','150','8','900','300','','45000','15000',''],
    ['MAT003','Metformin 500mg Tablets','ZME','4000','180','22.2','1200','400','','60000','20000',''],
    ['MAT004','Atorvastatin 20mg Tablets','ZME','600','120','5','600','200','','30000','10000',''],
    ['MAT005','Omeprazole 20mg Capsules','ZME','3500','200','17.5','1050','200','','52500','10000',''],
    ['MAT006','Amlodipine 5mg Tablets','ZME','800','100','8','450','100','','22500','5000',''],
    ['MAT007','Metronidazole 400mg Tablets','ZMS','500','90','5.6','540','180','','27000','9000',''],
    ['MAT008','Ciprofloxacin 500mg Tablets','ZME','2000','250','8','900','300','','45000','15000',''],
    ['MAT009','Ibuprofen 400mg Tablets','ZME','1500','400','3.75','1800','150','','90000','7500',''],
    ['MAT010','Furosemide 40mg Tablets','ZME','400','80','5','360','120','','18000','6000',''],
    ['MAT011','Salbutamol 100mcg Inhaler','ZMS','600','30','20','240','30','','12000','1500',''],
    ['MAT012','Prednisolone 5mg Tablets','ZME','7200','60','120','300','150','','15000','7500',''],
    ['MAT013','Doxycycline 100mg Capsules','ZME','500','70','7.1','300','0','','15000','0',''],
    ['MAT014','Chloroquine 250mg Tablets','ZMS','15000','200','75','1200','600','','60000','30000',''],
    ['MAT015','Co-trimoxazole 480mg Tablets','ZME','1000','350','2.86','1500','0','','75000','0',''],
  ];
  const sampleNational = [
    ['Material Code','Description','Material Type Code','Stock on Hand','AMC','MOS','Forecast Qty','Delivered Qty','Fill Rate Qty %','Forecast Value','Delivered Value','Fill Rate Value %'],
    ['MAT001','Paracetamol 500mg Tablets','ZME','25000','300','83.3','4500','1800','','225000','90000',''],
    ['MAT002','Amoxicillin 250mg Capsules','ZME','3600','150','24','2700','900','','135000','45000',''],
    ['MAT003','Metformin 500mg Tablets','ZME','12000','180','66.7','3600','1200','','180000','60000',''],
    ['MAT004','Atorvastatin 20mg Tablets','ZME','1800','120','15','1800','600','','90000','30000',''],
    ['MAT005','Omeprazole 20mg Capsules','ZME','10500','200','52.5','3150','600','','157500','30000',''],
    ['MAT006','Amlodipine 5mg Tablets','ZME','2400','100','24','1350','300','','67500','15000',''],
    ['MAT007','Metronidazole 400mg Tablets','ZMS','1500','90','16.7','1620','540','','81000','27000',''],
    ['MAT008','Ciprofloxacin 500mg Tablets','ZME','6000','250','24','2700','900','','135000','45000',''],
    ['MAT009','Ibuprofen 400mg Tablets','ZME','4500','400','11.25','5400','450','','270000','22500',''],
    ['MAT010','Furosemide 40mg Tablets','ZME','1200','80','15','1080','360','','54000','18000',''],
    ['MAT011','Salbutamol 100mcg Inhaler','ZMS','1800','30','60','720','90','','36000','4500',''],
    ['MAT012','Prednisolone 5mg Tablets','ZME','21600','60','360','900','450','','45000','22500',''],
    ['MAT013','Doxycycline 100mg Capsules','ZME','1500','70','21.4','900','0','','45000','0',''],
    ['MAT014','Chloroquine 250mg Tablets','ZMS','45000','200','225','3600','1800','','180000','90000',''],
    ['MAT015','Co-trimoxazole 480mg Tablets','ZME','3000','350','8.57','4500','0','','225000','0',''],
  ];

  state.branch = sampleBranch.slice(1);
  state.central = sampleCentral.slice(1);
  state.national = sampleNational.slice(1);

  updateSourceStatus('branch', state.branch.length);
  updateSourceStatus('central', state.central.length);
  updateSourceStatus('national', state.national.length);
  renderDataPreview('branch', state.branch);
  renderDataPreview('central', state.central);
  renderDataPreview('national', state.national);

  state.materialCodes = state.branch.map(r => String(r[0]).trim().toUpperCase());
  populateMaterialTable(state.materialCodes);
  showToast('Sample data loaded!', 'success');
  saveState();
  runAllCalculations();
}

function clearAllData() {
  state.branch = [];
  state.central = [];
  state.national = [];
  state.materialCodes = [];
  state.allocationData = [];
  state.filteredData = [];
  ['branch','central','national'].forEach(t => {
    updateSourceStatus(t, 0);
    document.getElementById(`preview-${t}`).classList.remove('visible');
  });
  document.getElementById('allocationTbody').innerHTML = `
    <tr><td colspan="15" class="empty-state">
      <div class="empty-icon">📋</div>
      <p>No allocation data yet.</p>
      <p>Go to <strong>Data Input</strong> to load your source data.</p>
    </td></tr>`;
  updateDashboard([]);
  clearMaterialCodes();
  showToast('All data cleared', 'warn');
}

// ─── Export ───────────────────────────────────────────────────
function exportAsCSV() {
  if (!state.filteredData.length) { showToast('No data to export', 'warn'); return; }
  const headers = [
    'Material Code','Description','Material Type','Recommended Allocation',
    'Branch SOH','Central SOH','National SOH',
    'Branch Forecast Qty','Delivered Qty','Fill Rate Qty %',
    'Branch Remaining Need','National Remaining Need',
    'Allocation Status','Comments','Suggested Redistribution'
  ];
  const rows = state.filteredData.map(r => [
    r.materialCode, r.description, r.materialType, r.recommendedAllocation,
    r.branchSOH, r.centralSOH, r.nationalSOH,
    r.branchForecast, r.deliveredQty,
    r.fillRateQtyPct !== null ? (r.fillRateQtyPct*100).toFixed(2)+'%' : '',
    r.branchRemainingNeed, r.nationalRemainingNeed,
    r.allocationStatus, r.comments, r.suggestedRedistribution
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n');
  downloadFile(csv, 'pharma-allocation-report.csv', 'text/csv');
  showToast('CSV exported!', 'success');
}

function exportAsExcel() {
  if (!state.filteredData.length) { showToast('No data to export', 'warn'); return; }
  const headers = [
    'Material Code','Description','Material Type','Recommended Allocation',
    'Branch SOH','Central SOH','National SOH',
    'Branch Forecast Qty','Delivered Qty','Fill Rate Qty %',
    'Branch Remaining Need','National Remaining Need',
    'Allocation Status','Comments','Suggested Redistribution'
  ];
  const rows = state.filteredData.map(r => [
    r.materialCode, r.description, r.materialType, r.recommendedAllocation ?? '',
    r.branchSOH ?? '', r.centralSOH ?? '', r.nationalSOH ?? '',
    r.branchForecast ?? '', r.deliveredQty ?? '',
    r.fillRateQtyPct !== null ? r.fillRateQtyPct : '',
    r.branchRemainingNeed ?? '', r.nationalRemainingNeed ?? '',
    r.allocationStatus, r.comments, r.suggestedRedistribution ?? ''
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Column widths
  ws['!cols'] = [14,28,8,18,10,10,10,12,12,10,18,20,16,40,20].map(w => ({wch:w}));

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Allocation Report');

  // Add KPI sheet
  const kpiData = [
    ['KPI','Value'],
    ['Total Items Tracked', state.allocationData.length],
    ['Critical Shortages', state.allocationData.filter(r=>r.allocationStatus==='Critical Shortage').length],
    ['Items with Shortage (Partial+Rationed)', state.allocationData.filter(r=>r.allocationStatus==='Partial'||r.allocationStatus==='Rationed').length],
    ['Overstock Items (MOS>9)', state.allocationData.filter(r=>r.overstockFlag==='OVERSTOCK').length],
    ['Total Forecast Qty', state.allocationData.reduce((s,r)=>s+(r.branchForecast||0),0)],
    ['Total Recommended Allocation', state.allocationData.reduce((s,r)=>s+(r.recommendedAllocation||0),0)],
    ['Report Date', new Date().toLocaleDateString()],
    ['Facility', document.getElementById('facilityName').value || 'N/A'],
    ['Period', document.getElementById('reportingPeriod').value || 'N/A'],
  ];
  const wsKPI = XLSX.utils.aoa_to_sheet(kpiData);
  wsKPI['!cols'] = [{wch:35},{wch:20}];
  XLSX.utils.book_append_sheet(wb, wsKPI, 'Dashboard KPIs');

  XLSX.writeFile(wb, 'pharma-allocation-report.xlsx');
  showToast('Excel exported!', 'success');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Persistence ──────────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem('pharma-branch', JSON.stringify(state.branch));
    localStorage.setItem('pharma-central', JSON.stringify(state.central));
    localStorage.setItem('pharma-national', JSON.stringify(state.national));
    localStorage.setItem('pharma-materials', JSON.stringify(state.materialCodes));
  } catch(e) {
    showToast('⚠️ Data too large to auto-save. Export your report before closing this tab.', 'warn');
  }
}

function loadSavedState() {
  try {
    const branch = localStorage.getItem('pharma-branch');
    const central = localStorage.getItem('pharma-central');
    const national = localStorage.getItem('pharma-national');
    const materials = localStorage.getItem('pharma-materials');
    if (branch) { state.branch = JSON.parse(branch); updateSourceStatus('branch', state.branch.length); renderDataPreview('branch', state.branch); }
    if (central) { state.central = JSON.parse(central); updateSourceStatus('central', state.central.length); renderDataPreview('central', state.central); }
    if (national) { state.national = JSON.parse(national); updateSourceStatus('national', state.national.length); renderDataPreview('national', state.national); }
    if (materials) {
      state.materialCodes = JSON.parse(materials);
      if (state.materialCodes.length) populateMaterialTable(state.materialCodes);
    }
    if (state.materialCodes.length && (state.branch.length || state.central.length || state.national.length)) {
      runAllCalculations();
      switchTab('dashboard');
    }
  } catch(e) { /* ignore */ }
}

// ─── Helpers ─────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (isNaN(n)) return '—';
  return n.toLocaleString();
}
function statusChip(status) {
  const map = {
    'Critical Shortage': 'status-chip status-critical',
    'Rationed': 'status-chip status-rationed',
    'Partial': 'status-chip status-partial',
    'Full': 'status-chip status-full',
    'No Need': 'status-chip status-noneed',
  };
  const cls = map[status] || '';
  return cls ? `<span class="${cls}">${esc(status)}</span>` : esc(status);
}

function typeBadge(type) {
  const t = String(type || '').toUpperCase();
  const clsMap = { ZME: 'type-zme', ZMS: 'type-zms', ZLC: 'type-zlc', ZMD: 'type-zmd' };
  const cls = clsMap[t] || 'type-other';
  return `<span class="type-badge ${cls}">${esc(t) || '—'}</span>`;
}

function fillRateCell(pct) {
  if (pct === null) return '—';
  const val = (pct * 100).toFixed(1) + '%';
  if (pct >= 0.9) return `<span class="fill-high">${val}</span>`;
  if (pct >= 0.5) return `<span class="fill-mid">${val}</span>`;
  return `<span class="fill-low">${val}</span>`;
}

function mosCell(mos) {
  if (mos === null) return '—';
  const v = mos.toFixed(1);
  if (mos === 0) return `<span class="mos-critical">${v}</span>`;
  if (mos < 3) return `<span class="mos-warn">${v}</span>`;
  if (mos > 9) return `<span class="mos-over">${v}</span>`;
  return `<span class="mos-ok">${v}</span>`;
}

function allocPctCell(pct) {
  if (pct === null) return '—';
  const val = (pct * 100).toFixed(1);
  const fillCls = pct >= 0.9 ? 'full' : pct >= 0.5 ? 'mid' : 'low';
  const w = Math.min(100, Math.round(pct * 100));
  return `<div class="alloc-bar-wrap">
    <div class="alloc-bar"><div class="alloc-bar-fill ${fillCls}" style="width:${w}%"></div></div>
    <span>${val}%</span>
  </div>`;
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

// Add CSS helper for danger text
document.head.insertAdjacentHTML('beforeend', `
<style>
  .text-danger { color: var(--danger) !important; font-weight: 600; }
</style>
`);
