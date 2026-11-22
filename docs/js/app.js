/**
 * TankSun — Main UI Controller
 */

import { TankSunBLE } from './ble.js';
import { interpolateSchedule } from './protocol.js';

const STORAGE_KEY = 'tanksun_prefs_v2';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Verified directly from XPG-GAgent-e0ec registers:
// colour1 = Green, colour2 = Red, colour3 = Yellow, colour4 = White
const DEFAULT_CHANNELS = [
  { name: 'Green', color: '#4ade80' },
  { name: 'Red', color: '#f87171' },
  { name: 'Yellow', color: '#facc15' },
  { name: 'White', color: '#f8fafc' },
];

const DEFAULT_PRESET_NAMES = [
  'Custom 1',
  'Daylight',
  'Off / Dark',
  'Low Light',
  'Warm Glow',
  'Feeding',
];

// Channel order: [Green, Red, Yellow, White]
const SCHEDULE_TEMPLATES = {
  freshwater8: [
    { time: 600, channels: [0, 0, 0, 0] },      // 10:00 sunrise
    { time: 660, channels: [35, 55, 55, 45] },  // 11:00 warm morning
    { time: 720, channels: [75, 80, 75, 85] },  // 12:00 peak
    { time: 960, channels: [75, 80, 75, 85] },  // 16:00 plateau
    { time: 1020, channels: [15, 50, 40, 15] }, // 17:00 warm sunset
    { time: 1080, channels: [0, 0, 0, 0] },     // 18:00 off
  ],
  daylight10: [
    { time: 510, channels: [0, 0, 0, 0] },      // 08:30 sunrise
    { time: 570, channels: [35, 55, 50, 45] },  // 09:30 morning
    { time: 690, channels: [80, 85, 80, 90] },  // 11:30 midday
    { time: 930, channels: [80, 85, 80, 90] },  // 15:30 afternoon
    { time: 1050, channels: [15, 50, 40, 15] }, // 17:30 warm dusk
    { time: 1110, channels: [0, 0, 0, 0] },     // 18:30 off
  ],
  siesta: [
    { time: 480, channels: [0, 0, 0, 0] },      // 08:00 start
    { time: 540, channels: [70, 75, 70, 80] },  // 09:00 morning peak
    { time: 720, channels: [70, 75, 70, 80] },  // 12:00 end morning
    { time: 750, channels: [5, 10, 10, 5] },    // 12:30 siesta dim
    { time: 900, channels: [5, 10, 10, 5] },    // 15:00 end siesta
    { time: 930, channels: [75, 80, 75, 85] },  // 15:30 afternoon peak
    { time: 1170, channels: [75, 80, 75, 85] }, // 19:30 evening
    { time: 1230, channels: [0, 0, 0, 0] },     // 20:30 off
  ],
  evening: [
    { time: 720, channels: [0, 0, 0, 0] },      // 12:00 sunrise
    { time: 780, channels: [65, 70, 65, 75] },  // 13:00 afternoon
    { time: 1140, channels: [65, 70, 65, 75] }, // 19:00 evening
    { time: 1230, channels: [10, 35, 25, 10] }, // 20:30 warm dim glow
    { time: 1290, channels: [0, 0, 0, 0] },     // 21:30 off
  ],
};

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // Migrate old default 'local' -> verified 'beijing_local'
    const validModes = ['beijing_local', 'local', 'utc'];
    const clockMode = raw.clockModeMigrated && validModes.includes(raw.clockMode)
      ? raw.clockMode
      : 'beijing_local';
    return {
      channels: raw.channels || DEFAULT_CHANNELS.map((c) => ({ ...c })),
      presetNames: raw.presetNames || [...DEFAULT_PRESET_NAMES],
      clockMode,
      clockModeMigrated: true,
    };
  } catch {
    return {
      channels: DEFAULT_CHANNELS.map((c) => ({ ...c })),
      presetNames: [...DEFAULT_PRESET_NAMES],
      clockMode: 'beijing_local',
      clockModeMigrated: true,
    };
  }
}

