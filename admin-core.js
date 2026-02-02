
;(function(){
  const ADMIN_LS_KEY = 'pontaj/admin/v1';
  const FILTER_LS_KEY = 'pontaj/admin/filters';


  // A1: Normă/pauză implicită (fallback) – suprascrisă din config.json
  let DEFAULT_NORM_MS             = 8   * 60 * 60 * 1000;
  let LONG_NORM_MS                = 8.5 * 60 * 60 * 1000;
  let DEFAULT_PAUSE_MARGIN_MS     = 40  * 60 * 1000;
  // A1: pauză inclusă în normă (fallback) – 30 min
  let DEFAULT_PAUSE_NORM_MS = 30 * 60 * 1000;

  // Config normă/pauză per departament / angajat (A1)
  let NORM_CFG = null;

  // A2/A3: Index concedii: dateKey -> Set(nume)
  let LEAVE_BY_DAY = new Map();

  // Activitățile care au normă de 8h30 (fallback)
  const ACTIVITATI_NORMA_8H30 = ['deplasare', 'pe drum', 'atelier'];

  let ALL_STATS = null;
  let SELECTED_EMPLOYEE = null;
  let CURRENT_DEPT_FILTER = 'all';
  let filterIncompleteOnly = false;
  let GLOBAL_CFG = null;
  let CFG = null; // <-- NOU (global)
  let lastEventsRange = 'today';
  let SELECTED_CALENDAR_DAY = null;
  let EMPLOYEE_SEARCH_TEXT = '';
  let TOP_MODE = 'hours';
  let LIVE_BOARD_MODE = 'today';

  let INCOMPLETE_DAY_FILTER = 'all'; // all | weekend | workday
  let ANOMALY_DAY_FILTER    = 'all'; // all | weekend | workday

  let CALENDAR_YEAR  = (new Date()).getFullYear();
  let CALENDAR_MONTH = (new Date()).getMonth();

  let ALERTS_FILTER_TYPE = 'all'; // all|pause|norm|extra|system
  let ALERTS_FILTER_DEPT = 'all';
  let ALERTS_FILTER_Q    = '';

  let currentRange    = 'today';
  let currentDept     = 'all';
  let currentEmployee = 'all';
  
  let LAST_LIVE_ACTIVE = [];
  let LATEST_INCOMPLETE_ROWS = [];
  let LATEST_ANOMALY_ROWS    = [];

  let SELF_SERVICE_BASE = null;

  
  let ADMIN_SESSION = null;
  let ADMIN_ROLE = 'admin';
  let ADMIN_DEPT = null;

  // Alerte LIVE – stocare locală sesiune
  let LIVE_ALERT_STATE = {}; // key: "nume|tip" -> { firstTriggeredAt, lastSlotIndex }
  let LIVE_ALERT_LOG   = []; // [{ts,name,dept,type,message}]
  const ALERT_MAX_LOG  = 200;
  let LIVE_ALERT_TIMER = null;

  function getAdminSession(){
    try{
      const raw = localStorage.getItem(ADMIN_LS_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch{ return null; }
  }
  function clearAdminSession(){
    try{ localStorage.removeItem(ADMIN_LS_KEY); }catch{}
  }

  async function loadConfig(){
    if (GLOBAL_CFG) return GLOBAL_CFG;
    const r = await fetch('config.json?v=' + Date.now(), {cache:'no-store'});
    if (!r.ok) throw new Error('Nu pot citi config.json (HTTP ' + r.status + ').');
    GLOBAL_CFG = await r.json();
    return GLOBAL_CFG;
  }

function applyNormSettingsFromConfig(cfg){
  NORM_CFG = {
    timezone: (cfg.normSettings && cfg.normSettings.timezone) || 'Europe/Bucharest',
    defaultNormMs: DEFAULT_NORM_MS,
    defaultLongNormMs: LONG_NORM_MS,

    // ✅ limită alertă (ce aveai tu deja - 40m default)
    defaultPauseMarginMs: DEFAULT_PAUSE_MARGIN_MS,

    // ✅ NOU: pauză inclusă în normă (30m default)
    defaultPauseNormMs: DEFAULT_PAUSE_NORM_MS,

    perDept: {},
    perEmployee: {}
  };

  if (cfg.normSettings){
    if (cfg.normSettings.default){
      const def = cfg.normSettings.default;

      if (typeof def.normHours === 'number'){
        NORM_CFG.defaultNormMs = def.normHours * 60 * 60 * 1000;
      }
      if (typeof def.pauseMaxMinutes === 'number'){
        NORM_CFG.defaultPauseMarginMs = def.pauseMaxMinutes * 60 * 1000;
      }

      // ✅ NOU: pauză inclusă în normă (minute)
      if (typeof def.pauseNormMinutes === 'number'){
        NORM_CFG.defaultPauseNormMs = def.pauseNormMinutes * 60 * 1000;
      }
    }

    
    if (cfg.normSettings.departments){
      Object.keys(cfg.normSettings.departments).forEach(dep=>{
        const nd = cfg.normSettings.departments[dep] || {};
        NORM_CFG.perDept[dep] = {
          normMs: (typeof nd.normHours === 'number' ? nd.normHours * 60 * 60 * 1000 : null),
          pauseMarginMs: (typeof nd.pauseMaxMinutes === 'number' ? nd.pauseMaxMinutes * 60 * 1000 : null),

          // ✅ NOU
          pauseNormMs: (typeof nd.pauseNormMinutes === 'number' ? nd.pauseNormMinutes * 60 * 1000 : null)
        };
      });
    }

    if (cfg.normSettings.employees){
      Object.keys(cfg.normSettings.employees).forEach(name=>{
        const ne = cfg.normSettings.employees[name] || {};
        NORM_CFG.perEmployee[name] = {
          normMs: (typeof ne.normHours === 'number' ? ne.normHours * 60 * 60 * 1000 : null),
          pauseMarginMs: (typeof ne.pauseMaxMinutes === 'number' ? ne.pauseMaxMinutes * 60 * 1000 : null),

          // ✅ NOU
          pauseNormMs: (typeof ne.pauseNormMinutes === 'number' ? ne.pauseNormMinutes * 60 * 1000 : null)
        };
      });
    }
  }

  TZ = NORM_CFG.timezone || 'Europe/Bucharest';
}

  function getNormMsFor(name, dept, hasLongActivity){
    const cfg = NORM_CFG || {};
    const empCfg = (cfg.perEmployee && name) ? cfg.perEmployee[name] : null;
    if (empCfg && empCfg.normMs) return empCfg.normMs;
    const depCfg = (cfg.perDept && dept) ? cfg.perDept[dept] : null;
    if (depCfg && depCfg.normMs) return depCfg.normMs;
    if (hasLongActivity){
      return cfg.defaultLongNormMs || LONG_NORM_MS;
    }
    return cfg.defaultNormMs || DEFAULT_NORM_MS;
  }

  function getPauseMarginMsFor(name, dept){
    const cfg = NORM_CFG || {};
    const empCfg = (cfg.perEmployee && name) ? cfg.perEmployee[name] : null;
    if (empCfg && typeof empCfg.pauseMarginMs === 'number') return empCfg.pauseMarginMs;
    const depCfg = (cfg.perDept && dept) ? cfg.perDept[dept] : null;
    if (depCfg && typeof depCfg.pauseMarginMs === 'number') return depCfg.pauseMarginMs;
    return cfg.defaultPauseMarginMs || DEFAULT_PAUSE_MARGIN_MS;
  }

  function getPauseNormMsFor(name, dept){
  const cfg = NORM_CFG || {};

  const empCfg = (cfg.perEmployee && name) ? cfg.perEmployee[name] : null;
  if (empCfg && typeof empCfg.pauseNormMs === 'number') return Math.max(0, empCfg.pauseNormMs);

  const depCfg = (cfg.perDept && dept) ? cfg.perDept[dept] : null;
  if (depCfg && typeof depCfg.pauseNormMs === 'number') return Math.max(0, depCfg.pauseNormMs);

  return Math.max(0, cfg.defaultPauseNormMs || DEFAULT_PAUSE_NORM_MS);
}


  function buildLeaveIndex(leaves){
    LEAVE_BY_DAY = new Map();
    if (!Array.isArray(leaves)) return;
    leaves.forEach(item=>{
      if (!item || !item.name || !item.from || !item.to) return;
      const name = item.name;
      const status = (item.status || '').toLowerCase();
      if (status && status !== 'approved' && status !== 'aprobat') return;
      const start = new Date(item.from);
      const end   = new Date(item.to);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
      const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last= new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (cur.getTime() <= last.getTime()){
        const dk = dateKeyFromIso(cur.toISOString());
        if (!LEAVE_BY_DAY.has(dk)){
          LEAVE_BY_DAY.set(dk, new Set());
        }
        LEAVE_BY_DAY.get(dk).add(name);
        cur.setDate(cur.getDate() + 1);
      }
    });
  }

  function isEmployeeOnLeave(name, dateKey){
    if (!name || !dateKey || !LEAVE_BY_DAY) return false;
    const set = LEAVE_BY_DAY.get(dateKey);
    return !!(set && set.has(name));
  }

  const session = getAdminSession();
  ADMIN_SESSION = session;

  const adminLabelEl           = document.getElementById('adminLabel');
  const logoutBtn              = document.getElementById('logoutBtn');
  const hamburgerBtn           = document.getElementById('adminHamburgerBtn');
  const hamburgerMenu          = document.getElementById('adminHamburgerMenu');
  const errorEl                = document.getElementById('error');
  const loadingEl              = document.getElementById('loading');

  const dashboardEl            = document.getElementById('dashboard');
  const alertsPageEl           = document.getElementById('alertsPage');
  const tabButtons             = document.querySelectorAll('button.admin-tab-btn'); // DOAR butoanele, nu și link-ul spre reports.html

  const rangeSelect            = document.getElementById('rangeSelect');
  const deptFilter             = document.getElementById('deptFilter');
  const employeeFilter         = document.getElementById('employeeFilter');
  const incompleteToggleBtn    = document.getElementById('incompleteToggleBtn');
  const lastUpdateEl           = document.getElementById('lastUpdate');
  const rawLogEl               = document.getElementById('rawLog');
  const exportCsvBtn           = document.getElementById('exportCsvBtn');
  const pdfBtn                 = document.getElementById('pdfBtn');
  const deptPdfBtn             = document.getElementById('deptPdfBtn');
  const employeeExportBtn      = document.getElementById('employeeExportBtn');
  const payrollExportBtn       = document.getElementById('payrollExportBtn');
  const topEmployeesEl         = document.getElementById('topEmployees');
  const employeeIndexListEl    = document.getElementById('employeeIndexList');
  const employeeDetailsHeaderEl= document.getElementById('employeeDetailsHeader');
  const employeeDetailsBodyEl  = document.getElementById('employeeDetailsBody');
  const kpiCompletedTodayEl    = document.getElementById('kpiCompletedToday');
  const dailyPresenceBodyEl    = document.getElementById('dailyPresenceBody');
  const incompleteDaysBodyEl   = document.getElementById('incompleteDaysBody');
  const anomaliesBodyEl        = document.getElementById('anomaliesBody');
  const lastEventsTitleEl      = document.getElementById('lastEventsTitle');
  const lastEventsHintTextEl   = document.getElementById('lastEventsHintText');
  const lastEventsRangeSelect  = document.getElementById('lastEventsRange');
  const lastEventsBodyEl       = document.getElementById('lastEventsBody');
  const rawLogTitleEl          = document.getElementById('rawLogTitle');
  const presenceCalendarEl     = document.getElementById('presenceCalendar');
  const liveBoardEl            = document.getElementById('liveBoard');
  const liveBoardHintEl        = document.getElementById('liveBoardHint');
  const liveBoardSummaryEl     = document.getElementById('liveBoardSummary');
  const liveBoardHintTextEl    = document.getElementById('liveBoardHintText');
  const liveBoardInactiveEl   = document.getElementById('liveBoardInactive');
  const liveInactiveCountEl   = document.getElementById('liveInactiveCount');

  const alertsTypeFilterEl     = document.getElementById('alertsTypeFilter');
  const alertsDeptFilterEl     = document.getElementById('alertsDeptFilter');
  const alertsSearchEl         = document.getElementById('alertsSearch');

  const incompleteDayAllBtn    = document.getElementById('incompleteDayAllBtn');
  const incompleteDayWeekendBtn= document.getElementById('incompleteDayWeekendBtn');
  const incompleteDayWorkBtn   = document.getElementById('incompleteDayWorkBtn');

  const anomalyDayAllBtn       = document.getElementById('anomalyDayAllBtn');
  const anomalyDayWeekendBtn   = document.getElementById('anomalyDayWeekendBtn');
  const anomalyDayWorkBtn      = document.getElementById('anomalyDayWorkBtn');

  const calPrevBtn             = document.getElementById('calPrevBtn');
  const calNextBtn             = document.getElementById('calNextBtn');
  const calendarMonthLabelEl   = document.getElementById('calendarMonthLabel');

  const exportIncompleteBtn    = document.getElementById('exportIncompleteBtn');
  const exportAnomaliesBtn     = document.getElementById('exportAnomaliesBtn');

  const employeeSelfLinkEl     = document.getElementById('employeeSelfLink');

  const liveBoardTodayBtn      = document.getElementById('liveBoardTodayBtn');
  const liveBoardPastBtn       = document.getElementById('liveBoardPastBtn');
  const alertsListEl           = document.getElementById('alertsList');
  const selfServiceLink        = document.getElementById('selfServiceLink'); // mic helper pentru A1/A2
  const employeeSearchInput    = document.getElementById('employeeSearch');
  const topModeHoursBtn        = document.getElementById('topModeHours');
  const topModeAnomaliesBtn    = document.getElementById('topModeAnomalies');

  // Elemente pentru pagina de Alerte LIVE
  const liveAlertsActiveEl     = document.getElementById('liveAlertsActive');
  const liveAlertsHistoryBodyEl= document.getElementById('liveAlertsHistoryBody');
  const systemAlertsHistoryBodyEl = document.getElementById('systemAlertsHistoryBody');

  const adminRefreshBtn = document.getElementById('adminRefreshBtn');
  const filterChipsEl   = document.getElementById('filterChips');
  const resetFiltersBtn = document.getElementById('resetFiltersBtn');

  const calendarDayDetailsEl        = document.getElementById('calendarDayDetails');
  const calendarSelectedDayLabelEl  = document.getElementById('calendarSelectedDayLabel');
  const calendarInactiveListEl      = document.getElementById('calendarInactiveList');

  
  // X pe chip-ul "Zi" -> scoate doar filtrul de zi
if (filterChipsEl && !filterChipsEl.dataset.boundX){
  filterChipsEl.dataset.boundX = '1';
  filterChipsEl.addEventListener('click', function(e){
    const btn = e.target.closest('[data-action="clear-day"]');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    SELECTED_CALENDAR_DAY = null;

    // refresh fără să reseteze restul filtre-lor
    if (window.__pontajAdminRefresh) window.__pontajAdminRefresh();
  });
}
  
  if (!session){
    alert('Nu ești autentificat ca admin. Te redirecționez la pagina principală.');
    window.location.href = 'index.html';
    return;
  }

    // Meniu hamburger (user + Deconectare)
  if (hamburgerBtn && hamburgerMenu && !window.__pontajAdminHamburgerBound){
    window.__pontajAdminHamburgerBound = true;

    function closeHamburgerMenu(){
      hamburgerMenu.classList.remove('open');
      hamburgerBtn.classList.remove('is-active');
      hamburgerBtn.setAttribute('aria-expanded','false');
    }

    function toggleHamburgerMenu(){
      const willOpen = !hamburgerMenu.classList.contains('open');
      if (willOpen){
        hamburgerMenu.classList.add('open');
        hamburgerBtn.classList.add('is-active');
        hamburgerBtn.setAttribute('aria-expanded','true');
      } else {
        closeHamburgerMenu();
      }
    }

    hamburgerBtn.addEventListener('click', function(e){
      e.stopPropagation();
      toggleHamburgerMenu();
    });

    // click în afara meniului => închide
    document.addEventListener('click', function(e){
      if (!hamburgerMenu.classList.contains('open')) return;
      if (hamburgerMenu.contains(e.target) || hamburgerBtn.contains(e.target)) return;
      closeHamburgerMenu();
    });

    // ESC => închide
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape'){
        closeHamburgerMenu();
      }
    });
  }

  
  ADMIN_ROLE = session.role || 'admin';
  ADMIN_DEPT = session.dept || null;

  if (adminLabelEl) adminLabelEl.textContent = session.user || 'Admin';
  if (logoutBtn){
    logoutBtn.addEventListener('click', function(){
      clearAdminSession();
      window.location.href = 'index.html';
    });
  }
function showError(err){
  const msg = (err && err.message) ? err.message : String(err);
  const stack = (err && err.stack) ? err.stack : '';
  console.error('[ADMIN ERROR]', err);

  if (errorEl){
    errorEl.textContent = msg + (stack ? '\n\n' + stack : '');
    errorEl.style.display = 'block';
  }
  if (loadingEl) loadingEl.style.display = 'none';
  if (dashboardEl) dashboardEl.style.display = 'none';
  if (alertsPageEl) alertsPageEl.style.display = 'none';
}



// bind o singură dată
// bind o singură dată (cu stack + linie)
if (!window.__pontajAdminErrBound){
  window.__pontajAdminErrBound = true;

  window.addEventListener('error', function(e){
    console.error('[window.error]', e);
    try{
      const msg =
        (e && e.message) ? e.message :
        (e && e.error && e.error.message) ? e.error.message :
        String(e);

      const where =
        (e && e.filename ? e.filename.split('/').pop() : 'admin.html') +
        ':' + (e && e.lineno ? e.lineno : '?') +
        ':' + (e && e.colno ? e.colno : '?');

      const stack = (e && e.error && e.error.stack) ? e.error.stack : '';
      showError('Eroare JS: ' + msg + ' @ ' + where + (stack ? '\n\n' + stack : ''));
    }catch(_){}
  });

  window.addEventListener('unhandledrejection', function(e){
    console.error('[unhandledrejection]', e && e.reason ? e.reason : e);
    try{
      const r = e && e.reason;
      const msg = (r && r.message) ? r.message : String(r);
      const stack = (r && r.stack) ? r.stack : '';
      showError('Promise reject: ' + msg + (stack ? '\n\n' + stack : ''));
    }catch(_){}
  });
}


  function _norm(s){ return String(s==null?'':s).trim(); }
  function _normAction(a){
    let s = _norm(a).toLowerCase().replace(/[-\s]+/g,'_');
    if (s === 'resume') s='unpause';
    if (s === 'stop') s='finish';
    if (s === 'extra start') s='extra_start';
    if (s === 'extra finish') s='extra_finish';
    return s;
  }
  function fmtDateTime(iso){
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  }
  function fmtHoursShort(ms){
    const h = ms / 3600000;
    return h.toFixed(1).replace('.', ',') + ' h';
  }
  function fmtHoursHM(ms){
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${String(m).padStart(2,'0')}m`;
  }
  function msToHours(ms){
    return ms / 3600000;
  }
let TZ = 'Europe/Bucharest';
function dateKeyFromIso(iso){
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year:'numeric',
    month:'2-digit',
    day:'2-digit'
  }).format(d); // YYYY-MM-DD
}

  let lastUpdateTimeout = null;
  function showLastUpdate(stamp){
    if (!lastUpdateEl) return;
    if (!(stamp instanceof Date) || isNaN(stamp.getTime())){
      stamp = new Date();
    }
    const hh = String(stamp.getHours()).padStart(2,'0');
    const mi = String(stamp.getMinutes()).padStart(2,'0');
    lastUpdateEl.textContent = 'Actualizat la ' + hh + ':' + mi;
    if (lastUpdateTimeout) clearTimeout(lastUpdateTimeout);
    lastUpdateTimeout = setTimeout(function(){
      if (lastUpdateEl) lastUpdateEl.textContent = '';
    }, 5000);
  }
  
  function isWeekend(dateKey){
    if (!dateKey) return false;
    const parts = dateKey.split('-');
    if (parts.length !== 3) return false;
    const y = parseInt(parts[0],10);
    const m = parseInt(parts[1],10) - 1;
    const d = parseInt(parts[2],10);
    const dt = new Date(y,m,d);
    if (isNaN(dt.getTime())) return false;
    const wd = dt.getDay(); // 0 = duminică, 6 = sâmbătă
    return wd === 0 || wd === 6;
  }

  function renderKpis(events){
    const totalEl  = document.getElementById('kpiTotal');
    const empEl    = document.getElementById('kpiEmployees');
    const startEl  = document.getElementById('kpiStart');
    const finishEl = document.getElementById('kpiFinish');

    const list = events || [];
    if (totalEl) totalEl.textContent = String(list.length);
    const uniq = new Set();
    let cStart = 0, cFinish = 0;
    list.forEach(ev => {
      if (ev.name) uniq.add(ev.name);
      if (ev.action === 'start')  cStart++;
      if (ev.action === 'finish') cFinish++;
    });
    if (empEl)    empEl.textContent = String(uniq.size);
    if (startEl)  startEl.textContent = String(cStart);
    if (finishEl) finishEl.textContent = String(cFinish);
  }

  function renderDept(events){
    const container = document.getElementById('deptList');
    if (!container) return;
    const list = events || [];
    if (!list.length){
      container.innerHTML = '<div class="admin-empty">Nu există date în filtrul curent.</div>';
      return;
    }
    const counts = {};
    list.forEach(ev => {
      const key = ev.dept || '(fără departament)';
      counts[key] = (counts[key] || 0) + 1;
    });
    const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    container.innerHTML = '';
    entries.forEach(([dept, count])=>{
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + dept + '</div>' +
        '</div>' +
        '<div class="admin-list-value">' + count + '</div>';
      // highlight dept selectat
if (currentDept && currentDept !== 'all' && dept === currentDept){
  row.classList.add('selected-dept');
}

row.addEventListener('click', function(){
  if (!deptFilter || deptFilter.disabled) return;

  // toggle: dacă dai click pe dept-ul curent -> revine pe Toate
  const next = (deptFilter.value === dept) ? 'all' : dept;

  deptFilter.value = next;
  deptFilter.dispatchEvent(new Event('change'));
});
      container.appendChild(row);
    });
  }

  function renderLastEvents(events){
    if (!lastEventsBodyEl) return;
    const list = (events || []).slice().sort((a,b)=>{
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });
    lastEventsBodyEl.innerHTML = '';
    if (!list.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nu există înregistrări în perioada aleasă (după filtre).';
      tr.appendChild(td);
      lastEventsBodyEl.appendChild(tr);
      return;
    }
    list.forEach(ev=>{
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + fmtDateTime(ev.ts) + '</td>' +
        '<td>' + (ev.name || '') + '</td>' +
        '<td>' + (ev.dept || '') + '</td>' +
        '<td>' + (ev.action || '') + '</td>' +
        '<td>' + (ev.activity || '') + '</td>';
      lastEventsBodyEl.appendChild(tr);
    });
  }

  function renderRawLog(events){
    if (!rawLogEl) return;
    const list = events || [];
    if (!list.length){
      rawLogEl.textContent = 'Nu există evenimente în filtrul curent.';
      return;
    }
    const sorted = list.slice().sort((a,b)=>{
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return ta - tb;
    });
    const lines = sorted.map(ev => {
      const t   = fmtDateTime(ev.ts);
      const dept= ev.dept || '';
      const name= ev.name || '';
      const actn= ev.action || '';
      const act = ev.activity || '';
      const loc = ev.location || '';
      let s = `[${t}] ${name}`;
      if (dept) s += ' | ' + dept;
      if (actn) s += ' | ' + actn;
      if (act)  s += ' | ' + act;
      if (loc)  s += ' | ' + loc;
      return s;
    });
    rawLogEl.textContent = lines.join('\n');
  }

  function buildDeptFilter(events){
    if (!deptFilter) return;
    const set = new Set();
    events.forEach(ev => {
      const key = ev.dept || '(fără departament)';
      if (key) set.add(key);
    });
    const depts = Array.from(set).sort((a,b)=>a.localeCompare(b,'ro'));
    deptFilter.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'Toate';
    deptFilter.appendChild(optAll);
    depts.forEach(d => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d;
      deptFilter.appendChild(o);
    });
  }

  function buildEmployeeFilter(events, selectedDept){
    if (!employeeFilter) return;
    const set = new Set();
    events.forEach(ev => {
      if (!ev.name) return;
      const deptKey = ev.dept || '(fără departament)';
      if (selectedDept && selectedDept !== 'all' && deptKey !== selectedDept) return;
      set.add(ev.name);
    });
    const emps = Array.from(set).sort((a,b)=>a.localeCompare(b,'ro'));
    employeeFilter.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'Toți';
    employeeFilter.appendChild(optAll);
    emps.forEach(n => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      employeeFilter.appendChild(o);
    });
  }

  function exportCsv(events){
    const list = events || [];
    if (!list.length){
      alert('Nu există evenimente în filtrul curent pentru export.');
      return;
    }
    const header = ['timestamp_iso','data_ora','nume','departament','actiune','activitate','locatie'];
    const rows = list.map(ev => [
      ev.ts || '',
      fmtDateTime(ev.ts) || '',
      ev.name || '',
      ev.dept || '',
      ev.action || '',
      ev.activity || '',
      ev.location || ''
    ]);
    const csvLines = [header].concat(rows).map(row => row.map(cell => {
      const s = String(cell).replace(/"/g,'""');
      return '"' + s + '"';
    }).join(','));
    const csv = csvLines.join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'pontaj-export.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

function isDayIncomplete(day){
  if (!day) return false;

  const hasAnyEvent =
    (day.events && day.events.length) ||
    day.hasStart || day.hasFinish ||
    day.pauseCount || day.unpauseCount ||
    day.extraStartCount || day.extraFinishCount;

  if (!hasAnyEvent) return false;

  return (
    !day.hasFinish ||
    day.hasPauseMismatch ||
    day.hasExtraMismatch ||
    day.openExtra
  );
}
  
function getIncompleteReasons(day){
  const reasons = [];
  if (!day) return reasons;

  if (!day.hasFinish) reasons.push('Fără FINISH');
  if (day.hasPauseMismatch) reasons.push('PAUSE/UNPAUSE neînchise');
  if (day.hasExtraMismatch) reasons.push('EXTRA START/FINISH neînchise');
  if (day.openExtra) reasons.push('EXTRA rămas în curs');

  return reasons;
}


function applyIncompleteFilter(events, stats){
  if (!filterIncompleteOnly) return events;

  const S = stats || ALL_STATS;
  if (!S || !S.employees || !events || !events.length) return events;

  return events.filter(ev => {
    if (!ev.name || !ev.ts) return false;
    const dk = dateKeyFromIso(ev.ts);
    if (!dk) return false;

    const emp = S.employees.get(ev.name);
    const day = emp && emp.days ? emp.days.get(dk) : null;
    return !!(day && isDayIncomplete(day));
  });
}

  
  function buildStatsFromEvents(events){
    const employees = new Map();
    const perDay    = new Map();

    function getEmp(name){
      if (!employees.has(name)){
        employees.set(name, {
          name,
          dept:'',
          days:new Map(),
   totals:{
      daysWithStart:0,
      daysWithFinish:0,
      daysCompleted:0,
      totalWorkMs:0,
      totalExtraMs:0,
      overtimeMs:0,
      firstEvent:null,
      lastEvent:null,

  // NOU:
  normMetDays:0,            // muncă efectivă >= normă (chiar dacă pauza e mare)
  normValidatedDays:0,      // normă + pauză în limită

  incompleteDays:0
}

        });
      }
      return employees.get(name);
    }

    const byNameDate = new Map();
    (events || []).forEach(ev => {
      if (!ev.ts || !ev.name) return;
      const dk = dateKeyFromIso(ev.ts);
      if (!dk) return;
      const key = ev.name + '||' + dk;
      if (!byNameDate.has(key)) byNameDate.set(key, []);
      byNameDate.get(key).push(ev);
    });

    byNameDate.forEach((evs, key) => {
      evs.sort((a,b)=>new Date(a.ts) - new Date(b.ts));
      const parts = key.split('||');
      const name  = parts[0];
      const dk    = parts[1];

      const emp = getEmp(name);
      let day = emp.days.get(dk);
      if (!day){
        day = {
          dateKey: dk,
          dept:'',
          events: evs,
          workMs:0,
          extraMs:0,
          pauseMs:0,
          hasStart:false,
          hasFinish:false,
          completed:false,
          overtimeMs:0,
          normMs: DEFAULT_NORM_MS,
          normValidated:false,
          incomplete:false,
          startCount:0,
          finishCount:0,
          pauseCount:0,
          unpauseCount:0,
          extraStartCount:0,
          extraFinishCount:0,
          openRunning:false,
          openExtra:false,
          hasPauseMismatch:false,
          hasExtraMismatch:false,
          // NOU (pentru afișare în Detalii angajat)
          normMet:false,
          pauseOk:true,
          pauseOverMs:0,
          pauseMarginMsUsed:0
        };
        emp.days.set(dk, day);
      } else {
        day.events = evs;
      }

      let hasLongActivity = false;
      evs.forEach(ev => {
        if (ev.dept) day.dept = ev.dept;
       if (ev.activity && ACTIVITATI_NORMA_8H30.indexOf(ev.activity.toLowerCase()) !== -1){
  hasLongActivity = true;
}
      });
      day.normMs = getNormMsFor(name, day.dept, hasLongActivity);

      if (!emp.dept && day.dept) emp.dept = day.dept;

      let running        = false;
      let paused         = false;
      let extraRunning   = false;
      let startTs        = null;
      let pauseStartTs   = null;
      let extraStartTs   = null;
      let sumPauseMs     = 0;   // pauza din segmentul curent
      let totalPauseMs   = 0;   // pauza totală pe zi
      let workMs         = 0;
      let extraMs        = 0;


      evs.forEach(ev => {
        const t = new Date(ev.ts).getTime();
        if (isNaN(t)) return;
        const act = ev.action;

        if (act === 'start') {
          day.hasStart = true;
          day.startCount++;
          if (!running) {
            running = true;
            paused  = false;
            sumPauseMs   = 0;
            startTs      = t;
            pauseStartTs = null;
          } else {
            // nou: dacă există deja o sesiune, considerăm că începe o nouă sesiune
            startTs      = t;
            paused       = false;
            pauseStartTs = null;
            sumPauseMs   = 0;
          }
        } else if (act === 'pause') {
          day.pauseCount++;
          if (running && !paused) {
            paused       = true;
            pauseStartTs = t;
          }
       } else if (act === 'unpause') {
  day.unpauseCount++;
  if (running && paused && pauseStartTs != null) {
    const delta = Math.max(0, t - pauseStartTs);
    sumPauseMs   += delta;
    totalPauseMs += delta;
    paused = false;
    pauseStartTs = null;
  }
        } else if (act === 'finish') {
          day.hasFinish = true;
          day.finishCount++;
          if (running && startTs != null) {
            if (paused && pauseStartTs != null) {
          const delta = Math.max(0, t - pauseStartTs);
          sumPauseMs   += delta;
          totalPauseMs += delta;
          pauseStartTs = null;
          paused = false;
          }
            const diff    = Math.max(0, t - startTs);
            const segment = Math.max(0, diff - sumPauseMs);
            workMs += segment;
          }
          running      = false;
          paused       = false;
          startTs      = null;
          pauseStartTs = null;
          sumPauseMs   = 0;
        } else if (act === 'extra_start') {
          day.extraStartCount++;
          if (!extraRunning) {
            extraRunning = true;
            extraStartTs = t;
          } else {
            extraStartTs = t;
          }
        } else if (act === 'extra_finish') {
          day.extraFinishCount++;
          if (extraRunning && extraStartTs != null) {
            extraMs += Math.max(0, t - extraStartTs);
          }
          extraRunning = false;
          extraStartTs = null;
        }
      });

      day.workMs   = workMs;
      day.extraMs  = extraMs;
      day.pauseMs  = totalPauseMs;

      emp.totals.totalWorkMs  += workMs;
      emp.totals.totalExtraMs += extraMs;

      if (day.hasStart)  emp.totals.daysWithStart++;
      if (day.hasFinish) emp.totals.daysWithFinish++;

      day.openRunning = day.startCount > day.finishCount;
      day.openExtra        = day.extraStartCount > day.extraFinishCount;
      day.hasPauseMismatch = day.pauseCount !== day.unpauseCount;
      day.hasExtraMismatch = day.extraStartCount !== day.extraFinishCount;

      day.incomplete = isDayIncomplete(day);
      if (day.incomplete) emp.totals.incompleteDays++;

      if (day.hasStart && day.hasFinish && workMs > 0) {
        day.completed = true;
        emp.totals.daysCompleted++;
      }

     const normForDay     = day.normMs || getNormMsFor(name, day.dept || emp.dept || '', false);
const pauseMarginMs  = getPauseMarginMsFor(name, day.dept || emp.dept || '');

// ✅ pauză inclusă în normă (ex: 30m)
const pauseNormMs = getPauseNormMsFor(name, day.dept || emp.dept || '');
const pauseMsNow  = day.pauseMs || 0;

// ✅ credităm pauza DOAR dacă există, max pauza standard (ex: 30m)
const pauseCreditMs = Math.min(pauseMsNow, pauseNormMs);

// ✅ muncă necesară = normă - pauza creditată
const workRequiredMs = Math.max(0, normForDay - pauseCreditMs);

day.pauseNormMs    = pauseNormMs;
day.pauseCreditMs  = pauseCreditMs; // (opțional, dar util pt UI/debug)
day.pauseExtraMs   = Math.max(0, pauseMsNow - pauseNormMs);
day.workRequiredMs = workRequiredMs;

day.diffNormMs     = 0;
day.missingMs      = 0;
day.overtimeMs     = 0;

if (!day.incomplete && day.completed){
  day.diffNormMs = workMs - workRequiredMs;
  day.overtimeMs = Math.max(0, day.diffNormMs);
  day.missingMs  = Math.max(0, -day.diffNormMs);

  emp.totals.overtimeMs += day.overtimeMs;
}

// ========= NORMA =========
day.normMet = false;
day.normValidated = false;
day.pauseOk = true;
day.pauseOverMs = 0;
day.pauseMarginMsUsed = pauseMarginMs;

if (!day.incomplete && day.completed){
  const pauseMs = day.pauseMs || 0;

  day.pauseOk = pauseMs <= pauseMarginMs;
  day.pauseOverMs = Math.max(0, pauseMs - pauseMarginMs);
  day.pauseMarginMsUsed = pauseMarginMs;

  // ✅ CORECT: normă îndeplinită = muncă efectivă >= (normă - pauză inclusă)
  day.normMet = workMs >= workRequiredMs;
  if (day.normMet) emp.totals.normMetDays++;

  if (day.normMet && day.pauseOk){
    day.normValidated = true;
    emp.totals.normValidatedDays++;
  }
}

      let daySummary = perDay.get(dk);
      if (!daySummary) {
        daySummary = { dateKey: dk, started: new Set(), completed: new Set() };
        perDay.set(dk, daySummary);
      }
      if (day.hasStart)   daySummary.started.add(name);
      if (day.completed)  daySummary.completed.add(name);

      evs.forEach(ev => {
        const t = new Date(ev.ts).getTime();
        if (isNaN(t)) return;
        if (!emp.totals.firstEvent || t < new Date(emp.totals.firstEvent).getTime()) {
          emp.totals.firstEvent = ev.ts;
        }
        if (!emp.totals.lastEvent || t > new Date(emp.totals.lastEvent).getTime()) {
          emp.totals.lastEvent = ev.ts;
        }
      });
    });

    return { employees, perDay };
  }

  function renderEmployeeIndex(allStats, deptFilterValue, searchTerm){
    if (!employeeIndexListEl) return;
    if (!allStats || !allStats.employees){
      employeeIndexListEl.innerHTML = '<div class="admin-empty">Nu există date.</div>';
      return;
    }
    const term = (searchTerm || '').trim().toLowerCase();
    const entries = [];
    allStats.employees.forEach((emp) => {
      const dept = emp.dept || '(fără departament)';
      if (deptFilterValue && deptFilterValue !== 'all' && dept !== deptFilterValue) return;

      if (term){
        const haystack = (emp.name + ' ' + dept).toLowerCase();
        if (!haystack.includes(term)) return;
      }

      entries.push(emp);
    });
    if (!entries.length){
      employeeIndexListEl.innerHTML = '<div class="admin-empty">Nu există angajați pentru acest filtru.</div>';
      return;
    }
    entries.sort((a,b)=>b.totals.totalWorkMs - a.totals.totalWorkMs);
    employeeIndexListEl.innerHTML = '';
    entries.forEach(emp => {
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.dataset.empName = emp.name;
      const dept = emp.dept || '(fără departament)';
      const t = emp.totals;
      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + emp.name + '</div>' +
          '<div class="admin-list-sub">' + dept + ' • ' +
            t.daysCompleted + ' zile complete, ' + fmtHoursShort(t.totalWorkMs) +
          '</div>' +
        '</div>' +
        '<div class="admin-list-value">' +
          '<span>' + fmtHoursShort(t.totalWorkMs) + '</span>' +
        '</div>';
      row.addEventListener('click', function(){
  focusEmployeeAndMaybeDay(emp.name, null); // aplică filtrul + refresh + scroll
});
      employeeIndexListEl.appendChild(row);
    });
  }

  function markSelectedEmployee(name) {
  const target = (name || "").trim().toLowerCase();

  document.querySelectorAll(".admin-list-row").forEach(el => {
    const rowName = (el.dataset.empName || "").trim().toLowerCase();
    el.classList.toggle("selected", target && rowName === target);
  });
}


  function renderEmployeeDetails(name){
    if (!employeeDetailsBodyEl || !employeeDetailsHeaderEl) return;
    if (!name){
      employeeDetailsHeaderEl.textContent = 'Selectează un angajat din listă pentru a vedea situația pe toate zilele.';
      employeeDetailsBodyEl.innerHTML = '<div class="admin-empty">Niciun angajat selectat.</div>';
      if (employeeSelfLinkEl) employeeSelfLinkEl.style.display = 'none';
      return;
    }
    if (!ALL_STATS || !ALL_STATS.employees || !ALL_STATS.employees.has(name)){
      employeeDetailsHeaderEl.textContent = 'Nu găsesc statistici pentru ' + name + '.';
      employeeDetailsBodyEl.innerHTML = '<div class="admin-empty">Nu există date pentru acest angajat.</div>';
      return;
    }
    const emp  = ALL_STATS.employees.get(name);
        if (employeeSelfLinkEl){
      // Dacă vrei baza din config, trebuie să setezi SELF_SERVICE_BASE în applySelfServiceConfig.
      // Dacă nu ai făcut asta încă, poți folosi temporar 'self.html' ca bază.
      const base = (typeof SELF_SERVICE_BASE === 'string' && SELF_SERVICE_BASE) ? SELF_SERVICE_BASE : 'self.html';
      const join = base.includes('?') ? '&' : '?';
      employeeSelfLinkEl.href = base + join + 'name=' + encodeURIComponent(name);
      employeeSelfLinkEl.style.display = '';
    }

    const dept = emp.dept || '(fără departament)';
    const t    = emp.totals;
    const met = t.normMetDays || 0;
const validated = t.normValidatedDays || 0;
const compensated = Math.max(0, met - validated);

employeeDetailsHeaderEl.innerHTML =
  'Statistici all time pentru <b>' + name + '</b> (' + dept + '). ' +
  'Zile închise (START + FINISH): <b>' + t.daysCompleted + '</b> din <b>' + t.daysWithStart + '</b> cu START. ' +
  'Zile cu <b>normă îndeplinită</b> (muncă efectivă ≥ normă - pauză creditată): <b>' + met + '</b>. ' +
  'Din acestea: <b>validată</b> (pauză în limită): <b>' + validated + '</b>, ' +
  '<b>compensată</b> (pauză depășită, dar normă făcută): <b>' + compensated + '</b>.';


    const daysArr = Array.from(emp.days.values()).sort((a,b)=>a.dateKey < b.dateKey ? -1 : (a.dateKey > b.dateKey ? 1 : 0));

    let html = '';
    html += '<div style="margin-bottom:10px;font-size:13px;">';
    html += '<div><b>Total ore normă:</b> ' + fmtHoursShort(t.totalWorkMs) + '</div>';
    html += '<div><b>Total ore extra:</b> ' + fmtHoursShort(t.totalExtraMs) + '</div>';
    html += '<div><b>Total overtime:</b> ' + fmtHoursShort(t.overtimeMs) + '</div>';
    html += '<div><b>Zile cu START:</b> ' + t.daysWithStart + ' • <b>Zile cu FINISH:</b> ' + t.daysWithFinish + '</div>';
    html += '</div>';

    if (!daysArr.length){
      html += '<div class="admin-empty">Nu există zile înregistrate pentru acest angajat.</div>';
      employeeDetailsBodyEl.innerHTML = html;
      return;
    }

    html += '<div class="table-wrap">';
    html += '<table class="admin-table">';
html += '<thead><tr>' +
  '<th>Data</th>' +
  '<th>Departament</th>' +
  '<th>Concediu</th>' +
  '<th>Muncă (fără pauză)</th>' +
  '<th>Pauză</th>' +
  '<th>Extra</th>' +
  '<th>Completă</th>' +
  '<th>Normă</th>' +
  '<th>Diferență normă</th>' +
  '<th>Suplimentar</th>' +
'</tr></thead><tbody>';

    daysArr.forEach(d => {
     const reasons = getIncompleteReasons(d);
const compStatus = d.completed
  ? '<span class="badge badge-ok">DA</span>'
  : (reasons.length
      ? '<span class="badge badge-warn">INCOMPLETĂ (' + reasons.join('; ') + ')</span>'
      : '-');


    let normStatus = '-';
if (d.completed){
  if (d.normValidated){
    normStatus = '<span class="badge badge-ok">VALIDATĂ</span>';
  } else if (d.normMet){
    normStatus =
      '<span class="badge badge-info">ÎNDEPLINITĂ</span>' +
      '<div style="font-size:10px;color:#92400e;">pauză depășită, compensată</div>';
  } else {
    normStatus = '<span class="badge badge-warn">NU</span>';
  }
}

let diffCell = '-';
let suplCell = '-';

if (d.completed && !d.incomplete){
  const diff = d.diffNormMs || 0;
  const sign = diff >= 0 ? '+' : '-';
  diffCell = sign + ' ' + fmtHoursHM(Math.abs(diff));
  suplCell = (d.overtimeMs ? fmtHoursHM(d.overtimeMs) : '0h 00m');
}

      const isLeave = isEmployeeOnLeave(name, d.dateKey);
      const pauseMs = d.pauseMs || 0;
const pauseLimitMs = (typeof d.pauseMarginMsUsed === 'number' && !isNaN(d.pauseMarginMsUsed))
  ? d.pauseMarginMsUsed
  : getPauseMarginMsFor(name, d.dept || dept);

const pauseOverMs = Math.max(0, pauseMs - pauseLimitMs);

const pauseCell =
  (pauseMs ? fmtHoursHM(pauseMs) : '0h 00m') +
  '<div style="font-size:10px;color:#6b7280;">limită ' + fmtHoursHM(pauseLimitMs) +
  (pauseOverMs > 0 ? (' • +' + fmtHoursHM(pauseOverMs)) : ' • OK') +
  '</div>';

const workCell =
  (d.workMs ? fmtHoursHM(d.workMs) : '-') +
  '<div style="font-size:10px;color:#6b7280;">normă ' + fmtHoursHM(d.normMs || 0) + '</div>';

 html += '<tr>' +
  '<td>' + d.dateKey + '</td>' +
  '<td>' + (d.dept || '') + '</td>' +
  '<td>' + (isLeave ? '<span class="badge badge-info">CONCEDIU</span>' : '-') + '</td>' +
  '<td>' + workCell + '</td>' +
  '<td>' + pauseCell + '</td>' +
  '<td>' + (d.extraMs ? fmtHoursHM(d.extraMs) : '-') + '</td>' +
  '<td>' + compStatus + '</td>' +
  '<td>' + normStatus + '</td>' +
  '<td>' + diffCell + '</td>' +
  '<td>' + suplCell + '</td>' +
'</tr>';
    });

    html += '</tbody></table></div>';
    employeeDetailsBodyEl.innerHTML = html;
  }

  function renderTopEmployees(allStats){
    if (!topEmployeesEl) return;
    if (!allStats || !allStats.employees){
      topEmployeesEl.innerHTML = '<div class="admin-empty">Nu există date.</div>';
      return;
    }
    const entries = [];
    allStats.employees.forEach((emp) => entries.push(emp));
    if (!entries.length){
      topEmployeesEl.innerHTML = '<div class="admin-empty">Nu există date.</div>';
      return;
    }

    // Dacă suntem pe modul "anomalii", calculează-le pentru fiecare angajat
    if (TOP_MODE === 'anomalies'){
      entries.forEach(emp => {
        if (emp._anomalyComputed) return;
        let anomalyDays = 0;
        let anomalyEvents = 0;

        emp.days.forEach(day => {
          const dept = day.dept || emp.dept || '';
          const pauseMarginMs = getPauseMarginMsFor(emp.name, dept);
          let c = 0;
          if (day.hasPauseMismatch) c++;
          if (day.hasExtraMismatch) c++;
          if (day.openRunning)      c++;
          if (day.openExtra)        c++;
          if (day.pauseMs && day.pauseMs > pauseMarginMs) c++;
          if (day.workMs && day.workMs > 12 * 60 * 60 * 1000) c++;
          if (isWeekend(day.dateKey) && (day.workMs || day.extraMs)) c++;

          if (c > 0){
            anomalyDays++;
            anomalyEvents += c;
          }
        });

        emp.totals.__anomalyDays   = anomalyDays;
        emp.totals.__anomalyEvents = anomalyEvents;
        emp._anomalyComputed       = true;
      });
    }

    entries.sort((a,b)=>{
      const ta = a.totals;
      const tb = b.totals;

      if (TOP_MODE === 'anomalies'){
        const ca = (ta.__anomalyEvents || ta.__anomalyDays || 0);
        const cb = (tb.__anomalyEvents || tb.__anomalyDays || 0);
        if (cb !== ca) return cb - ca;

        const ia = ta.incompleteDays || 0;
        const ib = tb.incompleteDays || 0;
        if (ib !== ia) return ib - ia;

        return (tb.totalWorkMs || 0) - (ta.totalWorkMs || 0);
      }

      // default: după total ore normă
      return (tb.totalWorkMs || 0) - (ta.totalWorkMs || 0);
    });

    const top = entries.slice(0,5);
    topEmployeesEl.innerHTML = '';
    top.forEach(emp => {
      const t = emp.totals;
      let primary, secondary;

      if (TOP_MODE === 'anomalies'){
        const days   = t.__anomalyDays   || 0;
        const events = t.__anomalyEvents || days;
        primary   = days + ' zile cu anomalii';
        secondary = events + ' tipuri de abateri';
      } else {
        primary   = fmtHoursShort(t.totalWorkMs);
        secondary = t.daysCompleted + ' zile complete';
      }

      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.dataset.empName = emp.name;
      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + emp.name + '</div>' +
          '<div class="admin-list-sub">' + (emp.dept || '(fără departament)') + '</div>' +
        '</div>' +
        '<div class="admin-list-value">' +
          '<div>' + primary + '</div>' +
          '<div style="font-size:11px;color:#6b7280;">' + secondary + '</div>' +
        '</div>';
     row.addEventListener('click', function(){
  focusEmployeeAndMaybeDay(emp.name, null);
});
      topEmployeesEl.appendChild(row);
    });
  }

  function filterByRange(events, range){
    if (!events || !events.length) return [];
    const now = new Date();
    if (range === 'all') return events.slice();
    const endTime = now.getTime();
    let startTime;
    if (range === 'last7'){
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
  d.setDate(d.getDate() - 6);
  startTime = d.getTime();
} else { // today
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
      startTime = d.getTime();
    }
    return events.filter(ev => {
      if (!ev.ts) return false;
      const t = new Date(ev.ts).getTime();
      if (isNaN(t)) return false;
      return t >= startTime && t <= endTime;
    });
  }

  function filterLastEventsByRange(events, range){
    if (!events || !events.length) return [];
    const now = new Date();
    const endTime = now.getTime();
    let startTime = null;

    if (range === 'today'){
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
      startTime = d.getTime();
    } else if (range === 'week'){
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
      const day = d.getDay(); // 0 = duminică
      const diffToMonday = (day + 6) % 7;
      d.setDate(d.getDate() - diffToMonday);
      startTime = d.getTime();
    } else if (range === 'month'){
      const d = new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0);
      startTime = d.getTime();
    } else {
      return events.slice();
    }

    return events.filter(ev => {
      if (!ev.ts) return false;
      const t = new Date(ev.ts).getTime();
      if (isNaN(t)) return false;
      return t >= startTime && t <= endTime;
    });
  }

  function updateCompletedTodayKpiFromStats(stats){
  if (!kpiCompletedTodayEl) return;

  if (!stats || !stats.employees || !stats.employees.size){
    kpiCompletedTodayEl.textContent = '0 / 0';
    return;
  }

  let total = 0, completed = 0;
  stats.employees.forEach(emp => {
    const t = emp.totals;
    if (t.daysWithStart || t.daysWithFinish){
      total++;
      if ((t.normMetDays || 0) > 0) completed++;
    }
  });

  kpiCompletedTodayEl.textContent = completed + ' / ' + total;
}


  function renderDailyPresence(stats){
    if (!dailyPresenceBodyEl) return;
    dailyPresenceBodyEl.innerHTML = '';
    if (!stats || !stats.perDay || !stats.perDay.size){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nu există zile în filtrul curent.';
      tr.appendChild(td);
      dailyPresenceBodyEl.appendChild(tr);
      return;
    }
    const entries = Array.from(stats.perDay.values())
      .sort((a,b)=>a.dateKey < b.dateKey ? -1 : (a.dateKey > b.dateKey ? 1 : 0));
    entries.forEach(day => {
      const started   = day.started   ? day.started.size   : 0;
      const completed = day.completed ? day.completed.size : 0;
      const pct       = started ? Math.round(100 * completed / started) : 0;
      const leaveCount = LEAVE_BY_DAY && LEAVE_BY_DAY.get(day.dateKey)
        ? LEAVE_BY_DAY.get(day.dateKey).size
        : 0;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + day.dateKey + '</td>' +
        '<td>' + started + '</td>' +
        '<td>' + completed + '</td>' +
        '<td>' + (started ? pct + '%' : '–') + '</td>' +
        '<td>' + (leaveCount || 0) + '</td>';
      dailyPresenceBodyEl.appendChild(tr);
    });
  }

  function renderIncompleteDays(baseEvents){
    if (!incompleteDaysBodyEl) return;
    incompleteDaysBodyEl.innerHTML = '';

    if (!baseEvents || !baseEvents.length || !ALL_STATS || !ALL_STATS.employees || !ALL_STATS.employees.size){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Nu există zile incomplete în filtrul curent.';
      tr.appendChild(td);
      incompleteDaysBodyEl.appendChild(tr);
      return;
    }

    const keyMap = new Map();
    baseEvents.forEach(ev => {
      if (!ev.name || !ev.ts) return;
      const dk = dateKeyFromIso(ev.ts);
      if (!dk) return;
      const key = ev.name + '||' + dk;
      if (!keyMap.has(key)){
        keyMap.set(key, {
          name: ev.name,
          dateKey: dk,
          deptHint: ev.dept || ''
        });
      }
    });

    const rows = [];
    keyMap.forEach(info => {
      const emp = ALL_STATS.employees.get(info.name);
      if (!emp) return;
      const day = emp.days.get(info.dateKey);
      if (!day) return;
      if (!isDayIncomplete(day)) return;
      rows.push({
        dateKey: info.dateKey,
        name: info.name,
        dept: day.dept || emp.dept || info.deptHint || '',
        workMs: day.workMs,
        extraMs: day.extraMs,
        day
      });
    });

    if (!rows.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Nu există zile incomplete în filtrul curent.';
      tr.appendChild(td);
      incompleteDaysBodyEl.appendChild(tr);
      return;
    }

    rows.sort((a,b)=>{
      if (a.dateKey < b.dateKey) return -1;
      if (a.dateKey > b.dateKey) return 1;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    LATEST_INCOMPLETE_ROWS = [];

    rows.forEach(item => {
      const wk = isWeekend(item.dateKey);
      if (INCOMPLETE_DAY_FILTER === 'weekend' && !wk) return;
      if (INCOMPLETE_DAY_FILTER === 'workday' && wk) return;

      const isLeave = isEmployeeOnLeave(item.name, item.dateKey);
      const leaveBadge = isLeave ? '<span class="badge badge-info">CONCEDIU</span> ' : '';

      const reasons = getIncompleteReasons(item.day);
      const statusText = leaveBadge + (reasons.length ? reasons.join('; ') : 'Incomplet');


      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.name = item.name;
      tr.dataset.dateKey = item.dateKey;
      tr.innerHTML =
        '<td>' + item.dateKey + '</td>' +
        '<td>' + item.name + '</td>' +
        '<td>' + item.dept + '</td>' +
        '<td>' + (item.workMs ? fmtHoursHM(item.workMs) : '-') + '</td>' +
        '<td>' + (item.extraMs ? fmtHoursHM(item.extraMs) : '-') + '</td>' +
        '<td>' + statusText + '</td>';

      LATEST_INCOMPLETE_ROWS.push({
        dateKey:item.dateKey,
        name:item.name,
        dept:item.dept,
        work:item.workMs ? fmtHoursHM(item.workMs) : '',
        extra:item.extraMs ? fmtHoursHM(item.extraMs) : '',
        leave:isLeave ? 'DA' : 'NU',
        status: (reasons.length ? reasons.join('; ') : 'Incomplet')
      });

      incompleteDaysBodyEl.appendChild(tr);
    });
  }

  function renderAnomalies(baseEvents){
    if (!anomaliesBodyEl) return;
    anomaliesBodyEl.innerHTML = '';

    if (!baseEvents || !baseEvents.length || !ALL_STATS || !ALL_STATS.employees || !ALL_STATS.employees.size){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Nu există anomalii în filtrul curent.';
      tr.appendChild(td);
      anomaliesBodyEl.appendChild(tr);
      return;
    }

    const keyMap = new Map();
    baseEvents.forEach(ev=>{
      if (!ev.name || !ev.ts) return;
      const dk = dateKeyFromIso(ev.ts);
      if (!dk) return;
      const key = ev.name + '||' + dk;
      if (!keyMap.has(key)){
        keyMap.set(key, { name:ev.name, dateKey:dk, deptHint:ev.dept || '' });
      }
    });

    const rows = [];
    keyMap.forEach(info=>{
      const emp = ALL_STATS.employees.get(info.name);
      if (!emp) return;
      const day = emp.days.get(info.dateKey);
      if (!day) return;

      const reasons = [];
      const normForDay = day.normMs || getNormMsFor(info.name, day.dept || emp.dept || '', false);
      const pauseMarginMs = getPauseMarginMsFor(info.name, day.dept || emp.dept || '');

      if (day.hasPauseMismatch){
        reasons.push('PAUSE / UNPAUSE nu se potrivesc');
      }
      if (day.hasExtraMismatch){
        reasons.push('EXTRA START / EXTRA FINISH nu se potrivesc');
      }
      if (day.openRunning){
        reasons.push('Sesiune normă rămasă deschisă (START fără FINISH)');
      }
      if (day.openExtra){
        reasons.push('Sesiune EXTRA rămasă deschisă');
      }
      if (day.pauseMs && day.pauseMs > pauseMarginMs){
        reasons.push('Pauză mai mare decât limita (' + fmtHoursHM(day.pauseMs) + ' > ' + fmtHoursHM(pauseMarginMs) + ')');
      }
      if (day.workMs && day.workMs > 12 * 60 * 60 * 1000){
        reasons.push('Normă foarte mare în aceeași zi (>12h)');
      }
      if (isWeekend(info.dateKey) && (day.workMs || day.extraMs)){
        reasons.push('Pontaj în weekend');
      }

      if (!reasons.length) return;

      rows.push({
        dateKey: info.dateKey,
        name: info.name,
        dept: day.dept || emp.dept || info.deptHint || '',
        workMs: day.workMs,
        extraMs: day.extraMs,
        reasons: reasons.join('; ')
      });
    });

    if (!rows.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Nu există anomalii în filtrul curent.';
      tr.appendChild(td);
      anomaliesBodyEl.appendChild(tr);
      return;
    }

    rows.sort((a,b)=>{
      if (a.dateKey < b.dateKey) return -1;
      if (a.dateKey > b.dateKey) return 1;
      return a.name.localeCompare(b.name,'ro');
    });

    LATEST_ANOMALY_ROWS = [];

    rows.forEach(item=>{
      const wk = isWeekend(item.dateKey);
      if (ANOMALY_DAY_FILTER === 'weekend' && !wk) return;
      if (ANOMALY_DAY_FILTER === 'workday' && wk) return;

      const isLeave = isEmployeeOnLeave(item.name, item.dateKey);
      const leaveBadge = isLeave ? '<span class="badge badge-info">CONCEDIU</span> ' : '';

      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.name = item.name;
      tr.dataset.dateKey = item.dateKey;
      tr.innerHTML =
        '<td>' + item.dateKey + '</td>' +
        '<td>' + item.name + '</td>' +
        '<td>' + item.dept + '</td>' +
        '<td>' + (item.workMs ? fmtHoursHM(item.workMs) : '-') + '</td>' +
        '<td>' + (item.extraMs ? fmtHoursHM(item.extraMs) : '-') + '</td>' +
        '<td>' + leaveBadge + item.reasons + '</td>';

      LATEST_ANOMALY_ROWS.push({
        dateKey:item.dateKey,
        name:item.name,
        dept:item.dept,
        work:item.workMs ? fmtHoursHM(item.workMs) : '',
        extra:item.extraMs ? fmtHoursHM(item.extraMs) : '',
        leave:isLeave ? 'DA' : 'NU',
        reasons:item.reasons
      });

      anomaliesBodyEl.appendChild(tr);
    });
  }

  function applyDeptEmployee(events, currentDept, currentEmployee){
    let list = events.slice();
    if (currentDept && currentDept !== 'all'){
      list = list.filter(ev => (ev.dept || '(fără departament)') === currentDept);
    }
    if (currentEmployee && currentEmployee !== 'all'){
      list = list.filter(ev => ev.name === currentEmployee);
    }
    return list;
  }

  function getRosterFiltered(){
  let arr = [];

  if (ALL_STATS && ALL_STATS.employees && ALL_STATS.employees.size){
    ALL_STATS.employees.forEach(emp=>{
      arr.push({ name: emp.name, dept: emp.dept || '(fără departament)' });
    });
  } else {
    const byName = new Map();
    (window.__pontajAdminEvents || []).forEach(ev=>{
      if (!ev || !ev.name) return;
      const prev = byName.get(ev.name);
      const dept = ev.dept || '(fără departament)';
      if (!prev || (prev.dept === '(fără departament)' && dept !== '(fără departament)')){
        byName.set(ev.name, { name: ev.name, dept });
      }
    });
    arr = Array.from(byName.values());
  }

  // teamlead lock
  if (ADMIN_ROLE === 'teamlead' && ADMIN_DEPT){
    arr = arr.filter(x => (x.dept || '') === ADMIN_DEPT);
  }

  // respectă filtrele curente (dept/employee)
  if (currentDept && currentDept !== 'all'){
    arr = arr.filter(x => (x.dept || '(fără departament)') === currentDept);
  }
  if (currentEmployee && currentEmployee !== 'all'){
    arr = arr.filter(x => x.name === currentEmployee);
  }

  arr.sort((a,b)=>a.name.localeCompare(b.name,'ro'));
  return arr;
}

function renderInactiveToday(activeNamesSet, todayKey){
  if (!liveBoardInactiveEl) return;

  const roster = getRosterFiltered();
  const inactive = roster.filter(x => !activeNamesSet.has(x.name));

  liveBoardInactiveEl.innerHTML = '';

  if (liveInactiveCountEl){
    const countNoLeave = inactive.filter(x => !isEmployeeOnLeave(x.name, todayKey)).length;
    liveInactiveCountEl.style.display = '';
    liveInactiveCountEl.textContent = `Inactivi: ${countNoLeave}`;
  }

  if (!inactive.length){
    liveBoardInactiveEl.innerHTML = '<div class="admin-empty">Nimeni inactiv pentru filtrele curente.</div>';
    return;
  }

  inactive.forEach(x=>{
    const isLeave = isEmployeeOnLeave(x.name, todayKey);
    const row = document.createElement('div');
    row.className = 'admin-list-row clickable';
    row.dataset.empName = x.name;

    row.innerHTML =
      '<div>' +
        '<div class="admin-list-label">' + x.name + '</div>' +
        '<div class="admin-list-sub">' + (x.dept || '(fără departament)') + '</div>' +
      '</div>' +
      '<div class="admin-list-value">' +
        (isLeave
          ? '<span class="badge badge-info">CONCEDIU</span>'
          : '<span class="badge badge-warn">Fără pontaj</span>') +
      '</div>';

    row.addEventListener('click', function(){
      focusEmployeeAndMaybeDay(x.name, todayKey || null);
    });

    liveBoardInactiveEl.appendChild(row);
  });
}
  
  // LIVE BOARD: două moduri (azi / zile anterioare)
    function renderLiveBoard(){
    if (!liveBoardEl) return;
    liveBoardEl.innerHTML = '';

    if (liveBoardSummaryEl){
      liveBoardSummaryEl.innerHTML = '';
    }

    let allEvents = window.__pontajAdminEvents || [];

    const role = ADMIN_ROLE || 'admin';
    if (role === 'teamlead' && ADMIN_DEPT){
      allEvents = allEvents.filter(ev => (ev.dept || '') === ADMIN_DEPT);
    }

    const now = new Date();
    const todayKey = dateKeyFromIso(now.toISOString());
    if (!todayKey){
      liveBoardEl.innerHTML = '<div class="admin-empty">Nu pot determina data curentă.</div>';
      return;
    }

    // --- MODE: PAST (angajat -> ultima zi incompletă) ---
    if (LIVE_BOARD_MODE === 'past'){
      if (!ALL_STATS || !ALL_STATS.employees || !ALL_STATS.employees.size){
        liveBoardEl.innerHTML = '<div class="admin-empty">Nu există date pentru a calcula zilele anterioare.</div>';
        return;
      }

      const rows = [];
      ALL_STATS.employees.forEach(emp=>{
        let latest = null;
        let count  = 0;

        emp.days.forEach(day=>{
          if (!day || !day.incomplete) return;
          const dk = day.dateKey;
          if (!dk || dk >= todayKey) return;

          const dept = day.dept || emp.dept || '';
          if (role === 'teamlead' && ADMIN_DEPT && dept !== ADMIN_DEPT) return;

          count++;
          if (!latest || dk > latest) latest = dk;
        });

        if (count){
          rows.push({
            name: emp.name,
            dept: emp.dept || '(fără departament)',
            count,
            dateKey: latest
          });
        }
      });

      if (!rows.length){
        liveBoardEl.innerHTML = '<div class="admin-empty">Toate zilele anterioare sunt complete (nu există zile incomplete până la azi).</div>';
        return;
      }

      rows.sort((a,b)=>a.name.localeCompare(b.name,'ro'));

      if (liveBoardSummaryEl){
        liveBoardSummaryEl.innerHTML =
          '<div class="liveboard-summary">' +
            '<span class="chip">⚠ Angajați cu zile incomplete: <b>' + rows.length + '</b></span>' +
          '</div>';
      }

      rows.forEach(r=>{
        const row = document.createElement('div');
        row.className = 'admin-list-row';
        row.dataset.empName = r.name;
        row.innerHTML =
          '<div>' +
            '<div class="admin-list-label">' + r.name + '</div>' +
            '<div class="admin-list-sub">' + r.dept + (r.dateKey ? (' • ultima: ' + r.dateKey) : '') + '</div>' +
          '</div>' +
          '<div class="admin-list-value">' +
            '<span class="badge badge-warn">⚠ ' + r.count + ' zile incomplete</span>' +
          '</div>';

        row.addEventListener('click', function(){
          focusEmployeeAndMaybeDay(r.name, r.dateKey || null);
        });

        liveBoardEl.appendChild(row);
      });

      return;
    }

    // --- MODE: TODAY ---
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
    const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);

const baseLiveEvents = applyDeptEmployee(allEvents, currentDept, currentEmployee);

const todayEvents = baseLiveEvents.filter(ev=>{
  if (!ev.ts) return false;
  const t = new Date(ev.ts);
  if (isNaN(t.getTime())) return false;
  return t >= todayStart && t <= todayEnd;
});

    if (!todayEvents.length){
      liveBoardEl.innerHTML = '<div class="admin-empty">Niciun pontaj înregistrat azi.</div>';
      return;
    }

    const byName = new Map();
    todayEvents.forEach(ev=>{
      if (!ev.name) return;
      if (!byName.has(ev.name)) byName.set(ev.name, []);
      byName.get(ev.name).push(ev);
    });

const activeNames = new Set(Array.from(byName.keys()));
renderInactiveToday(activeNames, todayKey);
      
    const rows = [];
    byName.forEach((list, name)=>{
      list.sort((a,b)=>new Date(a.ts) - new Date(b.ts));

      let baseState = 'none'; // working|paused|closed|none
      let baseTs = null;

      let extraState = 'none'; // extra_running|none
      let extraTs = null;

      let lastDept = '';

      list.forEach(ev=>{
        const t = new Date(ev.ts).getTime();
        if (isNaN(t)) return;
        if (ev.dept) lastDept = ev.dept;

        const act = ev.action;

        if (act === 'start' || act === 'unpause'){ baseState='working'; baseTs=t; }
        else if (act === 'pause'){ baseState='paused'; baseTs=t; }
        else if (act === 'finish'){ baseState='closed'; baseTs=t; }

        if (act === 'extra_start'){ extraState='extra_running'; extraTs=t; }
        else if (act === 'extra_finish'){ extraState='none'; extraTs=t; }
      });

      function fmtSince(ts){
        if (!ts) return '';
        const diffMs = now.getTime() - ts;
        if (diffMs <= 0) return '';
        const mins = Math.round(diffMs / 60000);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h > 0) return h + 'h ' + String(m).padStart(2,'0') + 'm';
        return m + ' min';
      }

      let state='Fără pontaj azi', badgeClass='badge-info', sinceLabel='';

      if (extraState === 'extra_running'){
        state='Extra în curs'; badgeClass='badge-ok'; sinceLabel=fmtSince(extraTs);
      } else if (baseState === 'paused'){
        state='În pauză'; badgeClass='badge-warn'; sinceLabel=fmtSince(baseTs);
      } else if (baseState === 'working'){
        state='Lucrează'; badgeClass='badge-ok'; sinceLabel=fmtSince(baseTs);
      } else if (baseState === 'closed' || list.length){
        state='Închis azi'; badgeClass='badge-info'; sinceLabel='';
      }

      rows.push({ name, dept:lastDept||'', state, badgeClass, sinceLabel });
    });

    rows.sort((a,b)=>a.name.localeCompare(b.name,'ro'));

    // summary counters
    let cWorking=0, cPaused=0, cExtra=0, cClosed=0;
    rows.forEach(r=>{
      if (r.state === 'Lucrează') cWorking++;
      else if (r.state === 'În pauză') cPaused++;
      else if (r.state === 'Extra în curs') cExtra++;
      else if (r.state === 'Închis azi') cClosed++;
    });
    if (liveBoardSummaryEl){
      liveBoardSummaryEl.innerHTML =
        '<div class="liveboard-summary">' +
          '<span class="chip">Lucrează: <b>' + cWorking + '</b></span>' +
          '<span class="chip">În pauză: <b>' + cPaused + '</b></span>' +
          '<span class="chip">Extra: <b>' + cExtra + '</b></span>' +
          '<span class="chip">Închis: <b>' + cClosed + '</b></span>' +
        '</div>';
    }

    rows.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      row.dataset.empName = r.name;
      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + r.name + '</div>' +
          '<div class="admin-list-sub">' + (r.dept || '(fără departament)') + '</div>' +
        '</div>' +
        '<div class="admin-list-value">' +
          '<div><span class="badge ' + r.badgeClass + '">' + r.state + '</span></div>' +
          (r.sinceLabel ? '<div style="font-size:11px;color:#6b7280;">de ' + r.sinceLabel + '</div>' : '') +
        '</div>';

      row.addEventListener('click', function(){
        focusEmployeeAndMaybeDay(r.name, null);
      });

      liveBoardEl.appendChild(row);
    });
  }

  function renderAlertsFromMeta(){
    if (!alertsListEl) return;
    alertsListEl.innerHTML = '';
    const meta = window.__pontajAdminMeta || null;
    const alerts = meta && Array.isArray(meta.alerts) ? meta.alerts : [];
    if (!alerts.length){
      alertsListEl.innerHTML = '<div class="admin-empty">Nicio alertă de la sistem.</div>';
      return;
    }
    alerts.slice(0,10).forEach(a=>{
      const row = document.createElement('div');
      row.className = 'admin-list-row';
      const when = a.ts ? fmtDateTime(a.ts) : '';
      const level = (a.level || 'info').toLowerCase();
      let badgeClass = 'badge-info';
      if (level === 'warn' || level === 'warning') badgeClass = 'badge-warn';
      if (level === 'error' || level === 'danger') badgeClass = 'badge-warn';
      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + (a.title || 'Alertă sistem') + '</div>' +
          '<div class="admin-list-sub">' + (when || '') + '</div>' +
        '</div>' +
        '<div class="admin-list-value">' +
          '<span class="badge ' + badgeClass + '">' + (a.message || '') + '</span>' +
        '</div>';
      alertsListEl.appendChild(row);
    });
  }

  // NOU: istoric detaliat de alerte din meta.alerts (toate zilele)
    function renderSystemAlertsHistory(){
    if (!systemAlertsHistoryBodyEl) return;
    systemAlertsHistoryBodyEl.innerHTML = '';

    const meta = window.__pontajAdminMeta || null;
    const alerts = meta && Array.isArray(meta.alerts) ? meta.alerts : [];

    if (!alerts.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nu există alerte înregistrate în istoric.';
      tr.appendChild(td);
      systemAlertsHistoryBodyEl.appendChild(tr);
      return;
    }

    const q = (ALERTS_FILTER_Q || '').trim().toLowerCase();

    let sorted = alerts.slice().sort((a,b)=>{
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });

    // Tip alertă: meta.alerts e considerat "system"
    if (ALERTS_FILTER_TYPE !== 'all' && ALERTS_FILTER_TYPE !== 'system'){
      sorted = [];
    }

    if (ALERTS_FILTER_DEPT !== 'all'){
      sorted = sorted.filter(x => (x.dept || '') === ALERTS_FILTER_DEPT);
    }

    if (q){
      sorted = sorted.filter(x => alertHaystack(x).includes(q));
    }

    if (!sorted.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nu există alerte sistem pentru filtrele curente.';
      tr.appendChild(td);
      systemAlertsHistoryBodyEl.appendChild(tr);
      return;
    }

    sorted.forEach(a=>{
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.name = (a.name || '');
      tr.dataset.dateKey = (a.dateKey || (a.ts ? (dateKeyFromIso(a.ts) || '') : ''));

      const level = (a.level || 'info').toLowerCase();
      let typeLabel = 'Info';
      if (level === 'warn' || level === 'warning') typeLabel = 'Avertizare';
      if (level === 'error' || level === 'danger')  typeLabel = 'Eroare';

      tr.innerHTML =
        '<td>' + (a.ts ? fmtDateTime(a.ts) : '') + '</td>' +
        '<td>' + (a.name || '') + '</td>' +
        '<td>' + (a.dept || '') + '</td>' +
        '<td>' + typeLabel + '</td>' +
        '<td>' + (a.message || a.title || '') + '</td>';

      systemAlertsHistoryBodyEl.appendChild(tr);
    });
  }

  function applySelfServiceConfig(cfg){
    if (!selfServiceLink || !cfg) return;
    const base = cfg.selfServiceBaseUrl || cfg.selfUrl || null;
    SELF_SERVICE_BASE = base;
    if (!base) return;
    const q = [];
    if (ADMIN_SESSION && ADMIN_SESSION.userEmail){
      q.push('email=' + encodeURIComponent(ADMIN_SESSION.userEmail));
    }
    if (ADMIN_SESSION && ADMIN_SESSION.user){
      q.push('name=' + encodeURIComponent(ADMIN_SESSION.user));
    }
    const url = base + (q.length ? ('?' + q.join('&')) : '');
    selfServiceLink.href = url;
  }

    function setActiveTab(tab){
    // tab: 'dashboard' | 'alerts'
    if (!tabButtons || !tabButtons.length) return;
    tabButtons.forEach(b=>{
      const isActive = (b.dataset.tab === tab);
      b.classList.toggle('active', isActive);
    });
    if (tab === 'alerts'){
      if (dashboardEl) dashboardEl.style.display = 'none';
      if (alertsPageEl) alertsPageEl.style.display = '';
    } else {
      if (dashboardEl) dashboardEl.style.display = '';
      if (alertsPageEl) alertsPageEl.style.display = 'none';
    }
  }

  function ensureEmployeeOption(name){
    if (!employeeFilter || !name) return;
    if (!employeeFilter.querySelector('option[value="'+name+'"]')){
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      employeeFilter.appendChild(o);
    }
  }

  function focusEmployeeAndMaybeDay(name, dateKey){
    if (!name) return;
    setActiveTab('dashboard');

    SELECTED_EMPLOYEE = name;
    if (dateKey) SELECTED_CALENDAR_DAY = dateKey;

    if (employeeFilter){
      ensureEmployeeOption(name);
      employeeFilter.value = name;
      employeeFilter.dispatchEvent(new Event('change'));
    } else {
      renderEmployeeDetails(name);
      if (window.__pontajAdminRefresh) window.__pontajAdminRefresh();
    }

    // scroll către detalii
    setTimeout(()=>{
      if (employeeDetailsBodyEl && employeeDetailsBodyEl.scrollIntoView){
        employeeDetailsBodyEl.scrollIntoView({behavior:'smooth', block:'start'});
      }
    }, 0);
  }

  function exportCsvGeneric(filename, header, rows){
    if (!rows || !rows.length){
      alert('Nu există date pentru export.');
      return;
    }
    const csvLines = [header].concat(rows).map(row => row.map(cell => {
      const s = String(cell == null ? '' : cell).replace(/"/g,'""');
      return '"' + s + '"';
    }).join(','));
    const csv = csvLines.join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },0);
  }

  function alertHaystack(obj){
    const s = [
      obj && obj.name ? obj.name : '',
      obj && obj.dept ? obj.dept : '',
      obj && obj.message ? obj.message : '',
      obj && obj.title ? obj.title : '',
      obj && obj.detail ? obj.detail : ''
    ].join(' ').toLowerCase();
    return s;
  }

  function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

  function fmtAgo(ageSec) {
  const n = Number(ageSec);
  if (!isFinite(n) || n >= 999000) return "niciodată";
  if (n < 60) return `acum ${Math.floor(n)} sec`;
  if (n < 3600) return `acum ${Math.floor(n / 60)} min`;
  return `acum ${Math.floor(n / 3600)} h`;
}

// Fallback pentru CSS.escape (în caz că nu există)
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) {
  window.CSS.escape = function (s) {
    return String(s).replace(/["\\]/g, '\\$&');
  };
}
function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cbName = "jsonp_cb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");

    let settled = false;

    const cleanupScript = () => {
      if (script && script.parentNode) script.parentNode.removeChild(script);
    };

    const cleanupAll = () => {
      cleanupScript();
      // ștergem callback-ul puțin mai târziu, safe
      setTimeout(() => {
        try { delete window[cbName]; } catch {}
      }, 1000);
    };

    // IMPORTANT: callback-ul există mereu, chiar și dacă timeout-ul a trecut
    window[cbName] = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAll();
      resolve(data);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      // ✅ CHEIA: NU îl ștergem imediat -> îl transformăm în NO-OP
      // ca să nu crape dacă răspunsul vine târziu
      window[cbName] = function () {};

      cleanupScript();

      // îl curățăm definitiv mai târziu
      setTimeout(() => {
        try { delete window[cbName]; } catch {}
      }, 60000);

      reject(new Error("JSONP timeout"));
    }, timeoutMs);

    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      window[cbName] = function () {};
      cleanupScript();

      setTimeout(() => {
        try { delete window[cbName]; } catch {}
      }, 60000);

      reject(new Error("JSONP load error"));
    };

    const sep = url.includes("?") ? "&" : "?";
    script.async = true;
    script.src = url + sep + "callback=" + cbName + "&_=" + Date.now();

    document.head.appendChild(script);
  });
}

  
// =================== Admin presence (online/offline) ===================
const PRES_TTL_MIN = 2;                 // după 2 minute fără ping -> INACTIV
const PRES_REFRESH_MS = 10000; // la 10 sec
const PRES_PING_MS    = 20000; // ping la 20 sec

let presTimerRefresh = null;
let presTimerPing = null;

async function fetchAdminsFromAuth(){
  try{
    const cfg = await loadConfig(); // ✅ ia configul corect
    const authUrl = (cfg && cfg.adminAuthUrl) ? cfg.adminAuthUrl : '';
    if (!authUrl) return [];

    const r = await fetch(authUrl, { cache: 'no-store' });
    const j = await r.json();

    const admins = Array.isArray(j.admins) ? j.admins : [];

    // IMPORTANT: id-ul adminului = usernameHash
    return admins.map(a => ({
      id: a.id || a.usernameHash || a.userHash || '',
      label: a.label || 'Admin'
    })).filter(a => a.id);

  }catch(e){
    return [];
  }
}

async function fetchAdminPresence() {
  const base = adminEndpointBase(); // ✅ baza webapp fără ?fn=...
  if (!base) return null;

  const url = `${base}?fn=adminPresence&ttlMin=${PRES_TTL_MIN}&_=${Date.now()}`;

  try{
    const data = await jsonp(url, 20000);
    if (!data || data.ok !== true) return null;
    return data;
  }catch(err){
    console.error("[adminPresence] jsonp failed", err);
    return null;
  }
}





function renderAdminPresence(adminsAll, presence){
  const listEl = document.getElementById('adminPresenceList');
  const hintEl = document.getElementById('adminPresenceHint');
  if (!listEl) return;

  const presList = (presence && Array.isArray(presence.list)) ? presence.list : [];
  const presMap = new Map(presList.map(x => [x.id, x]));

  const merged = adminsAll.map(a => {
    const p = presMap.get(a.id) || null;
    const online = !!(p && p.online);
    const lastSeen = p && p.lastSeen ? p.lastSeen : null;
    return { ...a, online, lastSeen, ageSec: p ? p.ageSec : 999999 };
  });

  // sort: online sus
  merged.sort((x,y) => (x.online===y.online ? x.ageSec-y.ageSec : (x.online?-1:1)));

  const now = Date.now();


 listEl.innerHTML = merged.map(a => `
  <div class="pres-item">
    <div class="pres-left">
      <div class="pres-name">${escapeHtml(a.label)}</div>
      <div class="pres-last">${a.online ? '🟢 Online' : `⚪ ${escapeHtml(fmtAgo(a.ageSec))}`}</div>
    </div>
    <div class="pres-badge ${a.online ? 'pres-on' : 'pres-off'}">
      ${a.online ? 'ACTIV' : 'INACTIV'}
    </div>
  </div>
`).join('');

  const onCount = merged.filter(x => x.online).length;
  hintEl.textContent = `${onCount}/${merged.length} activi`;
}

function adminEndpointBase(){
  const cfg = window.CFG || {};
  // IMPORTANT: adminEventsEndpoint trebuie să fie baza WebApp-ului (fără ?fn=...)
  const raw = cfg.adminEventsEndpoint || cfg.webappUrl || cfg.scriptUrl || '';
  return String(raw || '').replace(/\?.*$/, '').trim();
}

  
async function adminPing(){
  const session = getAdminSession();
  if (!session || !session.user) return;

  // IMPORTANT: id trebuie să fie usernameHash (salvat din index.html)
  const id = session.id || session.userHash;
  if (!id) return;

  const base = adminEndpointBase();
  const url = base + '?fn=adminPing';

  try{
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        id,
        label: session.user,
        ua: navigator.userAgent
      })
    });
  }catch(e){}
}

let presTickBusy = false;

async function initAdminPresence(){
  // 1) ping imediat (dacă e logat)
  await adminPing();

  // 2) refresh listă (admins + presence)
async function tick(){
  if (presTickBusy) return;
  presTickBusy = true;

  try{
    let adminsAll = [];
    let presence  = null;

    try{ adminsAll = await fetchAdminsFromAuth(); }catch(_){}
    try{ presence  = await fetchAdminPresence(); }catch(_){}

    renderAdminPresence(adminsAll, presence);
  } finally {
    presTickBusy = false;
  }
}


  await tick();

  // refresh periodic
  if (presTimerRefresh) clearInterval(presTimerRefresh);
  tick();
  presTimerRefresh = setInterval(tick, PRES_REFRESH_MS);


  // ping periodic
  if (presTimerPing) clearInterval(presTimerPing);
  presTimerPing = setInterval(adminPing, PRES_PING_MS);
}

  
function getSelectLabel(selectEl, value){
  if (!selectEl) return String(value || '');
  const opt = selectEl.querySelector(`option[value="${CSS.escape(String(value))}"]`);
  return opt ? opt.textContent : String(value || '');
}

function saveFilterState(){
  try{
    const payload = {
      range: currentRange || 'today',
      dept: CURRENT_DEPT_FILTER || currentDept || 'all',
      employee: currentEmployee || 'all',
      incompleteOnly: !!filterIncompleteOnly,
      selectedDay: SELECTED_CALENDAR_DAY || null,
      lastEventsRange: lastEventsRange || 'today'
    };
    localStorage.setItem(FILTER_LS_KEY, JSON.stringify(payload));
  }catch(_){}
}

  function loadFilterState(){
  try{
    const raw = localStorage.getItem(FILTER_LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(_){
    return null;
  }
}
  
 
function updateFilterChips(){
  if (!filterChipsEl) return;

  const chips = [];

  // Perioadă
  const rVal = (rangeSelect && rangeSelect.value) || 'today';
  chips.push({ text: 'Perioadă: ' + getSelectLabel(rangeSelect, rVal) });

  // Dept
  const dVal = (deptFilter && deptFilter.value) || 'all';
  chips.push({ text: 'Dept: ' + (dVal !== 'all' ? dVal : 'Toate') });

  // Angajat
  const eVal = (employeeFilter && employeeFilter.value) || 'all';
  chips.push({ text: 'Angajat: ' + (eVal !== 'all' ? eVal : 'Toți') });

  // Zi calendar (removable)
  if (SELECTED_CALENDAR_DAY){
    chips.push({
      text: 'Zi: ' + SELECTED_CALENDAR_DAY,
      removable: true,
      action: 'clear-day'
    });
  }

  // Doar incomplete
  if (filterIncompleteOnly){
    chips.push({ text: 'Doar zile incomplete' });
  }

  // rol
  if (ADMIN_ROLE === 'teamlead' && ADMIN_DEPT){
    chips.push({ text: 'Rol: Teamlead (' + ADMIN_DEPT + ')' });
  }

  filterChipsEl.innerHTML = chips.map(c => {
    if (c.removable){
      return `
        <span class="chip chip-removable">
          <span>${escapeHtml(c.text)}</span>
          <button type="button" class="chip-x" data-action="${c.action}"
                  aria-label="Scoate filtrul de zi">×</button>
        </span>
      `;
    }
    return `<span class="chip">${escapeHtml(c.text)}</span>`;
  }).join('');
}

function resetAllFilters(){
  // zi calendar = null
  SELECTED_CALENDAR_DAY = null;

  // Perioadă = today
  if (rangeSelect){
    rangeSelect.value = 'today';
    rangeSelect.dispatchEvent(new Event('change', { bubbles:true }));
  }

  // Dept = all (sau dept-ul teamlead)
  if (deptFilter){
    const dept = (ADMIN_ROLE === 'teamlead' && ADMIN_DEPT) ? ADMIN_DEPT : 'all';
    deptFilter.value = dept;
    deptFilter.dispatchEvent(new Event('change'));
  }

  // Angajat = all
  if (employeeFilter){
    employeeFilter.value = 'all';
    employeeFilter.dispatchEvent(new Event('change'));
  }

  // incompleteOnly = off
  filterIncompleteOnly = false;
  if (incompleteToggleBtn){
    incompleteToggleBtn.classList.remove('active');
  }

  // search index = gol
  if (employeeSearchInput){
    employeeSearchInput.value = '';
    employeeSearchInput.dispatchEvent(new Event('input', { bubbles:true }));
  }

  // failsafe: forțează refresh o dată
  if (window.__pontajAdminRefresh) window.__pontajAdminRefresh();
}

function triggerOneShotAnim(el, cls){
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart animation
  el.classList.add(cls);
  el.addEventListener('animationend', ()=> el.classList.remove(cls), {once:true});
}

  // --- HELPER pentru calculul stării de azi (pentru alerte LIVE) ---
  function buildTodayStates(allEvents){
    const now = new Date();
    const todayKey = dateKeyFromIso(now.toISOString());
    if (!todayKey) return { byName:new Map(), todayKey:null };

    const todayEvents = (allEvents || []).filter(ev => dateKeyFromIso(ev.ts) === todayKey);
    if (!todayEvents.length) return { byName:new Map(), todayKey };

    todayEvents.sort((a,b)=>new Date(a.ts) - new Date(b.ts));
    const byName = new Map();

    todayEvents.forEach(ev=>{
      if (!ev.name) return;
      if (!byName.has(ev.name)){
        byName.set(ev.name, {
          name: ev.name,
          dept: ev.dept || '',
          hasLongActivity: false,
          firstStartTs: null,
          lastStartTs: null,
          running: false,
          paused: false,
          pauseStartTs: null,
          extraRunning: false,
          extraStartTs: null
        });
      }
      const st = byName.get(ev.name);
      const t = new Date(ev.ts).getTime();
      if (isNaN(t)) return;

      if (ev.dept) st.dept = ev.dept;
      if (ev.activity && ACTIVITATI_NORMA_8H30.indexOf(ev.activity.toLowerCase()) !== -1){
  st.hasLongActivity = true;
}

      if (ev.action === 'start'){
        if (st.firstStartTs == null) st.firstStartTs = t;
        st.lastStartTs = t;
        st.running = true;
        st.paused = false;
        st.pauseStartTs = null;
      } else if (ev.action === 'pause'){
        if (st.running){
          st.paused = true;
          st.pauseStartTs = t;
        }
      } else if (ev.action === 'unpause'){
        if (st.running){
          st.paused = false;
          st.pauseStartTs = null;
        }
      } else if (ev.action === 'finish'){
        // închidem sesiunea curentă
        st.running = false;
        st.paused = false;
        st.pauseStartTs = null;
      } else if (ev.action === 'extra_start'){
        st.extraRunning = true;
        st.extraStartTs = t;
      } else if (ev.action === 'extra_finish'){
        st.extraRunning = false;
        st.extraStartTs = null;
      }
    });

    return { byName, todayKey };
  }

  function registerAlertSlot(key, overdueMs, freqMs, nowMs){
    if (!LIVE_ALERT_STATE[key]){
      LIVE_ALERT_STATE[key] = {
        firstTriggeredAt: nowMs - overdueMs,
        lastSlotIndex: -1
      };
    }
    const slot = Math.floor(overdueMs / freqMs);
    if (slot > LIVE_ALERT_STATE[key].lastSlotIndex){
      LIVE_ALERT_STATE[key].lastSlotIndex = slot;
      return true; // notificare nouă în acest interval
    }
    return false;
  }

  function pushAlertLogCollapsed(key, entry){
    const idx = LIVE_ALERT_LOG.findIndex(e => e.key === key);
    if (idx !== -1){
      const ex = LIVE_ALERT_LOG[idx];
      ex.repeatCount = (ex.repeatCount || 0) + 1;
      ex.ts = entry.ts;
      ex.message = entry.message;
      ex.dept = entry.dept || ex.dept;
      LIVE_ALERT_LOG.splice(idx, 1);
      LIVE_ALERT_LOG.unshift(ex);
    } else {
      LIVE_ALERT_LOG.unshift(Object.assign({ key, repeatCount:0 }, entry));
    }
    if (LIVE_ALERT_LOG.length > ALERT_MAX_LOG){
      LIVE_ALERT_LOG.length = ALERT_MAX_LOG;
    }
  }

  function renderLiveAlertsActive(active){
    if (!liveAlertsActiveEl) return;
    liveAlertsActiveEl.innerHTML = '';

    const q = (ALERTS_FILTER_Q || '').trim().toLowerCase();
    let list = (active || []).slice();

    // dept filter
    if (ALERTS_FILTER_DEPT !== 'all'){
      list = list.filter(x => (x.dept || '') === ALERTS_FILTER_DEPT);
    }

    // text filter (nume sau alert text)
    if (q){
      list = list.filter(x =>
        (x.name || '').toLowerCase().includes(q) ||
        (x.alerts || []).some(a => alertHaystack(a).includes(q))
      );
    }

    // type filter (doar pentru LIVE; dacă e "system", LIVE devine gol)
    if (ALERTS_FILTER_TYPE !== 'all'){
      if (ALERTS_FILTER_TYPE === 'system'){
        list = [];
      } else {
        list = list
          .map(x => Object.assign({}, x, {
            alerts: (x.alerts || []).filter(a => a.type === ALERTS_FILTER_TYPE)
          }))
          .filter(x => x.alerts && x.alerts.length);
      }
    }

    if (!list.length){
      liveAlertsActiveEl.innerHTML =
        '<div class="admin-empty">Nu există alerte active pentru filtrele curente.</div>';
      return;
    }

    list.sort((a,b)=>a.name.localeCompare(b.name,'ro'));

    list.forEach(item=>{
      const row = document.createElement('div');
      row.className = 'admin-list-row clickable';
      row.dataset.name = item.name || '';
      row.dataset.dateKey = dateKeyFromIso(new Date().toISOString()) || '';

      let badgesHtml = '';
      (item.alerts || []).forEach(a=>{
        badgesHtml += '<div><span class="badge badge-warn">' + (a.label || a.type || 'Alertă') + '</span></div>';
        if (a.detail){
          badgesHtml += '<div style="font-size:11px;color:#6b7280;margin-top:2px;">' + a.detail + '</div>';
        }
      });

      row.innerHTML =
        '<div>' +
          '<div class="admin-list-label">' + (item.name || '') + '</div>' +
          '<div class="admin-list-sub">' + (item.dept || '(fără departament)') + '</div>' +
        '</div>' +
        '<div class="admin-list-value">' + badgesHtml + '</div>';

      row.addEventListener('click', function(){
        focusEmployeeAndMaybeDay(item.name, null);
      });

      liveAlertsActiveEl.appendChild(row);
    });
  }


  function renderLiveAlertsHistory(){
    if (!liveAlertsHistoryBodyEl) return;
    liveAlertsHistoryBodyEl.innerHTML = '';

    const q = (ALERTS_FILTER_Q || '').trim().toLowerCase();

    let list = (LIVE_ALERT_LOG || []).slice();

    // type filter
    if (ALERTS_FILTER_TYPE !== 'all'){
      if (ALERTS_FILTER_TYPE === 'system'){
        list = [];
      } else {
        list = list.filter(e => e.type === ALERTS_FILTER_TYPE);
      }
    }

    // dept filter
    if (ALERTS_FILTER_DEPT !== 'all'){
      list = list.filter(e => (e.dept || '') === ALERTS_FILTER_DEPT);
    }

    // text filter
    if (q){
      list = list.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.message || '').toLowerCase().includes(q)
      );
    }

    if (!list.length){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Nu există notificări pentru filtrele curente.';
      tr.appendChild(td);
      liveAlertsHistoryBodyEl.appendChild(tr);
      return;
    }

    list.forEach(entry=>{
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.name = entry.name || '';
      tr.dataset.dateKey = entry.ts ? (dateKeyFromIso(entry.ts) || '') : '';

      let typeLabel = '';
      if (entry.type === 'pause') typeLabel = 'Pauză';
      else if (entry.type === 'norm') typeLabel = 'Normă';
      else if (entry.type === 'extra') typeLabel = 'Extra';
      else typeLabel = entry.type || '-';

      const rep = entry.repeatCount ? ` (repetată de ${entry.repeatCount} ori)` : '';

      tr.innerHTML =
        '<td>' + fmtDateTime(entry.ts) + '</td>' +
        '<td>' + (entry.name || '') + '</td>' +
        '<td>' + (entry.dept || '') + '</td>' +
        '<td>' + typeLabel + '</td>' +
        '<td>' + (entry.message || '') + rep + '</td>';

      liveAlertsHistoryBodyEl.appendChild(tr);
    });
  }

  function scanAndUpdateLiveAlerts(){
    const allEvents = window.__pontajAdminEvents || [];
    const nowMs = Date.now();
    const { byName } = buildTodayStates(allEvents);
    const active = [];

    byName.forEach(st=>{
      const dept = st.dept || '';
      const alertsForThis = [];

      // Pauză > limită fără UNPAUSE
      if (st.paused && st.pauseStartTs){
        const thresholdMs = getPauseMarginMsFor(st.name, dept);
        const elapsed = nowMs - st.pauseStartTs;
        if (elapsed > thresholdMs){
          const key = st.name + '|pause';
          const freq = 15 * 60 * 1000; // la 15 minute
          const overdueMs = elapsed - thresholdMs;
          const newNotif = registerAlertSlot(key, overdueMs, freq, nowMs);
          const baseMinutes = Math.round(thresholdMs / 60000);
          const overMin = Math.round(elapsed / 60000);
          if (newNotif){
            pushAlertLogCollapsed(key,{
              ts:new Date(nowMs).toISOString(),
              name:st.name,
              dept,
              type:'pause',
              message:'Pauză mai mare de ' + baseMinutes + ' min (în pauză de ' + overMin + ' min, fără UNPAUSE).'
            });
          }
          alertsForThis.push({
            type:'pause',
            label:'Pauză > ' + baseMinutes + ' min',
            detail:'În pauză de ' + overMin + ' min fără UNPAUSE.'
          });
        }
      }

      // Normă depășită (în funcție de normă configurată) fără FINISH
      if ((st.running || st.paused) && st.firstStartTs){
        const normMs = getNormMsFor(st.name, dept, st.hasLongActivity);
        const elapsedNorm = nowMs - st.firstStartTs;
        if (elapsedNorm > normMs){
          const key = st.name + '|norm';
          const freq = 30 * 60 * 1000; // din 30 în 30 de minute
          const overdueMs = elapsedNorm - normMs;
          const newNotif = registerAlertSlot(key, overdueMs, freq, nowMs);
          const baseHours = (normMs/3600000).toFixed(1).replace('.', ',');
          const elapsedHours = (elapsedNorm/3600000).toFixed(2).replace('.', ',');
          if (newNotif){
            pushAlertLogCollapsed(key,{
              ts:new Date(nowMs).toISOString(),
              name:st.name,
              dept,
              type:'norm',
              message:'Normă depășită (' + elapsedHours + 'h de la primul START, peste ' + baseHours + 'h, fără FINISH).'
            });
          }
          alertsForThis.push({
            type:'norm',
            label:'Normă depășită',
            detail:'Peste ' + baseHours + 'h fără FINISH (acum ~' + elapsedHours + 'h).'
          });
        }
      }

      // EXTRA în curs > 30 min
      if (st.extraRunning && st.extraStartTs){
        const thresholdMs = 30 * 60 * 1000;
        const elapsedExtra = nowMs - st.extraStartTs;
        if (elapsedExtra > thresholdMs){
          const key = st.name + '|extra';
          const freq = 15 * 60 * 1000; // la 15 minute
          const overdueMs = elapsedExtra - thresholdMs;
          const newNotif = registerAlertSlot(key, overdueMs, freq, nowMs);
          const overMin = Math.round(elapsedExtra / 60000);
          if (newNotif){
            pushAlertLogCollapsed(key,{
              ts:new Date(nowMs).toISOString(),
              name:st.name,
              dept,
              type:'extra',
              message:'Sesiune EXTRA peste 30 min (în curs de ' + overMin + ' min).'
            });
          }
          alertsForThis.push({
            type:'extra',
            label:'EXTRA > 30 min',
            detail:'Sesiune EXTRA în curs de ' + overMin + ' min.'
          });
        }
      }

      if (alertsForThis.length){
        active.push({
          name:st.name,
          dept,
          alerts:alertsForThis
        });
      }
    });
    LAST_LIVE_ACTIVE = active.slice();
    renderLiveAlertsActive(active);
    renderLiveAlertsHistory();
  }

async function init(){
  try{
    CFG = await loadConfig();
    window.CFG = CFG; 
    applyNormSettingsFromConfig(CFG);
    applySelfServiceConfig(CFG);

    initAdminPresence().catch(()=>{}); // ✅ AICI (foarte important)

      
      const base = adminEndpointBase();
      const adminUrl = base + '?fn=adminEvents&v=' + Date.now();

      const r2  = await fetch(adminUrl, { cache:'no-store' });
      const txt = await r2.text();
      let data;
      try { data = JSON.parse(txt); } catch(e){ throw new Error('Răspuns invalid de la adminEventsEndpoint.'); }
      if (!data || !data.ok || !Array.isArray(data.events)){
        throw new Error('adminEventsEndpoint nu a întors un obiect ok cu events[].');
      }

      const meta = data.meta || null;
      window.__pontajAdminMeta = meta || null;

      let leavesData = null;
      if (CFG.leaveEndpoint){
        try{
          const leaveUrl = CFG.leaveEndpoint + '?fn=adminLeave&v=' + Date.now();
          const lr = await fetch(leaveUrl, {cache:'no-store'});
          const ltxt = await lr.text();
          let ljson = null;
          try{ ljson = JSON.parse(ltxt); }catch(e){}
          if (ljson && ljson.ok && Array.isArray(ljson.leaves)){
            leavesData = ljson.leaves;
          }
        }catch(err){
          // endpoint de concedii admin este opțional
        }
      }
      if (leavesData){
        buildLeaveIndex(leavesData);
      } else {
        buildLeaveIndex([]);
      }

      let events = data.events.map(ev => ({
        ts: ev.ts,
        name: ev.name || '',
        action: _normAction(ev.action),
        dept: ev.dept || '',
        activity: ev.activity || '',
        location: ev.location || ''
      })).filter(ev => ev.ts);

      window.__pontajAdminEvents = events;

      if (loadingEl)  loadingEl.style.display = 'none';
      if (dashboardEl) dashboardEl.style.display = '';

      if (lastUpdateEl){
        let stamp = new Date();
        if (meta && meta.generatedAt){
          const dMeta = new Date(meta.generatedAt);
          if (!isNaN(dMeta.getTime())) {
            stamp = dMeta;
          }
        }
        showLastUpdate(stamp);
      }


      ALL_STATS = buildStatsFromEvents(events);
      renderTopEmployees(ALL_STATS);

      if (topModeHoursBtn && topModeAnomaliesBtn){
        topModeHoursBtn.addEventListener('click', function(){
          TOP_MODE = 'hours';
          topModeHoursBtn.classList.add('active');
          topModeAnomaliesBtn.classList.remove('active');
          renderTopEmployees(ALL_STATS);
        });
        topModeAnomaliesBtn.addEventListener('click', function(){
          TOP_MODE = 'anomalies';
          topModeAnomaliesBtn.classList.add('active');
          topModeHoursBtn.classList.remove('active');
          renderTopEmployees(ALL_STATS);
        });
      }

      currentRange    = rangeSelect ? rangeSelect.value : 'today';
      currentDept     = 'all';
      currentEmployee = 'all';
      let latestFiltered  = [];

      buildDeptFilter(events);
      buildEmployeeFilter(events, currentDept);
      applyRoleVisibility();
      initCollapsibleCards();
      syncAlertsDeptFilter();
      const saved = loadFilterState();
if (saved){
  // range
  if (rangeSelect && saved.range) rangeSelect.value = saved.range;

  // dept (respectă teamlead lock)

  if (deptFilter){
  const lockedDept = (ADMIN_ROLE === 'teamlead' && ADMIN_DEPT) ? ADMIN_DEPT : null;
  deptFilter.value = lockedDept || saved.dept || 'all';
  if (!deptFilter.value) deptFilter.value = lockedDept || 'all';
  currentDept = deptFilter.value;
  CURRENT_DEPT_FILTER = currentDept;
}

  // rebuild employee dropdown după dept
  buildEmployeeFilter(events, currentDept);

  // employee
  if (employeeFilter && saved.employee){
    ensureEmployeeOption(saved.employee);
    employeeFilter.value = saved.employee;
    currentEmployee = employeeFilter.value;
    SELECTED_EMPLOYEE = (currentEmployee !== 'all') ? currentEmployee : null;
  }

  // incompleteOnly
  filterIncompleteOnly = !!saved.incompleteOnly;
  if (incompleteToggleBtn) incompleteToggleBtn.classList.toggle('active', filterIncompleteOnly);

  // selected day
  SELECTED_CALENDAR_DAY = saved.selectedDay || null;

  // last events range
  lastEventsRange = saved.lastEventsRange || 'today';
  if (lastEventsRangeSelect) lastEventsRangeSelect.value = lastEventsRange;
}

      
      renderEmployeeIndex(ALL_STATS, CURRENT_DEPT_FILTER, EMPLOYEE_SEARCH_TEXT);
      renderEmployeeDetails(null);

    async function reloadAdminData(){
  const CFG = await loadConfig();

  // refetch admin events
  const base = adminEndpointBase();
  const adminUrl = base + '?fn=adminEvents&v=' + Date.now();

  const r2  = await fetch(adminUrl, { cache:'no-store' });
  const txt = await r2.text();
  let data;
  try { data = JSON.parse(txt); } catch(e){ throw new Error('Răspuns invalid de la adminEventsEndpoint.'); }
  if (!data || !data.ok || !Array.isArray(data.events)){
    throw new Error('adminEventsEndpoint nu a întors un obiect ok cu events[].');
  }

  window.__pontajAdminMeta = data.meta || null;

  // leaves (opțional)
  let leavesData = null;
  if (CFG.leaveEndpoint){
    try{
      const leaveUrl = CFG.leaveEndpoint + '?fn=adminLeave&v=' + Date.now();
      const lr = await fetch(leaveUrl, {cache:'no-store'});
      const ltxt = await lr.text();
      let ljson = null;
      try{ ljson = JSON.parse(ltxt); }catch(e){}
      if (ljson && ljson.ok && Array.isArray(ljson.leaves)) leavesData = ljson.leaves;
    }catch(_){}
  }
  buildLeaveIndex(leavesData || []);

  events = data.events.map(ev => ({
    ts: ev.ts,
    name: ev.name || '',
    action: _normAction(ev.action),
    dept: ev.dept || '',
    activity: ev.activity || '',
    location: ev.location || ''
  })).filter(ev => ev.ts);

  window.__pontajAdminEvents = events;

  // update stamp
    if (lastUpdateEl){
    let stamp = new Date();
    if (window.__pontajAdminMeta && window.__pontajAdminMeta.generatedAt){
      const dMeta = new Date(window.__pontajAdminMeta.generatedAt);
      if (!isNaN(dMeta.getTime())) stamp = dMeta;
    }
    showLastUpdate(stamp);
  }

  // rebuild stats + UI
  ALL_STATS = buildStatsFromEvents(events);
  buildDeptFilter(events);
  buildEmployeeFilter(events, currentDept);

  renderTopEmployees(ALL_STATS);
  renderEmployeeIndex(ALL_STATS, CURRENT_DEPT_FILTER, EMPLOYEE_SEARCH_TEXT);
  renderEmployeeDetails(SELECTED_EMPLOYEE);

  refresh();
}

if (adminRefreshBtn){
  adminRefreshBtn.addEventListener('click', async function(){
    adminRefreshBtn.disabled = true;
    adminRefreshBtn.classList.add('is-loading');
    triggerOneShotAnim(adminRefreshBtn, 'do-flip');

    try{
      await reloadAdminData();
    }catch(err){
      showError(err && err.message ? err.message : String(err));
    }finally{
      adminRefreshBtn.classList.remove('is-loading');
      adminRefreshBtn.disabled = false;
    }
  });
}

 if (resetFiltersBtn && !resetFiltersBtn.dataset.bound){
  resetFiltersBtn.dataset.bound = '1';
  resetFiltersBtn.addEventListener('click', function(){
    triggerOneShotAnim(resetFiltersBtn, 'do-sweep');
    resetAllFilters();
  });
}
    
      function setSelectedCalendarDay(dateKey){
        if (SELECTED_CALENDAR_DAY === dateKey){
          SELECTED_CALENDAR_DAY = null;
        } else {
          SELECTED_CALENDAR_DAY = dateKey;
        }
        refresh();
      }

function renderPresenceCalendarMonthly(){
  if (!presenceCalendarEl) return;
  presenceCalendarEl.innerHTML = '';

  const monthNames = ['Ianuarie','Februarie','Martie','Aprilie','Mai','Iunie','Iulie','August','Septembrie','Octombrie','Noiembrie','Decembrie'];
  if (calendarMonthLabelEl){
    calendarMonthLabelEl.textContent = monthNames[CALENDAR_MONTH] + ' ' + CALENDAR_YEAR;
  }

  const baseForCalendar = applyDeptEmployee(events, currentDept, currentEmployee);

  const firstDay = new Date(CALENDAR_YEAR, CALENDAR_MONTH, 1);
  const lastDay  = new Date(CALENDAR_YEAR, CALENDAR_MONTH + 1, 0);
  const monthStart = new Date(CALENDAR_YEAR, CALENDAR_MONTH, 1, 0,0,0,0);
  const monthEnd   = new Date(CALENDAR_YEAR, CALENDAR_MONTH, lastDay.getDate(), 23,59,59,999);

  const filtered = (baseForCalendar || []).filter(ev=>{
    if (!ev.ts) return false;
    const t = new Date(ev.ts);
    if (isNaN(t.getTime())) return false;
    return t >= monthStart && t <= monthEnd;
  });

  const statsMonth = buildStatsFromEvents(filtered);
  const perDay = (statsMonth && statsMonth.perDay) ? statsMonth.perDay : new Map();

  const todayKey = dateKeyFromIso(new Date().toISOString());

  const headers = ['Lu','Ma','Mi','Jo','Vi','Sâ','Du'];
  headers.forEach(h=>{
    const el = document.createElement('div');
    el.className = 'calendar-day calendar-day-header';
    el.textContent = h;
    presenceCalendarEl.appendChild(el);
  });

  const firstWeekday = (firstDay.getDay() + 6) % 7;
  for (let i=0;i<firstWeekday;i++){
    const empty = document.createElement('div');
    empty.className = 'calendar-day calendar-day-empty';
    empty.innerHTML = '&nbsp;';
    presenceCalendarEl.appendChild(empty);
  }

  function namesList(set){
    const arr = Array.from(set || []).sort((a,b)=>a.localeCompare(b,'ro'));
    if (!arr.length) return '—';
    const max = 12;
    const shown = arr.slice(0,max);
    return shown.join(', ') + (arr.length > max ? ' …' : '');
  }

  const rosterForCalendar = getRosterFiltered();
  const rosterNames = rosterForCalendar.map(x=>x.name);

  for (let dayNum=1; dayNum<=lastDay.getDate(); dayNum++){
    const d = new Date(CALENDAR_YEAR, CALENDAR_MONTH, dayNum);
    const dk = dateKeyFromIso(d.toISOString());

    const summary = perDay.get(dk);
    const startedSet   = summary && summary.started   ? summary.started   : new Set();
    const completedSet = summary && summary.completed ? summary.completed : new Set();

    const started   = startedSet.size;
    const completed = completedSet.size;
    const pct = started ? Math.round(100 * completed / started) : 0;

    let cls = 'calendar-day ';
    if (!started) cls += 'calendar-day-nodata';
    else if (pct < 50) cls += 'calendar-day-low';
    else if (pct < 90) cls += 'calendar-day-med';
    else cls += 'calendar-day-high';

    if (dk === todayKey) cls += ' calendar-day-today';
    if (isWeekend(dk)) cls += ' calendar-day-weekend';
    if (SELECTED_CALENDAR_DAY && dk === SELECTED_CALENDAR_DAY) cls += ' calendar-day-selected';

    const leaveSet = (LEAVE_BY_DAY && LEAVE_BY_DAY.get(dk)) ? LEAVE_BY_DAY.get(dk) : null;
    const leaveCount = leaveSet ? leaveSet.size : 0;

    const inactiveSet = new Set(
    rosterNames.filter(n => !startedSet.has(n) && !(leaveSet && leaveSet.has(n)))
    );

    
    const cell = document.createElement('div');
    cell.className = cls;
    cell.dataset.dateKey = dk;

    const metaLine = started ? `${completed}/${started} complet` : 'fără pontaj';

    cell.innerHTML =
      `<span class="calendar-day-label">${dayNum}</span>` +
      `<span class="calendar-day-meta">${metaLine}${leaveCount ? ` • concediu ${leaveCount}` : ''}</span>` +
      `<div class="calendar-tooltip">` +
        `<div><b>${dk}</b></div>` +
        `<div><b>Cu START:</b> ${started} • <b>Complet:</b> ${completed}${started ? ` • ${pct}%` : ''}</div>` +
        `<div class="muted"><b>Angajați (START):</b> ${namesList(startedSet)}</div>` +
        (completed ? `<div class="muted"><b>Complet (FINISH):</b> ${namesList(completedSet)}</div>` : '') +
        (leaveCount ? `<div class="muted"><b>Concediu:</b> ${namesList(leaveSet)}</div>` : '') +
        (inactiveSet.size ? `<div class="muted"><b>Inactivi:</b> ${namesList(inactiveSet)}</div>` : '')+
      `</div>`;

    cell.addEventListener('click', function(){
      setSelectedCalendarDay(dk);
    });

    presenceCalendarEl.appendChild(cell);
  }
}

      function applyRoleVisibility(){
        const role = ADMIN_ROLE || 'admin';

        if (role === 'viewer'){
          if (exportCsvBtn) exportCsvBtn.style.display = 'none';
          if (pdfBtn) pdfBtn.style.display = 'none';
          if (deptPdfBtn) deptPdfBtn.style.display = 'none';
          if (employeeExportBtn) employeeExportBtn.style.display = 'none';
          if (payrollExportBtn) payrollExportBtn.style.display = 'none';
        }

        if (role === 'teamlead' && ADMIN_DEPT && deptFilter){
          deptFilter.value = ADMIN_DEPT;
          deptFilter.disabled = true;
          currentDept = ADMIN_DEPT;
          CURRENT_DEPT_FILTER = ADMIN_DEPT;
        }
      }

            function initCollapsibleCards(){
        const cards = document.querySelectorAll('.admin-card.collapsible');
        cards.forEach(card=>{
          if (card.dataset.collapsibleBound === '1') return;
          card.dataset.collapsibleBound = '1';
          const title = card.querySelector('.admin-card-title');
          if (!title) return;
          title.addEventListener('click', function(){
            card.classList.toggle('expanded');
          });
        });
      }
      
      function refresh(){
      let baseAll   = applyDeptEmployee(events, currentDept, currentEmployee);
        // --- KPI "Norme complete (azi)" --- 
  if (kpiCompletedTodayEl){
    if (currentRange === 'today' && !SELECTED_CALENDAR_DAY) {  // doar când perioada este "Astăzi"
      const todayKey = dateKeyFromIso(new Date().toISOString());
      let statsToday = null;

      if (todayKey){
        const todayEvents = baseAll.filter(ev => dateKeyFromIso(ev.ts) === todayKey);
        statsToday = buildStatsFromEvents(todayEvents);
      }

      updateCompletedTodayKpiFromStats(statsToday);
    } else {
      // dacă nu e "Astăzi" la perioadă, nu are sens KPI-ul "azi"
      kpiCompletedTodayEl.textContent = '–';
    }
  }

      let baseRange = filterByRange(baseAll, currentRange || 'today');

if (SELECTED_CALENDAR_DAY){
  // IMPORTANT: ignoră “Perioadă” când ai selectat o zi din calendar
  baseRange = baseAll.filter(ev => dateKeyFromIso(ev.ts) === SELECTED_CALENDAR_DAY);
}

         
        const statsBase = buildStatsFromEvents(baseRange);
        let filteredForMain = applyIncompleteFilter(baseRange, statsBase);
        latestFiltered = filteredForMain;

        renderKpis(filteredForMain);
        renderDept(filteredForMain);
        renderRawLog(filteredForMain);

      
        renderDailyPresence(statsBase);
        renderIncompleteDays(baseRange);
        renderAnomalies(baseRange);

        let lastBase   = applyDeptEmployee(events, currentDept, currentEmployee);
        let lastByRange= filterLastEventsByRange(lastBase, lastEventsRange || 'today');
        if (SELECTED_CALENDAR_DAY){
          lastByRange = lastByRange.filter(ev => dateKeyFromIso(ev.ts) === SELECTED_CALENDAR_DAY);
        }
        const statsLast = buildStatsFromEvents(lastByRange);
        let lastFinal = applyIncompleteFilter(lastByRange, statsLast);
        renderLastEvents(lastFinal);

        if (lastEventsTitleEl && lastEventsHintTextEl && rawLogTitleEl){
          let baseHint = filterIncompleteOnly
            ? 'Toate înregistrările din zilele incomplete pentru perioada aleasă și filtrul curent.'
            : 'Toate înregistrările din perioada aleasă, după filtrele de mai sus.';
          if (SELECTED_CALENDAR_DAY){
            baseHint += ' (Filtrat pe ziua ' + SELECTED_CALENDAR_DAY + ' din calendar.)';
          }
          lastEventsHintTextEl.textContent = baseHint;

          if (filterIncompleteOnly){
            lastEventsTitleEl.textContent = 'Ultimele pontaje (doar zile incomplete)';
            rawLogTitleEl.textContent = 'Log brut (doar zile incomplete)';
          } else {
            lastEventsTitleEl.textContent = 'Ultimele pontaje';
            rawLogTitleEl.textContent = 'Log brut (filtru curent)';
          }
        }

      

        
        renderPresenceCalendarMonthly();
        renderSelectedCalendarDayDetails();
        renderLiveBoard();
        renderAlertsFromMeta();
        renderSystemAlertsHistory();
        updateFilterChips();
        saveFilterState();
      }
      
if (calPrevBtn && !calPrevBtn.dataset.bound){
  calPrevBtn.dataset.bound = '1';
  calPrevBtn.addEventListener('click', function(){
    CALENDAR_MONTH--;
    if (CALENDAR_MONTH < 0){ CALENDAR_MONTH = 11; CALENDAR_YEAR--; }
    SELECTED_CALENDAR_DAY = null;
    refresh();
  });
}
if (calNextBtn && !calNextBtn.dataset.bound){
  calNextBtn.dataset.bound = '1';
  calNextBtn.addEventListener('click', function(){
    CALENDAR_MONTH++;
    if (CALENDAR_MONTH > 11){ CALENDAR_MONTH = 0; CALENDAR_YEAR++; }
    SELECTED_CALENDAR_DAY = null;
    refresh();
  });
}

if (incompleteDayAllBtn && !incompleteDayAllBtn.dataset.bound) {
  incompleteDayAllBtn.dataset.bound = '1';
  incompleteDayAllBtn.addEventListener('click', () => {
    INCOMPLETE_DAY_FILTER = 'all';
    incompleteDayAllBtn.classList.add('active');
    incompleteDayWeekendBtn.classList.remove('active');
    incompleteDayWorkBtn.classList.remove('active');
    refresh();
  });
}
if (incompleteDayWeekendBtn && !incompleteDayWeekendBtn.dataset.bound) {
  incompleteDayWeekendBtn.dataset.bound = '1';
  incompleteDayWeekendBtn.addEventListener('click', () => {
    INCOMPLETE_DAY_FILTER = 'weekend';
    incompleteDayWeekendBtn.classList.add('active');
    incompleteDayAllBtn.classList.remove('active');
    incompleteDayWorkBtn.classList.remove('active');
    refresh();
  });
}
if (incompleteDayWorkBtn && !incompleteDayWorkBtn.dataset.bound) {
  incompleteDayWorkBtn.dataset.bound = '1';
  incompleteDayWorkBtn.addEventListener('click', () => {
    INCOMPLETE_DAY_FILTER = 'workday';
    incompleteDayWorkBtn.classList.add('active');
    incompleteDayAllBtn.classList.remove('active');
    refresh();
  });
}
// Filtre pentru ANOMALII: toate / weekend / zile lucrătoare
if (anomalyDayAllBtn && !anomalyDayAllBtn.dataset.bound) {
  anomalyDayAllBtn.dataset.bound = '1';
  anomalyDayAllBtn.addEventListener('click', () => {
    ANOMALY_DAY_FILTER = 'all';
    anomalyDayAllBtn.classList.add('active');
    anomalyDayWeekendBtn.classList.remove('active');
    anomalyDayWorkBtn.classList.remove('active');
    refresh();
  });
}

if (anomalyDayWeekendBtn && !anomalyDayWeekendBtn.dataset.bound) {
  anomalyDayWeekendBtn.dataset.bound = '1';
  anomalyDayWeekendBtn.addEventListener('click', () => {
    ANOMALY_DAY_FILTER = 'weekend';
    anomalyDayWeekendBtn.classList.add('active');
    anomalyDayAllBtn.classList.remove('active');
    anomalyDayWorkBtn.classList.remove('active');
    refresh();
  });
}

if (anomalyDayWorkBtn && !anomalyDayWorkBtn.dataset.bound) {
  anomalyDayWorkBtn.dataset.bound = '1';
  anomalyDayWorkBtn.addEventListener('click', () => {
    ANOMALY_DAY_FILTER = 'workday';
    anomalyDayWorkBtn.classList.add('active');
    anomalyDayAllBtn.classList.remove('active');
    anomalyDayWeekendBtn.classList.remove('active');
    refresh();
  });
}
window.__pontajAdminRefresh = refresh;

      // ✅ START LIVE ALERTS (o singură dată la încărcare)
scanAndUpdateLiveAlerts();

if (LIVE_ALERT_TIMER) clearInterval(LIVE_ALERT_TIMER);
LIVE_ALERT_TIMER = setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  scanAndUpdateLiveAlerts();
}, 60 * 1000);

      
function renderSelectedCalendarDayDetails(){
  if (!calendarDayDetailsEl || !calendarInactiveListEl || !calendarSelectedDayLabelEl) return;

  if (!SELECTED_CALENDAR_DAY){
    calendarDayDetailsEl.style.display = 'none';
    return;
  }

  calendarDayDetailsEl.style.display = '';
  calendarSelectedDayLabelEl.textContent = SELECTED_CALENDAR_DAY;

  const roster = getRosterFiltered();
  const base = applyDeptEmployee(events, currentDept, currentEmployee);

  const dayEvents = base.filter(ev => dateKeyFromIso(ev.ts) === SELECTED_CALENDAR_DAY);
  const stats = buildStatsFromEvents(dayEvents);
  const summary = stats && stats.perDay ? stats.perDay.get(SELECTED_CALENDAR_DAY) : null;
  const startedSet = summary && summary.started ? summary.started : new Set();

  const leaveSet = (LEAVE_BY_DAY && LEAVE_BY_DAY.get(SELECTED_CALENDAR_DAY)) ? LEAVE_BY_DAY.get(SELECTED_CALENDAR_DAY) : new Set();

  const inactive = roster.filter(x => !startedSet.has(x.name) && !(leaveSet && leaveSet.has(x.name)));

  calendarInactiveListEl.innerHTML = '';
  if (!inactive.length){
    calendarInactiveListEl.innerHTML = '<div class="admin-empty">Nimeni inactiv pentru filtrele curente.</div>';
    return;
  }

  inactive.forEach(x=>{
    const row = document.createElement('div');
    row.className = 'admin-list-row clickable';
    row.dataset.empName = x.name;

    row.innerHTML =
      '<div>' +
        '<div class="admin-list-label">' + x.name + '</div>' +
        '<div class="admin-list-sub">' + (x.dept || '(fără departament)') + '</div>' +
      '</div>' +
      '<div class="admin-list-value"><span class="badge badge-warn">Fără pontaj</span></div>';

    row.addEventListener('click', function(){
      focusEmployeeAndMaybeDay(x.name, SELECTED_CALENDAR_DAY);
    });

    calendarInactiveListEl.appendChild(row);
  });
}
      
      
      function handleDayRowClick(tr){
        if (!tr || !tr.dataset || !tr.dataset.name || !tr.dataset.dateKey) return;
        const name = tr.dataset.name;
        const dk   = tr.dataset.dateKey;

        SELECTED_EMPLOYEE     = name;
        SELECTED_CALENDAR_DAY = dk;

        if (employeeFilter){
          if (!employeeFilter.querySelector('option[value="'+name+'"]')){
            const o = document.createElement('option');
            o.value = name;
            o.textContent = name;
            employeeFilter.appendChild(o);
          }
          employeeFilter.value = name;
        }

        currentEmployee = name;

        markSelectedEmployee(name);
        renderEmployeeDetails(name);
        refresh();

        if (employeeDetailsBodyEl && employeeDetailsBodyEl.scrollIntoView){
          employeeDetailsBodyEl.scrollIntoView({behavior:'smooth', block:'start'});
        }
      }

      if (rangeSelect){
        rangeSelect.addEventListener('change', function(){
          currentRange = rangeSelect.value || 'today';
          refresh();
        });
      }
      if (deptFilter){
        deptFilter.addEventListener('change', function(){
          currentDept = deptFilter.value || 'all';
          CURRENT_DEPT_FILTER = currentDept;
          buildEmployeeFilter(events, currentDept);
          if (currentEmployee !== 'all' && employeeFilter){
            if (!employeeFilter.querySelector('option[value="'+currentEmployee+'"]')){
              const o = document.createElement('option');
              o.value = currentEmployee;
              o.textContent = currentEmployee;
              employeeFilter.appendChild(o);
            }
            employeeFilter.value = currentEmployee;
          }
          renderEmployeeIndex(ALL_STATS, CURRENT_DEPT_FILTER, EMPLOYEE_SEARCH_TEXT);
          renderEmployeeDetails(SELECTED_EMPLOYEE);
          refresh();
        });
      }
      if (employeeFilter){
        employeeFilter.addEventListener('change', function(){
          currentEmployee = employeeFilter.value || 'all';
          if (currentEmployee === 'all'){
            SELECTED_EMPLOYEE = null;
            renderEmployeeDetails(null);
          } else {
            SELECTED_EMPLOYEE = currentEmployee;
            markSelectedEmployee(SELECTED_EMPLOYEE);
            renderEmployeeDetails(SELECTED_EMPLOYEE);
          }
          refresh();
        });
      }
          if (incompleteToggleBtn){
        incompleteToggleBtn.addEventListener('click', function(){
          filterIncompleteOnly = !filterIncompleteOnly;
          incompleteToggleBtn.classList.toggle('active', filterIncompleteOnly);
          refresh();
        });
      }
      if (lastEventsRangeSelect){
        lastEventsRangeSelect.addEventListener('change', function(){
          lastEventsRange = lastEventsRangeSelect.value || 'today';
          refresh();
        });
      }

      if (employeeSearchInput){
        employeeSearchInput.addEventListener('input', function(){
          EMPLOYEE_SEARCH_TEXT = (employeeSearchInput.value || '').trim();
          renderEmployeeIndex(ALL_STATS, CURRENT_DEPT_FILTER, EMPLOYEE_SEARCH_TEXT);
          if (SELECTED_EMPLOYEE){
            markSelectedEmployee(SELECTED_EMPLOYEE);
          }
        });
      }

    
      if (incompleteDaysBodyEl){
        incompleteDaysBodyEl.addEventListener('click', function(e){
          const tr = e.target.closest('tr');
          handleDayRowClick(tr);
        });
      }

      if (anomaliesBodyEl){
        anomaliesBodyEl.addEventListener('click', function(e){
          const tr = e.target.closest('tr');
          handleDayRowClick(tr);
        });
      }

      // ✅ Click pe rândurile din "Istoric LIVE"
if (liveAlertsHistoryBodyEl && !liveAlertsHistoryBodyEl.dataset.boundClick){
  liveAlertsHistoryBodyEl.dataset.boundClick = '1';
  liveAlertsHistoryBodyEl.addEventListener('click', function(e){
    const tr = e.target.closest('tr');
    if (!tr) return;
    const name = tr.dataset.name || '';
    const dk   = tr.dataset.dateKey || null;
    if (!name) return;
    focusEmployeeAndMaybeDay(name, dk);
  });
}

// ✅ Click pe rândurile din "Alerte istorice din sistem"
if (systemAlertsHistoryBodyEl && !systemAlertsHistoryBodyEl.dataset.boundClick){
  systemAlertsHistoryBodyEl.dataset.boundClick = '1';
  systemAlertsHistoryBodyEl.addEventListener('click', function(e){
    const tr = e.target.closest('tr');
    if (!tr) return;
    const name = tr.dataset.name || '';
    const dk   = tr.dataset.dateKey || null;
    if (!name) return;
    focusEmployeeAndMaybeDay(name, dk);
  });
}


      
      if (exportCsvBtn){
        exportCsvBtn.addEventListener('click', function(){
          exportCsv(latestFiltered);
        });
      }

      if (exportIncompleteBtn){
  exportIncompleteBtn.addEventListener('click', function(){
    const header = ['Data','Nume','Departament','Norma','Extra','Concediu','Stare'];
    const rows = (LATEST_INCOMPLETE_ROWS || []).map(x => [
      x.dateKey, x.name, x.dept, x.work, x.extra, x.leave, x.status
    ]);
    exportCsvGeneric('pontaj-zile-incomplete.csv', header, rows);
  });
}

if (exportAnomaliesBtn){
  exportAnomaliesBtn.addEventListener('click', function(){
    const header = ['Data','Nume','Departament','Norma','Extra','Concediu','Detalii'];
    const rows = (LATEST_ANOMALY_ROWS || []).map(x => [
      x.dateKey, x.name, x.dept, x.work, x.extra, x.leave, x.reasons
    ]);
    exportCsvGeneric('pontaj-anomalii.csv', header, rows);
  });
}

      if (pdfBtn){
        pdfBtn.addEventListener('click', async function(){
          if (!SELECTED_EMPLOYEE){
            alert('Selectează mai întâi un angajat din Index sau din filtrul de angajați.');
            return;
          }
          try{
            const cfg = await loadConfig();
            if (!cfg.adminEventsEndpoint) throw new Error('Lipsește adminEventsEndpoint.');
            const url = cfg.adminEventsEndpoint +
              '?fn=adminPdf&name=' + encodeURIComponent(SELECTED_EMPLOYEE) +
              '&v=' + Date.now();
            window.open(url, '_blank');
          }catch(err){
            alert('Eroare configurare PDF: ' + (err && err.message ? err.message : err));
          }
        });
      }

      if (deptPdfBtn){
        deptPdfBtn.addEventListener('click', async function(){
          let dept = CURRENT_DEPT_FILTER && CURRENT_DEPT_FILTER !== 'all'
            ? CURRENT_DEPT_FILTER
            : '';
          if (!dept){
            const listOpts = Array.from(deptFilter ? deptFilter.options : [])
              .map(o => o.value)
              .filter(v => v && v !== 'all');
            const suggestion = listOpts.length ? listOpts[0] : '';
            const input = prompt('Introdu numele departamentului pentru raport (exact cum apare în filtrul de departamente):', suggestion);
            dept = input ? input.trim() : '';
          }
          if (!dept){
            alert('Nu a fost ales niciun departament.');
            return;
          }
          try{
            const cfg = await loadConfig();
            if (!cfg.adminEventsEndpoint) throw new Error('Lipsește adminEventsEndpoint.');
            const url = cfg.adminEventsEndpoint +
              '?fn=adminPdfDept&dept=' + encodeURIComponent(dept) +
              '&v=' + Date.now();
            const r   = await fetch(url, {cache:'no-store'});
            const resp= await r.json();
            if (!resp.ok || !resp.url){
              throw new Error(resp.error || 'Nu am primit un URL de raport.');
            }
            window.open(resp.url, '_blank');
          }catch(err){
            alert('Eroare la generarea raportului departamental: ' + (err.message || err));
          }
        });
      }

      if (employeeExportBtn){
        employeeExportBtn.addEventListener('click', function(){
          if (!SELECTED_EMPLOYEE){
            alert('Selectează mai întâi un angajat din Index sau din filtrul de angajați.');
            return;
          }
          if (!ALL_STATS || !ALL_STATS.employees || !ALL_STATS.employees.has(SELECTED_EMPLOYEE)){
            alert('Nu găsesc date pentru acest angajat.');
            return;
          }
          const emp = ALL_STATS.employees.get(SELECTED_EMPLOYEE);
          const t   = emp.totals;
          const daysArr = Array.from(emp.days.values())
            .sort((a,b)=>a.dateKey < b.dateKey ? -1 : (a.dateKey > b.dateKey ? 1 : 0));

          const totalNormH = msToHours(t.totalWorkMs);
          const totalExtraH= msToHours(t.totalExtraMs);
          const totalOverH = msToHours(t.overtimeMs);
          const pctComplete = t.daysWithStart ? Math.round(100 * t.daysCompleted / t.daysWithStart) : 0;

          const header = [
            'Nume','Departament','Total ore norma (h)','Total ore extra (h)',
            'Total overtime (h)','Zile cu START','Zile cu FINISH','Zile complete',
            'Zile cu norma validata','Procent zile complete (%)',
            'Data','Norma (h)','Extra (h)','Overtime (h)','Complet','Norma validata'
          ];
          
          const rows = daysArr.map(d => {
            const flagIncomplete = isDayIncomplete(d);
            return [
              emp.name,
              emp.dept || '',
              totalNormH.toFixed(2),
              totalExtraH.toFixed(2),
              totalOverH.toFixed(2),
              t.daysWithStart,
              t.daysWithFinish,
              t.daysCompleted,
              t.normValidatedDays,
              pctComplete,
              d.dateKey,
              (msToHours(d.workMs) || 0).toFixed(2),
              (msToHours(d.extraMs) || 0).toFixed(2),
              (msToHours(d.overtimeMs) || 0).toFixed(2),
              d.completed ? 'DA' : (flagIncomplete ? ('INCOMPLETA: ' + getIncompleteReasons(d).join('; ')) : '-'),
              d.normValidated ? 'VALIDATA' : 'NU'
            ];
          });

          const csvLines = [header].concat(rows).map(row => row.map(cell => {
            const s = String(cell).replace(/"/g,'""');
            return '"' + s + '"';
          }).join(','));
          const csv = csvLines.join('\r\n');

          const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url;
          a.download = 'pontaj-' + SELECTED_EMPLOYEE.replace(/\s+/g,'_') + '.csv';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);
        });
      }

      if (payrollExportBtn){
        payrollExportBtn.addEventListener('click', function(){
          const now = new Date();
          let year = now.getFullYear();
          let month = now.getMonth() - 1;
          if (month < 0){
            month = 11;
            year--;
          }
          const start = new Date(year, month, 1, 0,0,0);
          const end   = new Date(year, month+1, 0, 23,59,59,999);
          const monthLabel = (month+1).toString().padStart(2,'0') + '.' + year;

          const confirmMsg = 'Generezi exportul de salarizare pentru luna ' + monthLabel + '?';
          if (!confirm(confirmMsg)) return;

          const subset = (events || []).filter(ev=>{
            if (!ev.ts) return false;
            const t = new Date(ev.ts);
            if (isNaN(t.getTime())) return false;
            return t >= start && t <= end;
          });
          if (!subset.length){
            alert('Nu există pontaje în luna ' + monthLabel + ' pentru export.');
            return;
          }
          const statsMonth = buildStatsFromEvents(subset);
          if (!statsMonth.employees || !statsMonth.employees.size){
            alert('Nu există date agregate pentru această lună.');
            return;
          }

          const header = [
            'Luna',
            'Nume',
            'Departament',
            'Total ore normă (h)',
            'Total ore extra (h)',
            'Total overtime (h)',
            'Zile cu START',
            'Zile cu FINISH',
            'Zile complete',
            'Zile cu normă validată'
          ];

          const rows = [];
          statsMonth.employees.forEach(emp=>{
            const t = emp.totals;
            rows.push([
              monthLabel,
              emp.name,
              emp.dept || '',
              msToHours(t.totalWorkMs).toFixed(2),
              msToHours(t.totalExtraMs).toFixed(2),
              msToHours(t.overtimeMs).toFixed(2),
              t.daysWithStart,
              t.daysWithFinish,
              t.daysCompleted,
              t.normValidatedDays
            ]);
          });

          const csvLines = [header].concat(rows).map(row => row.map(cell => {
            const s = String(cell).replace(/"/g,'""');
            return '"' + s + '"';
          }).join(','));
          const csv = csvLines.join('\r\n');

          const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url;
          a.download = 'pontaj-salarizare-' + year + '-' + String(month+1).padStart(2,'0') + '.csv';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);
        });
      }

      // TAB-uri Dashboard / Alerte LIVE (link-ul spre reports.html e tratat separat, e <a>, nu intră aici)
    if (tabButtons && tabButtons.length){
  tabButtons.forEach(btn=>{
    btn.addEventListener('click', function(){
      setActiveTab(btn.dataset.tab || 'dashboard');
    });
  });
}


      // Butoane pentru Live board: azi / zile anterioare
      if (liveBoardTodayBtn && liveBoardPastBtn){
        liveBoardTodayBtn.addEventListener('click', function(){
          LIVE_BOARD_MODE = 'today';
          liveBoardTodayBtn.classList.add('active');
          liveBoardPastBtn.classList.remove('active');
        if (liveBoardHintTextEl){
  liveBoardHintTextEl.textContent = 'Starea curentă a pontajului pentru ziua de azi (START / PAUSE / EXTRA / FINISH).';
}

          renderLiveBoard();
        });
        liveBoardPastBtn.addEventListener('click', function(){
          LIVE_BOARD_MODE = 'past';
          liveBoardPastBtn.classList.add('active');
          liveBoardTodayBtn.classList.remove('active');
       if (liveBoardHintTextEl){
  liveBoardHintTextEl.textContent = 'Zile anterioare până la azi în care există zile incomplete pentru cel puțin un angajat.';
}

          renderLiveBoard();
        });
      }

          // --- Live alerts filters ---
      function rerenderAlertsUI(){
        // LIVE
        renderLiveAlertsActive(LAST_LIVE_ACTIVE);
        renderLiveAlertsHistory();
        // SYSTEM
        renderAlertsFromMeta();
        renderSystemAlertsHistory();
      }

      if (alertsTypeFilterEl){
        alertsTypeFilterEl.addEventListener('change', function(){
          ALERTS_FILTER_TYPE = alertsTypeFilterEl.value || 'all';
          rerenderAlertsUI();
        });
      }
      if (alertsDeptFilterEl){
        alertsDeptFilterEl.addEventListener('change', function(){
          ALERTS_FILTER_DEPT = alertsDeptFilterEl.value || 'all';
          rerenderAlertsUI();
        });
      }
      if (alertsSearchEl){
        alertsSearchEl.addEventListener('input', function(){
          ALERTS_FILTER_Q = (alertsSearchEl.value || '').trim();
          rerenderAlertsUI();
        });
      }

      // Umple dropdown-ul de departamente din tab-ul Alerte (reuse din deptFilter)
     function syncAlertsDeptFilter(){
  if (!alertsDeptFilterEl || !deptFilter) return;

  const prev = alertsDeptFilterEl.value || 'all';
  alertsDeptFilterEl.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'Toate';
  alertsDeptFilterEl.appendChild(optAll);

  Array.from(deptFilter.options).forEach(o=>{
    if (!o.value || o.value === 'all') return;
    const x = document.createElement('option');
    x.value = o.value;
    x.textContent = o.textContent;
    alertsDeptFilterEl.appendChild(x);
  });

  // teamlead -> LOCK pe dept
  if (ADMIN_ROLE === 'teamlead' && ADMIN_DEPT){
    alertsDeptFilterEl.value = ADMIN_DEPT;
    alertsDeptFilterEl.disabled = true;
    ALERTS_FILTER_DEPT = ADMIN_DEPT;
    return;
  }

  // admin/viewer -> liber
  alertsDeptFilterEl.disabled = false;
  const exists = prev && alertsDeptFilterEl.querySelector(
    `option[value="${CSS.escape(String(prev))}"]`
  );
  alertsDeptFilterEl.value = exists ? prev : 'all';
  ALERTS_FILTER_DEPT = alertsDeptFilterEl.value;
}

   
      applyRoleVisibility();
      initCollapsibleCards();
      refresh();

      // PORNIM motorul de alerte LIVE (scan la fiecare 60s)
      scanAndUpdateLiveAlerts();
      syncAlertsDeptFilter();

      if (LIVE_ALERT_TIMER) clearInterval(LIVE_ALERT_TIMER);
      LIVE_ALERT_TIMER = setInterval(scanAndUpdateLiveAlerts, 60 * 1000);
    }catch(e){
      showError(e);
    }
  }

  init();
})();