function savePrefs(prefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function fmtMinutes24(min) {
  const clamped = Math.max(0, Math.min(1439, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtMinutes(min) {
  const clamped = Math.max(0, Math.min(1439, Math.round(min)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function fmtHourShort12(hr) {
  const h = ((hr % 24) + 24) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function parseTimeStr(str) {
  const [h, m] = str.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

// App State
const ble = new TankSunBLE();
const prefs = loadPrefs();
let activeTab = 'schedule';
let offlineDraft = false;

// Raw device state mirror (initialized with sensible defaults for offline preview)
let deviceState = {
  onOff: true,
  haveColour: 4,
  mode: 2, // 1=Auto, 2..7=Manual 1..6
  nodeNum: 6,
  timestamp: 0,
  cycleDate: [1, 1, 1, 1, 1, 1, 1],
  colour1: [0, 45, 75, 75, 25, 0, 0, 0, 0, 0, 0, 0, 0, 80, 0, 20, 20, 20],
  colour2: [0, 50, 80, 80, 45, 0, 0, 0, 0, 0, 0, 0, 13, 95, 0, 20, 40, 20],
  colour3: [0, 45, 75, 75, 20, 0, 0, 0, 0, 0, 0, 0, 0, 80, 0, 20, 20, 20],
  colour4: [0, 55, 85, 85, 20, 0, 0, 0, 0, 0, 0, 0, 0, 80, 0, 20, 20, 20],
  nodeTime1: 600,
  nodeTime2: 660,
  nodeTime3: 720,
  nodeTime4: 960,
  nodeTime5: 1020,
  nodeTime6: 1080,
};

// Editable working state
let scheduleNodes = SCHEDULE_TEMPLATES.freshwater8.map((n) => ({
  time: n.time,
  channels: [...n.channels],
}));
let cycleDate = [1, 1, 1, 1, 1, 1, 1];
let selectedNodeIdx = 0;

let selectedSlot = 0; // 0..5 -> Manual 1..6
let manualChannels = [0, 13, 0, 0];
let manualBaseChannels = [0, 13, 0, 0]; // ratio anchor for Manual Master Brightness
let nodeBaseChannels = [0, 0, 0, 0];    // ratio anchor for Node Master Brightness
let nodeBaseIdx = -1;
let previewTimer = null;
let scrubbing = false;
const logLines = [];

// DOM refs
const $ = (id) => document.getElementById(id);

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function appendLog(ts, dir, msg) {
  const t = ts.toTimeString().slice(0, 8);
  logLines.push(`[${t}] ${dir}: ${msg}`);
  if (logLines.length > 150) logLines.shift();
  const box = $('bleLog');
  if (box) {
    box.textContent = logLines.join('\n');
    box.scrollTop = box.scrollHeight;
  }
}

function hydrateFromDeviceState(st, { autoSwitchTab = false } = {}) {
  deviceState = { ...deviceState, ...st };
  const nch = deviceState.haveColour || 4;
  const count = Math.max(0, Math.min(12, deviceState.nodeNum || 0));

  if (count > 0) {
    scheduleNodes = [];
    for (let i = 0; i < count; i++) {
      const time = deviceState[`nodeTime${i + 1}`] ?? 0;
      const chs = Array.from({ length: nch }, (_, c) => deviceState[`colour${c + 1}`]?.[i] ?? 0);
      scheduleNodes.push({ time, channels: chs });
    }
    scheduleNodes.sort((a, b) => a.time - b.time);
    selectedNodeIdx = Math.min(selectedNodeIdx, scheduleNodes.length - 1);
    nodeBaseIdx = -1;
  }

  if (Array.isArray(deviceState.cycleDate) && deviceState.cycleDate.length === 7) {
    cycleDate = deviceState.cycleDate.map((v) => (v ? 1 : 0));
  }

  if (deviceState.mode >= 2 && deviceState.mode <= 7) {
    selectedSlot = deviceState.mode - 2;
  }
  if (autoSwitchTab) {
    activeTab = deviceState.mode === 1 ? 'schedule' : 'manual';
  }
  loadSlotIntoSliders(selectedSlot);
  renderAll();
}

function scaleProportionally(baseChannels, targetPeak, nch) {
  const slice = baseChannels.slice(0, nch);
  const peak = Math.max(...slice, 0);
  if (peak === 0) {
    return Array(nch).fill(Math.max(0, Math.min(100, Math.round(targetPeak))));
  }
  const factor = targetPeak / peak;
  return slice.map((v) => Math.max(0, Math.min(100, Math.round(v * factor))));
}

function loadSlotIntoSliders(slotIdx) {
  const nch = deviceState.haveColour || 4;
  manualChannels = Array.from({ length: nch }, (_, c) => deviceState[`colour${c + 1}`]?.[12 + slotIdx] ?? 0);
  manualBaseChannels = [...manualChannels];
  const peak = Math.max(...manualChannels, 0);
  $('masterSlider').value = String(peak);
  $('masterVal').textContent = `${peak}%`;
}

function sendThrottledPreview(channels) {
  if (!ble.connected) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    ble.setPreview(true, channels, deviceState.haveColour || 4).catch((err) => {
      showToast(err.message, true);
    });
  }, 110);
}

// =============================================================================
// Rendering
// =============================================================================

function renderHeaderAndStatus() {
  const connected = ble.connected;
  $('connPill').classList.toggle('connected', connected);
  $('connLabel').textContent = connected ? 'Connected' : 'Connect';
  $('headerSub').textContent = connected
    ? ble.deviceName
    : offlineDraft
      ? 'Offline Preview Mode'
      : 'OceanTech BLE Controller';

  const showMain = connected || offlineDraft;
  $('connectHero').classList.toggle('hidden', showMain);
  $('mainApp').classList.toggle('hidden', !showMain);
  $('bottomNav').classList.toggle('hidden', !showMain);

  $('btnPower').classList.toggle('on', Boolean(deviceState.onOff));
  const isAuto = deviceState.mode === 1;
  $('btnModeAuto').classList.toggle('active', isAuto);
  $('btnModeManual').classList.toggle('active', !isAuto);

  const modeLabel = isAuto
    ? `Auto Schedule (${scheduleNodes.length} nodes)`
    : `Manual ${selectedSlot + 1} · ${prefs.presetNames[selectedSlot] || ''}`;
  $('statusText').textContent = deviceState.onOff ? modeLabel : 'Light is OFF';

  const now = new Date();
  $('clockText').textContent = fmtMinutes(now.getHours() * 60 + now.getMinutes());

  if (deviceState.timestamp) {
    const d = new Date(deviceState.timestamp * 1000);
    $('deviceTimestampVal').textContent = `${deviceState.timestamp} (${d.toUTCString().slice(5, 22)})`;
  } else {
    $('deviceTimestampVal').textContent = 'Not synced (0)';
  }
}

function renderScheduleChart() {
  const svg = $('scheduleChart');
  const W = 460;
  const H = 190;
  const padL = 30;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (min) => padL + (min / 1440) * plotW;
  const yOf = (pct) => padT + plotH - (pct / 100) * plotH;

  let html = '';

  // Grid lines (0%, 50%, 100% + every 4 hours)
  for (const pct of [0, 50, 100]) {
    const y = yOf(pct);
    html += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(148,198,255,0.12)" stroke-dasharray="${pct === 0 ? '' : '3 4'}"/>`;
    html += `<text x="${padL - 5}" y="${y + 3}" text-anchor="end" fill="#6f8ba8" font-size="9">${pct}%</text>`;
  }
  for (let hr = 0; hr <= 24; hr += 4) {
    const x = xOf(hr * 60);
    html += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="rgba(148,198,255,0.08)"/>`;
    html += `<text x="${x}" y="${H - 7}" text-anchor="middle" fill="#6f8ba8" font-size="9">${fmtHourShort12(hr)}</text>`;
  }

  const sorted = [...scheduleNodes].sort((a, b) => a.time - b.time);
  const nch = deviceState.haveColour || 4;

  // Channel polylines + soft area fill
  if (sorted.length > 0) {
    for (let c = 0; c < nch; c++) {
      const color = prefs.channels[c]?.color || '#38bdf8';
      const pts = [
        [xOf(0), yOf(sorted[0].channels[c] || 0)],
        ...sorted.map((n) => [xOf(n.time), yOf(n.channels[c] || 0)]),
        [xOf(1440), yOf(sorted[sorted.length - 1].channels[c] || 0)],
      ];
      const dLine = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const dArea = `${dLine} L${xOf(1440).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(0).toFixed(1)},${yOf(0).toFixed(1)} Z`;
      html += `<path d="${dArea}" fill="${color}" fill-opacity="0.07"/>`;
      html += `<path d="${dLine}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" opacity="0.9"/>`;
    }
  }

  // Current time vertical line
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowX = xOf(nowMin);
  html += `<line x1="${nowX}" y1="${padT}" x2="${nowX}" y2="${H - padB}" stroke="#22d3ee" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>`;
  html += `<text x="${Math.min(W - 22, Math.max(padL + 16, nowX))}" y="${padT - 3}" text-anchor="middle" fill="#22d3ee" font-size="8.5" font-weight="700">NOW</text>`;

  // Scrubber cursor if active
  if (scrubbing) {
    const scrubMin = Number($('scrubSlider').value);
    const sx = xOf(scrubMin);
    html += `<line x1="${sx}" y1="${padT}" x2="${sx}" y2="${H - padB}" stroke="#fbbf24" stroke-width="2"/>`;
  }

  // Clickable node markers
  sorted.forEach((n, idx) => {
    const x = xOf(n.time);
    const peak = Math.max(...n.channels.slice(0, nch));
    const y = yOf(peak);
    const sel = idx === selectedNodeIdx;
    html += `<g data-node-idx="${idx}" style="cursor:pointer;">`;
    html += `<circle cx="${x}" cy="${y}" r="${sel ? 7 : 5}" fill="${sel ? '#fbbf24' : '#0d1c2e'}" stroke="${sel ? '#ffffff' : '#93c5fd'}" stroke-width="2"/>`;
    html += `<circle cx="${x}" cy="${y}" r="14" fill="transparent"/>`;
    html += `</g>`;
  });

  svg.innerHTML = html;

  svg.querySelectorAll('[data-node-idx]').forEach((g) => {
    g.addEventListener('click', () => {
      selectedNodeIdx = Number(g.getAttribute('data-node-idx'));
      renderScheduleUI();
    });
  });
}

function renderScheduleUI() {
  scheduleNodes.sort((a, b) => a.time - b.time);
  renderScheduleChart();

  // Weekday pills
  const dayPills = $('dayPills');
  dayPills.innerHTML = '';
  DAY_LABELS.forEach((lbl, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `day-pill ${cycleDate[idx] ? 'on' : ''}`;
    btn.textContent = lbl;
    btn.addEventListener('click', () => {
      cycleDate[idx] = cycleDate[idx] ? 0 : 1;
      renderScheduleUI();
    });
    dayPills.appendChild(btn);
  });

  $('nodeCount').textContent = String(scheduleNodes.length);
  $('btnAddNode').disabled = scheduleNodes.length >= 12;

  // Node List
  const list = $('nodeList');
  list.innerHTML = '';
  const nch = deviceState.haveColour || 4;

  scheduleNodes.forEach((n, idx) => {
    const item = document.createElement('div');
    item.className = `node-item ${idx === selectedNodeIdx ? 'selected' : ''}`;
    const chips = Array.from({ length: nch }, (_, c) => {
      const col = prefs.channels[c]?.color || '#38bdf8';
      return `<span class="node-chip"><span class="swatch" style="width:7px;height:7px;background:${col}"></span>${n.channels[c]}%</span>`;
    }).join('');
    item.innerHTML = `
      <div class="node-time">${fmtMinutes(n.time)}</div>
      <div class="node-chips">${chips}</div>
      <div class="muted" style="font-size:0.72rem;">#${idx + 1}</div>
    `;
    item.addEventListener('click', () => {
      selectedNodeIdx = idx;
      renderScheduleUI();
    });
    list.appendChild(item);
  });

  // Node Editor
  const editor = $('nodeEditorCard');
  const node = scheduleNodes[selectedNodeIdx];
  if (!node) {
    editor.classList.add('hidden');
    return;
  }
  editor.classList.remove('hidden');
  $('nodeEditorTitle').textContent = `Edit Node #${selectedNodeIdx + 1} (${fmtMinutes(node.time)})`;
  $('nodeTimeInput').value = fmtMinutes24(node.time);
  $('btnDeleteNode').disabled = scheduleNodes.length <= 2;

  const slidersWrap = $('nodeSliders');
  slidersWrap.innerHTML = '';

  // Reset proportional ratio anchor whenever switching to a different node
  if (nodeBaseIdx !== selectedNodeIdx) {
    nodeBaseIdx = selectedNodeIdx;
    nodeBaseChannels = [...node.channels];
  }
  const nodePeak = Math.max(...node.channels.slice(0, nch), 0);
  $('nodeMasterSlider').value = String(nodePeak);
  $('nodeMasterVal').textContent = `${nodePeak}%`;

  for (let c = 0; c < nch; c++) {
    const chCfg = prefs.channels[c] || { name: `Channel ${c + 1}`, color: '#38bdf8' };
    const row = document.createElement('div');
    row.className = 'channel-row';
    row.innerHTML = `
      <div class="channel-meta">
        <span class="channel-name"><span class="swatch" style="background:${chCfg.color}"></span>${chCfg.name}</span>
        <span class="channel-val">${node.channels[c]}%</span>
      </div>
      <input type="range" min="0" max="100" value="${node.channels[c]}" style="--thumb-color:${chCfg.color}" />
    `;
    const input = row.querySelector('input');
    const valSpan = row.querySelector('.channel-val');
    input.addEventListener('input', () => {
      node.channels[c] = Number(input.value);
      nodeBaseChannels = [...node.channels];
      const newPeak = Math.max(...node.channels.slice(0, nch), 0);
      $('nodeMasterSlider').value = String(newPeak);
      $('nodeMasterVal').textContent = `${newPeak}%`;
      valSpan.textContent = `${node.channels[c]}%`;
      renderScheduleChart();
      // Update chip row text smoothly
      const chipEls = list.children[selectedNodeIdx]?.querySelectorAll('.node-chip');
      if (chipEls?.[c]) {
        chipEls[c].lastChild.textContent = `${node.channels[c]}%`;
      }
      sendThrottledPreview(node.channels);
    });
    slidersWrap.appendChild(row);
  }
}

function renderSpectrumChart() {
  const svg = $('spectrumChart');
  if (!svg) return;

  const W = 460;
  const H = 145;
  const padL = 14;
  const padR = 14;
  const padT = 18;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const minNm = 380;
  const maxNm = 740;
  const steps = 90;

  // Channel order: [0: Green, 1: Red, 2: Yellow, 3: White]
  const gVal = (manualChannels[0] || 0) / 100;
  const rVal = (manualChannels[1] || 0) / 100;
  const yVal = (manualChannels[2] || 0) / 100;
  const wVal = (manualChannels[3] || 0) / 100;

  const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);

  // Realistic freshwater aquarium LED spectral contributions
  const pts = [];
  let maxIntensity = 1.0;
  const samples = [];
  for (let i = 0; i <= steps; i++) {
    const nm = minNm + ((maxNm - minNm) * i) / steps;
    const green = gVal * 0.92 * gauss(nm, 525, 18);
    const red = rVal * 0.95 * gauss(nm, 655, 18);
    const yellow = yVal * (0.75 * gauss(nm, 590, 26) + 0.35 * gauss(nm, 455, 22));
    const white = wVal * (0.85 * gauss(nm, 452, 16) + 0.72 * gauss(nm, 565, 58));
    const total = green + red + yellow + white;
    if (total > maxIntensity) maxIntensity = total;
    samples.push({ nm, total });
  }

  // Soft cap normalization so turning sliders up visibly grows the curve
  const scaleMax = Math.max(1.15, maxIntensity);
  const xOf = (nm) => padL + ((nm - minNm) / (maxNm - minNm)) * plotW;
  const yOf = (val) => padT + plotH - Math.min(1, val / scaleMax) * plotH;

  for (const s of samples) {
    pts.push([xOf(s.nm), yOf(s.total)]);
  }

  const dLine = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dArea = `${dLine} L${xOf(maxNm).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(minNm).toFixed(1)},${yOf(0).toFixed(1)} Z`;

  const avgPower = Math.round(
    (manualChannels.slice(0, deviceState.haveColour || 4).reduce((a, b) => a + b, 0) /
      (deviceState.haveColour || 4))
  );

  let html = `
    <defs>
      <linearGradient id="specGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#6d28d9"/>
        <stop offset="18%" stop-color="#2563eb"/>
        <stop offset="32%" stop-color="#06b6d4"/>
        <stop offset="44%" stop-color="#22c55e"/>
        <stop offset="58%" stop-color="#eab308"/>
        <stop offset="72%" stop-color="#f97316"/>
        <stop offset="86%" stop-color="#ef4444"/>
        <stop offset="100%" stop-color="#991b1b"/>
      </linearGradient>
    </defs>
  `;

  // Subtle grid lines
  for (const frac of [0, 0.5, 1]) {
    const y = padT + plotH * (1 - frac);
    html += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(148,198,255,0.1)" stroke-dasharray="${frac === 0 ? '' : '3 4'}"/>`;
  }
  for (const nm of [400, 450, 500, 550, 600, 650, 700]) {
    const x = xOf(nm);
    html += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="rgba(148,198,255,0.06)"/>`;
    html += `<text x="${x}" y="${H - 7}" text-anchor="middle" fill="#6f8ba8" font-size="9">${nm}nm</text>`;
  }

  // Filled spectrum curve + bright outline
  html += `<path d="${dArea}" fill="url(#specGrad)" fill-opacity="0.48"/>`;
  html += `<path d="${dLine}" fill="none" stroke="url(#specGrad)" stroke-width="2.5" stroke-linejoin="round"/>`;
  html += `<text x="${W - padR}" y="12" text-anchor="end" fill="#8aa5c2" font-size="9.5" font-weight="600">Output: ${avgPower}%</text>`;

  svg.innerHTML = html;
}

function renderManualUI() {
  const nch = deviceState.haveColour || 4;
  const wrap = $('manualSliders');
  wrap.innerHTML = '';

  for (let c = 0; c < nch; c++) {
    const chCfg = prefs.channels[c] || { name: `Channel ${c + 1}`, color: '#38bdf8' };
    const row = document.createElement('div');
    row.className = 'channel-row';
    row.innerHTML = `
      <div class="channel-meta">
        <span class="channel-name"><span class="swatch" style="background:${chCfg.color}"></span>${chCfg.name}</span>
        <span class="channel-val">${manualChannels[c]}%</span>
      </div>
      <input type="range" min="0" max="100" value="${manualChannels[c]}" style="--thumb-color:${chCfg.color}" />
    `;
    const input = row.querySelector('input');
    const valSpan = row.querySelector('.channel-val');
    input.addEventListener('input', () => {
      manualChannels[c] = Number(input.value);
      manualBaseChannels = [...manualChannels];
      const peak = Math.max(...manualChannels.slice(0, nch), 0);
      $('masterSlider').value = String(peak);
      $('masterVal').textContent = `${peak}%`;
      valSpan.textContent = `${manualChannels[c]}%`;
      renderSpectrumChart();
      sendThrottledPreview(manualChannels);
    });
    wrap.appendChild(row);
  }
  renderSpectrumChart();

  // Preset Cards (Slots 0..5 -> Manual 1..6)
  const grid = $('presetGrid');
  grid.innerHTML = '';
  for (let slot = 0; slot < 6; slot++) {
    const chs = Array.from({ length: nch }, (_, c) => deviceState[`colour${c + 1}`]?.[12 + slot] ?? 0);
    const isActive = selectedSlot === slot;
    const isDeviceMode = deviceState.mode === slot + 2;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `preset-card ${isActive ? 'active' : ''}`;
    const bars = chs
      .map((v, c) => {
        const col = prefs.channels[c]?.color || '#38bdf8';
        return `<div class="preset-bar-track"><div class="preset-bar-fill" style="width:${v}%;background:${col}"></div></div>`;
      })
      .join('');
    card.innerHTML = `
      <div class="preset-top">
        <span class="preset-name">${prefs.presetNames[slot] || `Manual ${slot + 1}`}</span>
        <span class="preset-badge">${isDeviceMode ? 'ACTIVE' : `M${slot + 1}`}</span>
      </div>
      <div class="preset-bars">${bars}</div>
    `;
    card.addEventListener('click', async () => {
      selectedSlot = slot;
      loadSlotIntoSliders(slot);
      $('presetNameInput').value = prefs.presetNames[slot] || '';
      renderManualUI();
      if (ble.connected) {
        try {
          await ble.setPreview(false, [0, 0, 0, 0], nch);
          await ble.writeAttrs({ onOff: true, mode: 2 + slot });
          deviceState.onOff = true;
          deviceState.mode = 2 + slot;
          renderHeaderAndStatus();
          renderManualUI();
          showToast(`Activated ${prefs.presetNames[slot] || `Manual ${slot + 1}`}`);
        } catch (err) {
          showToast(err.message, true);
        }
      }
    });
    grid.appendChild(card);
  }
  $('presetNameInput').value = prefs.presetNames[selectedSlot] || '';
}

function renderSettingsUI() {
  const nch = deviceState.haveColour || 4;
  const list = $('channelConfigList');
  list.innerHTML = '';

  for (let c = 0; c < nch; c++) {
    const chCfg = prefs.channels[c] || { name: `Channel ${c + 1}`, color: '#38bdf8' };
    const row = document.createElement('div');
    row.className = 'ch-config-row';
    row.innerHTML = `
      <input type="color" value="${chCfg.color}" aria-label="Channel ${c + 1} color" />
      <input type="text" value="${chCfg.name}" placeholder="Channel ${c + 1} name" />
      <button type="button" class="btn btn-sm">Flash</button>
    `;
    const colorInput = row.querySelector('input[type="color"]');
    const textInput = row.querySelector('input[type="text"]');
    const flashBtn = row.querySelector('button');

    colorInput.addEventListener('change', () => {
      prefs.channels[c].color = colorInput.value;
      savePrefs(prefs);
      renderScheduleUI();
      renderManualUI();
    });
    textInput.addEventListener('change', () => {
      prefs.channels[c].name = textInput.value.trim() || `Channel ${c + 1}`;
      savePrefs(prefs);
      renderScheduleUI();
      renderManualUI();
    });
    flashBtn.addEventListener('click', async () => {
      if (!ble.connected) {
        showToast('Connect to your light first', true);
        return;
      }
      flashBtn.disabled = true;
      const arr = Array(nch).fill(0);
      arr[c] = 35;
      try {
        showToast(`Flashing Channel ${c + 1} (${prefs.channels[c].name})...`);
        await ble.setPreview(true, arr, nch);
        await new Promise((r) => setTimeout(r, 2000));
        await ble.setPreview(false, Array(nch).fill(0), nch);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        flashBtn.disabled = false;
      }
    });
    list.appendChild(row);
  }

  $('clockModeSelect').value = prefs.clockMode;
}

function renderTabs() {
  $('tabSchedule').classList.toggle('hidden', activeTab !== 'schedule');
  $('tabManual').classList.toggle('hidden', activeTab !== 'manual');
  $('tabSettings').classList.toggle('hidden', activeTab !== 'settings');
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });
}

function renderAll() {
  renderHeaderAndStatus();
  renderTabs();
  renderScheduleUI();
  renderManualUI();
  renderSettingsUI();
}

// =============================================================================
// Event Wiring
// =============================================================================

async function handleConnect(acceptAll = false) {
  try {
    showToast('Opening Bluetooth picker...');
    const state = await ble.connect({ acceptAll });
    offlineDraft = false;
    hydrateFromDeviceState(state, { autoSwitchTab: true });
    showToast(`Connected to ${ble.deviceName}`);
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      showToast(err.message || String(err), true);
    }
  }
}

$('btnConnect').addEventListener('click', () => handleConnect(false));
$('btnConnectAll').addEventListener('click', () => handleConnect(true));
$('btnOfflineEdit').addEventListener('click', () => {
  offlineDraft = true;
  renderAll();
});

$('connPill').addEventListener('click', () => {
  if (ble.connected) {
    ble.disconnect();
    showToast('Disconnected');
  } else {
    handleConnect(false);
  }
});

$('btnPower').addEventListener('click', async () => {
  const next = !deviceState.onOff;
  if (!ble.connected) {
    deviceState.onOff = next;
    renderHeaderAndStatus();
    return;
  }
  try {
    await ble.setPreview(false, [0, 0, 0, 0], deviceState.haveColour || 4);
    await ble.setPower(next);
    deviceState.onOff = next;
    renderHeaderAndStatus();
    showToast(next ? 'Light ON' : 'Light OFF');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('btnModeAuto').addEventListener('click', async () => {
  activeTab = 'schedule';
  renderTabs();
  if (!ble.connected) {
    deviceState.mode = 1;
    renderHeaderAndStatus();
    return;
  }
  try {
    await ble.setPreview(false, [0, 0, 0, 0], deviceState.haveColour || 4);
    await ble.writeAttrs({ onOff: true, mode: 1 });
    deviceState.onOff = true;
    deviceState.mode = 1;
    renderHeaderAndStatus();
    showToast('Switched to Auto Schedule');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('btnModeManual').addEventListener('click', async () => {
  activeTab = 'manual';
  renderTabs();
  const targetMode = 2 + selectedSlot;
  if (!ble.connected) {
    deviceState.mode = targetMode;
    renderHeaderAndStatus();
    return;
  }
  try {
    await ble.setPreview(false, [0, 0, 0, 0], deviceState.haveColour || 4);
    await ble.writeAttrs({ onOff: true, mode: targetMode });
    deviceState.onOff = true;
    deviceState.mode = targetMode;
    renderHeaderAndStatus();
    renderManualUI();
    showToast(`Switched to ${prefs.presetNames[selectedSlot] || `Manual ${selectedSlot + 1}`}`);
  } catch (err) {
    showToast(err.message, true);
  }
});

// Schedule actions
$('btnRefresh').addEventListener('click', async () => {
  if (!ble.connected) return showToast('Not connected', true);
  try {
    const st = await ble.readAllState();
    hydrateFromDeviceState(st);
    showToast('Synced state from light');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('btnSyncClock').addEventListener('click', async () => {
  if (!ble.connected) return showToast('Not connected', true);
  try {
    await ble.syncClock(prefs.clockMode);
    const st = await ble.readAllState();
    hydrateFromDeviceState(st);
    showToast('Light clock synced!');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('nodeTimeInput').addEventListener('change', (e) => {
  const node = scheduleNodes[selectedNodeIdx];
  if (!node) return;
  node.time = parseTimeStr(e.target.value);
  scheduleNodes.sort((a, b) => a.time - b.time);
  selectedNodeIdx = scheduleNodes.indexOf(node);
  renderScheduleUI();
});

$('btnPreviewNode').addEventListener('click', async () => {
  const node = scheduleNodes[selectedNodeIdx];
  if (!node) return;
  if (!ble.connected) return showToast('Connect to preview on the light', true);
  try {
    await ble.setPreview(true, node.channels, deviceState.haveColour || 4);
    $('btnStopScrub').classList.remove('hidden');
    $('scrubTimeLabel').textContent = `Node #${selectedNodeIdx + 1} (${fmtMinutes(node.time)})`;
    showToast(`Previewing ${fmtMinutes(node.time)}`);
  } catch (err) {
    showToast(err.message, true);
  }
});

$('btnAddNode').addEventListener('click', () => {
  if (scheduleNodes.length >= 12) return;
  const cur = scheduleNodes[selectedNodeIdx];
  const nextTime = cur ? Math.min(1435, cur.time + 60) : 720;
  const chs = interpolateSchedule(scheduleNodes, nextTime, deviceState.haveColour || 4);
  const added = { time: nextTime, channels: chs };
  scheduleNodes.push(added);
  scheduleNodes.sort((a, b) => a.time - b.time);
  selectedNodeIdx = scheduleNodes.indexOf(added);
  renderScheduleUI();
});

$('btnDeleteNode').addEventListener('click', () => {
  if (scheduleNodes.length <= 2) return;
  scheduleNodes.splice(selectedNodeIdx, 1);
  selectedNodeIdx = Math.max(0, selectedNodeIdx - 1);
  renderScheduleUI();
});

$('btnApplyTemplate').addEventListener('click', () => {
  const key = $('templateSelect').value;
  if (!key || !SCHEDULE_TEMPLATES[key]) return;
  scheduleNodes = SCHEDULE_TEMPLATES[key].map((n) => ({
    time: n.time,
    channels: [...n.channels],
  }));
  selectedNodeIdx = 0;
  nodeBaseIdx = -1;
  renderScheduleUI();
  showToast('Template loaded — tap Save Schedule to send to light');
});

$('nodeMasterSlider').addEventListener('input', () => {
  const node = scheduleNodes[selectedNodeIdx];
  if (!node) return;
  const nch = deviceState.haveColour || 4;
  const targetPeak = Number($('nodeMasterSlider').value);
  $('nodeMasterVal').textContent = `${targetPeak}%`;

  const scaled = scaleProportionally(nodeBaseChannels, targetPeak, nch);
  for (let c = 0; c < nch; c++) {
    node.channels[c] = scaled[c];
  }

  // Update the 4 node sliders + labels smoothly in-place
  const sliderRows = $('nodeSliders').querySelectorAll('.channel-row');
  sliderRows.forEach((row, c) => {
    const inp = row.querySelector('input');
    const lbl = row.querySelector('.channel-val');
    if (inp) inp.value = String(node.channels[c]);
    if (lbl) lbl.textContent = `${node.channels[c]}%`;
  });

  // Update node list chips + 24h curve
  const chipEls = $('nodeList').children[selectedNodeIdx]?.querySelectorAll('.node-chip');
  if (chipEls) {
    for (let c = 0; c < nch; c++) {
      if (chipEls[c]) chipEls[c].lastChild.textContent = `${node.channels[c]}%`;
    }
  }
  renderScheduleChart();
  sendThrottledPreview(node.channels);
});

$('scrubSlider').addEventListener('input', () => {
  scrubbing = true;
  const min = Number($('scrubSlider').value);
  const chs = interpolateSchedule(scheduleNodes, min, deviceState.haveColour || 4);
  $('scrubTimeLabel').textContent = `${fmtMinutes(min)}  [${chs.join(' / ')}%]`;
  $('btnStopScrub').classList.remove('hidden');
  renderScheduleChart();
  sendThrottledPreview(chs);
});

$('btnStopScrub').addEventListener('click', async () => {
  scrubbing = false;
  $('scrubTimeLabel').textContent = 'Off';
  $('btnStopScrub').classList.add('hidden');
  renderScheduleChart();
  if (ble.connected) {
    try {
      await ble.setPreview(false, [0, 0, 0, 0], deviceState.haveColour || 4);
    } catch (err) {
      showToast(err.message, true);
    }
  }
});

$('btnSaveSchedule').addEventListener('click', async () => {
  if (!ble.connected) return showToast('Connect to your light to save schedule', true);
  const btn = $('btnSaveSchedule');
  btn.disabled = true;
  btn.textContent = 'Saving schedule to light…';
  try {
    const wasPreviewing = scrubbing || !$('btnStopScrub').classList.contains('hidden');
    scrubbing = false;
    $('scrubTimeLabel').textContent = 'Off';
    $('btnStopScrub').classList.add('hidden');
    const st = await ble.saveSchedule(scheduleNodes, cycleDate, deviceState, {
      clockMode: prefs.clockMode,
      activate: true,
      wasPreviewing,
    });
    hydrateFromDeviceState(st);
    showToast('Schedule saved & Auto Mode activated!');
  } catch (err) {
    showToast(`Save failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Schedule & Activate Auto Mode';
  }
});

// Manual actions
$('masterSlider').addEventListener('input', () => {
  const nch = deviceState.haveColour || 4;
  const targetPeak = Number($('masterSlider').value);
  $('masterVal').textContent = `${targetPeak}%`;
  manualChannels = scaleProportionally(manualBaseChannels, targetPeak, nch);

  const sliderRows = $('manualSliders').querySelectorAll('.channel-row');
  sliderRows.forEach((row, c) => {
    const inp = row.querySelector('input');
    const lbl = row.querySelector('.channel-val');
    if (inp) inp.value = String(manualChannels[c]);
    if (lbl) lbl.textContent = `${manualChannels[c]}%`;
  });
  renderSpectrumChart();
  sendThrottledPreview(manualChannels);
});

$('btnAllOff').addEventListener('click', () => {
  manualChannels = manualChannels.map(() => 0);
  manualBaseChannels = [...manualChannels];
  $('masterSlider').value = '0';
  $('masterVal').textContent = '0%';
  renderManualUI();
  sendThrottledPreview(manualChannels);
});

$('btnAllFull').addEventListener('click', () => {
  manualChannels = manualChannels.map(() => 100);
  manualBaseChannels = [...manualChannels];
  $('masterSlider').value = '100';
  $('masterVal').textContent = '100%';
  renderManualUI();
  sendThrottledPreview(manualChannels);
});

$('btnSaveManualSlot').addEventListener('click', async () => {
  if (!ble.connected) return showToast('Connect to your light first', true);
  const btn = $('btnSaveManualSlot');
  btn.disabled = true;
  try {
    const st = await ble.saveManualSlot(selectedSlot, manualChannels, deviceState, true);
    hydrateFromDeviceState(st);
    showToast(`Saved to ${prefs.presetNames[selectedSlot] || `Manual ${selectedSlot + 1}`}`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnRenamePreset').addEventListener('click', () => {
  const name = $('presetNameInput').value.trim();
  if (!name) return;
  prefs.presetNames[selectedSlot] = name;
  savePrefs(prefs);
  renderManualUI();
  renderHeaderAndStatus();
  showToast('Preset renamed');
});

// Settings actions
$('clockModeSelect').addEventListener('change', () => {
  prefs.clockMode = $('clockModeSelect').value;
  savePrefs(prefs);
  showToast('Clock mode updated — tap Sync Clock to apply');
});

$('btnExportJson').addEventListener('click', async () => {
  const backup = JSON.stringify({ prefs, scheduleNodes, cycleDate }, null, 2);
  try {
    await navigator.clipboard.writeText(backup);
    showToast('Backup JSON copied to clipboard');
  } catch {
    prompt('Copy your TankSun backup JSON:', backup);
  }
});

$('btnImportJson').addEventListener('click', () => {
  const raw = prompt('Paste TankSun backup JSON:');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.scheduleNodes)) scheduleNodes = parsed.scheduleNodes;
    if (Array.isArray(parsed.cycleDate)) cycleDate = parsed.cycleDate;
    if (parsed.prefs) {
      Object.assign(prefs, parsed.prefs);
      savePrefs(prefs);
    }
    renderAll();
    showToast('Backup imported — tap Save Schedule to sync to light');
  } catch (err) {
    showToast(`Invalid JSON: ${err.message}`, true);
  }
});

$('btnClearLog').addEventListener('click', () => {
  logLines.length = 0;
  $('bleLog').textContent = 'Cleared.';
});

// Bottom nav
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    renderTabs();
  });
});

// BLE events
ble.addEventListener('log', (e) => appendLog(e.detail.ts, e.detail.dir, e.detail.msg));
ble.addEventListener('disconnected', () => {
  renderHeaderAndStatus();
  showToast('Light disconnected', true);
});

// Check browser Web Bluetooth support
if (!navigator.bluetooth) {
  $('bleSupportNote').innerHTML =
    'This browser does not support Web Bluetooth. On iPhone, open this page in the free <strong>Bluefy</strong> app; on Windows/Mac, use <strong>Chrome</strong> or <strong>Edge</strong>.';
} else {
  $('bleSupportNote').textContent = 'Web Bluetooth ready!';
}

// Refresh "NOW" marker once a minute
setInterval(() => {
  if (activeTab === 'schedule') renderScheduleChart();
  renderHeaderAndStatus();
}, 60000);

renderAll();
