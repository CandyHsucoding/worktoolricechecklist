const {
  useState,
  useMemo,
  useEffect,
  useRef
} = React;
const h = React.createElement;
const STORAGE_KEY = 'riceChecklist:v2';
const LEGACY_KEY = 'riceChecklistDraft:v1';
const RICE_TYPES = {
  white: '白米',
  brown: '糙米'
};
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const HOLIDAYS = window.TW_HOLIDAYS || {};
const MAKEUP_WORKDAYS = window.TW_MAKEUP_WORKDAYS || {};
const HOLIDAY_YEARS = window.TW_HOLIDAY_YEARS || {};
const EMPTY_DAY = {
  received: '',
  students: '',
  used: '',
  filler: '',
  note: '',
  offName: '',
  // 寒暑假等自訂放假名稱
  dayType: 'auto' // auto：依星期與國定假日判斷；school：強制上課；off：強制放假
};
const createEmptySheet = () => ({
  prevBalance: '',
  prevNotReceived: '',
  thisMonthOrder: '',
  defaultStudents: '',
  // 預設供應人數：上課日沒填人數時帶入
  mergeFrom: '',
  // 併入上個月的起始日（例如開學日 8/31 併入 9 月表）；空白表示不併入
  days: {}
});
const sheetHasData = sheet => !!sheet && (sheet.prevBalance !== '' || sheet.prevNotReceived !== '' || sheet.thisMonthOrder !== '' || Object.values(sheet.days || {}).some(d => d.received !== '' || d.students !== '' || d.used !== ''));
// 新月份沿用最近一個月份的預設供應人數
const findInheritedDefaultStudents = (sheets, year, month, riceType) => {
  for (let back = 1; back <= 24; back++) {
    const [y, m] = shiftMonth(year, month, -back);
    const sh = sheets[sheetKey(y, m, riceType)];
    if (sh && sh.defaultStudents) return sh.defaultStudents;
  }
  return '';
};
// 取得某月的表；沒有表、或舊資料沒有設定過預設人數時，沿用上個月的
const getSheetFor = (sheets, year, month, riceType) => {
  const sheet = sheets[sheetKey(year, month, riceType)] || createEmptySheet();
  if (sheet.defaultStudents !== undefined && sheets[sheetKey(year, month, riceType)]) return sheet;
  return {
    ...sheet,
    defaultStudents: findInheritedDefaultStudents(sheets, year, month, riceType)
  };
};
const pad = n => String(n).padStart(2, '0');
const num = v => v === '' || v == null ? 0 : Number(v) || 0;
const sheetKey = (year, month, riceType) => `${year}-${month}-${riceType}`;
const parseSheetKey = key => {
  const [year, month, riceType] = key.split('-');
  return {
    year: Number(year),
    month: Number(month),
    riceType
  };
};
const shiftMonth = (year, month, delta) => {
  const total = year * 12 + (month - 1) + delta;
  return [Math.floor(total / 12), total % 12 + 1];
};
const getTimeText = (date = new Date()) => date.toLocaleTimeString('zh-TW', {
  hour: '2-digit',
  minute: '2-digit'
});
const todayROC = () => {
  const now = new Date();
  return {
    year: now.getFullYear() - 1911,
    month: now.getMonth() + 1
  };
};

// ---------- 暫存讀取與舊版資料移轉 ----------

const createDefaultStore = () => ({
  settings: {
    schoolName: '',
    filler: ''
  },
  sheets: {},
  current: {
    ...todayROC(),
    riceType: 'white'
  }
});
const normalizeStore = raw => {
  const base = createDefaultStore();
  const store = {
    settings: {
      ...base.settings,
      ...(raw.settings || {})
    },
    sheets: raw.sheets && typeof raw.sheets === 'object' ? raw.sheets : {},
    current: {
      ...base.current,
      ...(raw.current || {})
    }
  };
  store.current.year = Number(store.current.year) || base.current.year;
  store.current.month = Math.min(12, Math.max(1, Number(store.current.month) || base.current.month));
  if (!RICE_TYPES[store.current.riceType]) store.current.riceType = 'white';
  return store;
};
const migrateLegacy = () => {
  const raw = window.localStorage.getItem(LEGACY_KEY);
  if (!raw) return null;
  const legacy = JSON.parse(raw);
  const header = legacy.headerData || {};
  const year = Number(header.year);
  const month = Number(header.month);
  if (!year || !month) return null;
  const days = {};
  (legacy.rows || []).forEach((row, index) => {
    const filler = row.filler === '營養師或午秘' ? '' : row.filler || '';
    const day = {
      ...EMPTY_DAY,
      received: row.received || '',
      students: row.students || '',
      used: row.used || '',
      filler,
      note: row.note || ''
    };
    if (day.received || day.students || day.used || day.filler || day.note) days[index + 1] = day;
  });
  const store = createDefaultStore();
  store.settings.schoolName = header.schoolName || '';
  store.current = {
    year,
    month,
    riceType: 'white'
  };
  store.sheets[sheetKey(year, month, 'white')] = {
    prevBalance: String(header.prevBalance ?? ''),
    prevNotReceived: String(header.prevNotReceived ?? ''),
    thisMonthOrder: String(header.thisMonthOrder ?? ''),
    days
  };
  return {
    store,
    message: `已從舊版帶入 ${year} 年 ${month} 月的資料`,
    needsSave: true
  };
};
const loadInitial = () => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        store: normalizeStore(parsed),
        message: parsed.savedAt ? `已載入上次暫存：${getTimeText(new Date(parsed.savedAt))}` : '已載入暫存',
        needsSave: false
      };
    }
    const migrated = migrateLegacy();
    if (migrated) return migrated;
  } catch (error) {
    console.warn('無法載入暫存資料', error);
  }
  return {
    store: createDefaultStore(),
    message: '輸入後會自動暫存',
    needsSave: false
  };
};

// ---------- 計算 ----------

const getAutoDayInfo = (gregorianYear, month, date) => {
  const iso = `${gregorianYear}-${pad(month)}-${pad(date)}`;
  const dow = new Date(gregorianYear, month - 1, date).getDay();
  const holiday = HOLIDAYS[iso] || '';
  const isWeekend = dow === 0 || dow === 6;
  const autoOff = !!holiday || isWeekend && !MAKEUP_WORKDAYS[iso];
  return {
    dow,
    holiday,
    autoOff
  };
};
const daysInMonthOf = (year, month) => new Date(year + 1911, month, 0).getDate();
const getMergeInfo = (sheet, year, month) => {
  const [prevYear, prevMonth] = shiftMonth(year, month, -1);
  const from = num(sheet.mergeFrom);
  const prevDays = daysInMonthOf(prevYear, prevMonth);
  return {
    merged: from >= 1 && from <= prevDays,
    from,
    prevYear,
    prevMonth,
    prevDays
  };
};
const getPeriodText = (sheet, year, month) => {
  const m = getMergeInfo(sheet, year, month);
  if (!m.merged) return `${year} 年 ${month} 月`;
  if (m.prevYear === year) return `${year} 年 ${m.prevMonth}～${month} 月`;
  return `${m.prevYear} 年 ${m.prevMonth} 月～${year} 年 ${month} 月`;
};
const computeSheet = (sheet, year, month) => {
  const merge = getMergeInfo(sheet, year, month);
  // 每一列：key 是 days 裡的索引（本月用日期數字，併入的上月日子用 p+日期）
  const entries = [];
  if (merge.merged) {
    for (let d = merge.from; d <= merge.prevDays; d++) entries.push({
      key: `p${d}`,
      y: merge.prevYear,
      m: merge.prevMonth,
      d
    });
  }
  for (let d = 1; d <= daysInMonthOf(year, month); d++) entries.push({
    key: String(d),
    y: year,
    m: month,
    d
  });
  let balance = num(sheet.prevBalance);
  let totalReceived = 0;
  let totalUsed = 0;
  const issues = [];
  let firstNegativeDate = null;
  const rows = [];
  for (const entry of entries) {
    const {
      key
    } = entry;
    const date = merge.merged ? `${entry.m}/${entry.d}` : entry.d;
    const where = merge.merged ? date : `${date} 日`;
    const day = {
      ...EMPTY_DAY,
      ...(sheet.days[key] || {})
    };
    const {
      dow,
      holiday,
      autoOff
    } = getAutoDayInfo(entry.y + 1911, entry.m, entry.d);
    const isOff = day.dayType === 'off' || day.dayType !== 'school' && autoOff;
    const offLabel = day.offName || holiday || (dow === 0 || dow === 6 ? '假日' : '放假');
    const hasData = day.received !== '' || day.students !== '' || day.used !== '';
    const received = isOff ? 0 : num(day.received);
    const used = isOff ? 0 : num(day.used);
    balance += received - used;
    totalReceived += received;
    totalUsed += used;
    const isReceivedValid = received === 0 || received % 30 === 0;
    const students = day.students !== '' ? day.students : isOff ? '' : sheet.defaultStudents || '';
    const studentsIsDefault = day.students === '' && students !== '';
    if (!isOff) {
      if (!isReceivedValid) issues.push(`${where}進貨量 ${received} 不是 30 的倍數`);
      if (day.used !== '' && students === '') issues.push(`${where}有用量但沒填供應人數`);
      if (day.students !== '' && day.used === '') issues.push(`${where}有供應人數但沒填用量`);
      if (num(day.received) < 0 || num(day.used) < 0 || num(day.students) < 0) issues.push(`${where}有負數`);
    } else if (hasData) {
      issues.push(`${where}是放假日，填的數字沒有計入（如果這天有上課，請點星期欄改成上課日）`);
    }
    if (balance < 0 && firstNegativeDate === null) firstNegativeDate = where;
    rows.push({
      key,
      index: rows.length,
      date,
      day,
      students,
      studentsIsDefault,
      dow,
      dayOfWeek: DAY_NAMES[dow],
      holiday,
      autoOff,
      isOff,
      offLabel,
      hasData,
      balance,
      isReceivedValid
    });
  }
  if (firstNegativeDate !== null) issues.unshift(`${firstNegativeDate}起結存量變成負數，請檢查進貨量或前月結存量`);
  const currentNotReceived = num(sheet.prevNotReceived) + num(sheet.thisMonthOrder) - totalReceived;
  if (currentNotReceived < 0) issues.push(`本月尚未進貨數量是負數（${currentNotReceived}），進貨總量超過前月未進貨＋本月申購`);
  return {
    rows,
    totalReceived,
    totalUsed,
    finalBalance: balance,
    currentNotReceived,
    merged: merge.merged,
    issues
  };
};

// ---------- 檔案下載 ----------

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const csvCell = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvLine = cells => cells.map(csvCell).join(',') + '\r\n';

// ---------- 圖示 ----------

const Icon = ({
  children
}) => h('svg', {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '18',
  height: '18',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
}, children);
const PrinterIcon = () => h(Icon, null, h('polyline', {
  points: '6 9 6 2 18 2 18 9'
}), h('path', {
  d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2'
}), h('rect', {
  x: '6',
  y: '14',
  width: '12',
  height: '8'
}));
const DownloadIcon = () => h(Icon, null, h('path', {
  d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'
}), h('polyline', {
  points: '7 10 12 15 17 10'
}), h('line', {
  x1: '12',
  y1: '15',
  x2: '12',
  y2: '3'
}));
const UploadIcon = () => h(Icon, null, h('path', {
  d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'
}), h('polyline', {
  points: '17 8 12 3 7 8'
}), h('line', {
  x1: '12',
  y1: '3',
  x2: '12',
  y2: '15'
}));
const TrashIcon = () => h(Icon, null, h('polyline', {
  points: '3 6 5 6 21 6'
}), h('path', {
  d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'
}), h('path', {
  d: 'M10 11v6'
}), h('path', {
  d: 'M14 11v6'
}));

// ---------- 畫面 ----------

const btn = 'flex items-center gap-1.5 px-3 py-1.5 rounded transition text-sm border';
const btnGray = `${btn} bg-white hover:bg-gray-100 text-gray-700 border-gray-300`;
const cell = 'border border-gray-800';
const inputBase = 'w-full text-center py-0.5 px-1 bg-transparent focus:outline-none focus:bg-yellow-50 text-sm print:text-[11px] print:py-0';
function App() {
  const initial = useMemo(loadInitial, []);
  const [store, setStore] = useState(initial.store);
  const [saveStatus, setSaveStatus] = useState(initial.message);
  const skipSave = useRef(!initial.needsSave);
  const fileInputRef = useRef(null);
  const [vacation, setVacation] = useState(null); // 寒暑假設定面板：{ start, end, name }
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      try {
        const savedAt = new Date();
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          ...store,
          savedAt: savedAt.toISOString()
        }));
        setSaveStatus(`已自動暫存：${getTimeText(savedAt)}`);
      } catch (error) {
        console.warn('無法暫存資料', error);
        setSaveStatus('暫存失敗，請檢查瀏覽器設定');
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [store]);
  const {
    year,
    month,
    riceType
  } = store.current;
  const riceName = RICE_TYPES[riceType];
  const currentKey = sheetKey(year, month, riceType);
  const sheet = useMemo(() => getSheetFor(store.sheets, year, month, riceType), [store.sheets, currentKey]);
  const merge = getMergeInfo(sheet, year, month);
  const periodText = getPeriodText(sheet, year, month);
  const calc = useMemo(() => {
    const result = computeSheet(sheet, year, month);
    // 併入的上月日子如果在上月的表也有填，會重複計算
    const mergedFromSheet = merge.merged && store.sheets[sheetKey(merge.prevYear, merge.prevMonth, riceType)];
    if (mergedFromSheet) {
      const dup = [];
      for (let d = merge.from; d <= merge.prevDays; d++) {
        const day = mergedFromSheet.days[d];
        if (day && (day.received !== '' || day.students !== '' || day.used !== '')) dup.push(`${merge.prevMonth}/${d}`);
      }
      if (dup.length) result.issues.unshift(`${dup.join('、')} 在 ${merge.prevMonth} 月的表也有資料，會重複計算，請刪掉其中一邊`);
    }
    return result;
  }, [sheet, year, month, store.sheets, riceType]);

  // 前月結存從「最近一個有資料的月份」帶入（例如暑假 7、8 月沒有表，就從 6 月帶）
  let prevYear = null;
  let prevMonth = null;
  let prevSheet = null;
  for (let back = 1; back <= 24; back++) {
    const [y, m] = shiftMonth(year, month, -back);
    const candidate = store.sheets[sheetKey(y, m, riceType)];
    if (sheetHasData(candidate)) {
      prevYear = y;
      prevMonth = m;
      prevSheet = candidate;
      break;
    }
  }
  const prevCalc = useMemo(() => prevSheet ? computeSheet(prevSheet, prevYear, prevMonth) : null, [prevSheet, prevYear, prevMonth]);
  const prevPeriodText = prevSheet ? getPeriodText(prevSheet, prevYear, prevMonth) : '';
  const canCarryFromPrev = !!prevCalc && (String(sheet.prevBalance) !== String(prevCalc.finalBalance) || String(sheet.prevNotReceived) !== String(prevCalc.currentNotReceived));
  const holidayYearStatus = HOLIDAY_YEARS[year + 1911];
  const savedMonths = Object.keys(store.sheets).filter(key => key.endsWith(`-${riceType}`)).map(parseSheetKey).sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
  const yearOptions = [];
  for (let y = todayROC().year - 3; y <= todayROC().year + 2; y++) yearOptions.push(y);
  if (!yearOptions.includes(year)) yearOptions.push(year);
  yearOptions.sort((a, b) => a - b);

  // ----- 狀態更新 -----

  const setCurrent = patch => setStore(s => ({
    ...s,
    current: {
      ...s.current,
      ...patch
    }
  }));
  const setSettings = (field, value) => setStore(s => ({
    ...s,
    settings: {
      ...s.settings,
      [field]: value
    }
  }));
  const updateSheet = updater => setStore(s => {
    const key = sheetKey(s.current.year, s.current.month, s.current.riceType);
    return {
      ...s,
      sheets: {
        ...s.sheets,
        [key]: updater(getSheetFor(s.sheets, s.current.year, s.current.month, s.current.riceType))
      }
    };
  });
  const setHeaderField = (field, value) => updateSheet(sh => ({
    ...sh,
    [field]: value
  }));
  const updateDayPatch = (key, patch) => updateSheet(sh => ({
    ...sh,
    days: {
      ...sh.days,
      [key]: {
        ...EMPTY_DAY,
        ...(sh.days[key] || {}),
        ...patch
      }
    }
  }));
  const updateDay = (key, field, value) => updateDayPatch(key, {
    [field]: value
  });
  const goMonth = delta => {
    const [y, m] = shiftMonth(year, month, delta);
    setCurrent({
      year: y,
      month: m
    });
  };
  const carryFromPrev = () => {
    if (!prevCalc) return;
    updateSheet(sh => ({
      ...sh,
      prevBalance: String(prevCalc.finalBalance),
      prevNotReceived: String(prevCalc.currentNotReceived)
    }));
  };
  const startNextMonth = () => {
    const [ny, nm] = shiftMonth(year, month, 1);
    const nextKey = sheetKey(ny, nm, riceType);
    const carry = {
      prevBalance: String(calc.finalBalance),
      prevNotReceived: String(calc.currentNotReceived)
    };
    const existing = store.sheets[nextKey];
    if (existing && (existing.prevBalance !== carry.prevBalance || existing.prevNotReceived !== carry.prevNotReceived)) {
      const ok = window.confirm(`${ny} 年 ${nm} 月已經有資料。\n\n要把「前月${riceName}結存量」改成 ${carry.prevBalance}、「前月尚未進貨量」改成 ${carry.prevNotReceived} 嗎？\n\n按「取消」只切換月份，不改數字。`);
      if (!ok) {
        setCurrent({
          year: ny,
          month: nm
        });
        return;
      }
    }
    setStore(s => ({
      ...s,
      current: {
        ...s.current,
        year: ny,
        month: nm
      },
      sheets: {
        ...s.sheets,
        [nextKey]: {
          ...getSheetFor(s.sheets, ny, nm, riceType),
          ...carry
        }
      }
    }));
  };
  const toggleDayType = row => {
    let next;
    if (row.isOff) next = row.autoOff ? 'school' : 'auto';else next = row.autoOff ? 'auto' : 'off';
    updateDayPatch(row.key, {
      dayType: next,
      offName: ''
    });
  };
  const clearMonth = () => {
    if (!store.sheets[currentKey]) return;
    const ok = window.confirm(`確定要清除 ${year} 年 ${month} 月（${riceName}）的所有資料嗎？其他月份不受影響。`);
    if (!ok) return;
    setStore(s => {
      const sheets = {
        ...s.sheets
      };
      delete sheets[currentKey];
      return {
        ...s,
        sheets
      };
    });
  };

  // ----- 寒暑假：一次設定一段日期（可跨月）-----

  const applyVacation = mode => {
    const {
      start,
      end,
      name
    } = vacation;
    if (!start || !end) return window.alert('請選開始日和結束日。');
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T00:00:00`);
    if (endDate < startDate) return window.alert('結束日不能早於開始日。');
    const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
    if (totalDays > 120) return window.alert('一次最多設定 120 天。');
    // 找出每一天要改的位置：該月的表（目前米種，以及已經有表的其他米種），還有把這天併入的下個月表
    const targets = [];
    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
      const y = dt.getFullYear() - 1911;
      const m = dt.getMonth() + 1;
      const d = dt.getDate();
      const [ny, nm] = shiftMonth(y, m, 1);
      Object.keys(RICE_TYPES).forEach(rt => {
        const key = sheetKey(y, m, rt);
        if (rt === riceType || store.sheets[key]) targets.push({
          y,
          m,
          rt,
          key,
          dayKey: String(d)
        });
        const nextSheet = store.sheets[sheetKey(ny, nm, rt)];
        const from = nextSheet ? num(nextSheet.mergeFrom) : 0;
        if (from >= 1 && d >= from) targets.push({
          y: ny,
          m: nm,
          rt,
          key: sheetKey(ny, nm, rt),
          dayKey: `p${d}`
        });
      });
    }
    const label = (name || '').trim() || '放假';
    if (mode === 'off') {
      const withData = targets.filter(t => {
        const day = store.sheets[t.key]?.days[t.dayKey];
        return day && (day.received !== '' || day.students !== '' || day.used !== '');
      }).length;
      const msg = `要把 ${start} 到 ${end}（共 ${totalDays} 天）設成「${label}」嗎？` + (withData ? `

注意：其中有 ${withData} 天已經填了數字，設成放假後不會計入。` : '');
      if (!window.confirm(msg)) return;
    } else if (!window.confirm(`要把 ${start} 到 ${end}（共 ${totalDays} 天）改回自動判斷嗎？
（週末與國定假日照常放假，其他日子是上課日）`)) return;
    const patch = mode === 'off' ? {
      dayType: 'off',
      offName: label
    } : {
      dayType: 'auto',
      offName: ''
    };
    setStore(s => {
      const sheets = {
        ...s.sheets
      };
      targets.forEach(t => {
        const sh = getSheetFor(sheets, t.y, t.m, t.rt);
        sheets[t.key] = {
          ...sh,
          days: {
            ...sh.days,
            [t.dayKey]: {
              ...EMPTY_DAY,
              ...(sh.days[t.dayKey] || {}),
              ...patch
            }
          }
        };
      });
      return {
        ...s,
        sheets
      };
    });
    setVacation(null);
  };

  // ----- 鍵盤：Enter / ↓ 往下，↑ 往上，自動跳過放假日 -----

  const handleKeyDown = (e, index, field) => {
    let dir = 0;
    if (e.key === 'Enter' || e.key === 'ArrowDown') dir = 1;
    if (e.key === 'ArrowUp') dir = -1;
    if (!dir) return;
    e.preventDefault();
    for (let i = index + dir; i >= 0 && i < calc.rows.length; i += dir) {
      if (calc.rows[i].isOff) continue;
      const el = document.getElementById(`${field}-${calc.rows[i].key}`);
      if (el) {
        el.focus();
        el.select();
      }
      break;
    }
  };
  const blockWheel = e => e.currentTarget.blur();

  // ----- 匯出 / 備份 -----

  const schoolTitle = store.settings.schoolName || '';
  const handleExportCSV = () => {
    let csv = '﻿';
    csv += csvLine([`${schoolTitle || '___________'}學校 ${periodText}食米用量登記表（${riceName}）`]);
    csv += csvLine([`前月${riceName}結存量`, sheet.prevBalance, '公斤', '前月尚未進貨量', sheet.prevNotReceived, '公斤']);
    csv += csvLine([`本月${riceName}申購量`, sheet.thisMonthOrder, '公斤']);
    csv += '\r\n';
    csv += csvLine(['日期', '星期', '進貨量(公斤)', '供應學生人數', `${riceName}用量(公斤)`, `${riceName}結存量(公斤)`, '填表人', '備註']);
    calc.rows.forEach(r => {
      const filler = r.isOff ? '' : r.day.filler || (r.hasData ? store.settings.filler : '');
      csv += csvLine([r.date, r.dayOfWeek, r.isOff ? '' : r.day.received, r.isOff ? '' : r.students, r.isOff ? '' : r.day.used, r.balance, filler, r.day.note || (r.isOff ? r.offLabel : '')]);
    });
    csv += csvLine(['合計', '', calc.totalReceived, '', calc.totalUsed, calc.finalBalance, '', '']);
    csv += csvLine(['本月尚未進貨數量', calc.currentNotReceived, '公斤']);
    csv += csvLine(['填表人：', store.settings.filler]);
    csv += csvLine(['註：中央廚房學校填寫本表應包括委辦學校食米提領及使用部分。']);
    downloadBlob(new Blob([csv], {
      type: 'text/csv;charset=utf-8'
    }), `${schoolTitle || '食米用量'}登記表_${periodText.replace(/ /g, '')}_${riceName}.csv`);
  };
  const handleBackup = () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const data = {
      app: 'riceChecklist',
      version: 2,
      exportedAt: now.toISOString(),
      settings: store.settings,
      sheets: store.sheets
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    }), `食米登記備份_${schoolTitle || '學校'}_${stamp}.json`);
  };
  const handleRestore = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.sheets !== 'object') throw new Error('格式不符');
      const count = Object.keys(data.sheets).length;
      const ok = window.confirm(`備份檔有 ${count} 個月份的資料。\n\n會合併到目前的資料中，相同月份以備份檔為準。要繼續嗎？`);
      if (!ok) return;
      setStore(s => ({
        ...s,
        settings: {
          schoolName: data.settings?.schoolName || s.settings.schoolName,
          filler: data.settings?.filler || s.settings.filler
        },
        sheets: {
          ...s.sheets,
          ...data.sheets
        }
      }));
      setSaveStatus(`已還原 ${count} 個月份`);
    } catch (error) {
      window.alert('無法讀取這個檔案，請確認是本系統匯出的備份檔（.json）。');
    }
  };

  // ----- 表格欄位 -----

  const numberCell = (r, field, extraTd = '', extraInput = '') => {
    if (r.isOff) {
      const value = r.day[field];
      return h('td', {
        className: cell
      }, value !== '' && h('span', {
        className: 'text-[10px] text-red-600 line-through print:hidden',
        title: '放假日的數字不會計入'
      }, value));
    }
    return h('td', {
      className: `${cell} ${extraTd}`
    }, h('input', {
      id: `${field}-${r.key}`,
      type: 'number',
      min: '0',
      inputMode: 'decimal',
      value: r.day[field],
      onChange: e => updateDay(r.key, field, e.target.value),
      onKeyDown: e => handleKeyDown(e, r.index, field),
      onWheel: blockWheel,
      className: `${inputBase} ${extraInput}`
    }));
  };
  const studentsCell = r => {
    if (r.isOff) return numberCell(r, 'students');
    return h('td', {
      className: cell
    }, h('input', {
      id: `students-${r.key}`,
      type: 'number',
      min: '0',
      inputMode: 'numeric',
      value: r.day.students,
      placeholder: r.studentsIsDefault ? r.students : '',
      title: r.studentsIsDefault ? '目前帶入預設人數，直接輸入可以改這一天' : '',
      onChange: e => updateDay(r.key, 'students', e.target.value),
      onKeyDown: e => handleKeyDown(e, r.index, 'students'),
      onWheel: blockWheel,
      className: `${inputBase} placeholder-gray-500 print:hidden`
    }), h('span', {
      className: 'hidden print:block text-center text-[11px]'
    }, r.students));
  };
  const textCell = (r, field, printValue, placeholder, align = 'text-center') => h('td', {
    className: cell
  }, h('input', {
    id: `${field}-${r.key}`,
    type: 'text',
    value: r.day[field],
    placeholder,
    onChange: e => updateDay(r.key, field, e.target.value),
    onKeyDown: e => handleKeyDown(e, r.index, field),
    className: `${inputBase} ${align} placeholder-gray-400 print:hidden`
  }), h('span', {
    className: `hidden print:block ${align} text-[11px] px-1`
  }, printValue));
  const headerNumber = (field, label, labelClass) => h('div', {
    className: 'flex items-center gap-1'
  }, h('span', {
    className: `font-semibold ${labelClass}`
  }, label), h('input', {
    type: 'number',
    min: '0',
    value: sheet[field],
    onChange: e => setHeaderField(field, e.target.value),
    onWheel: blockWheel,
    placeholder: '0',
    className: 'w-16 text-center border-b border-gray-400 focus:outline-none focus:border-blue-500 print:border-none print:font-bold'
  }), h('span', null, '公斤'));

  // ----- 畫面組合 -----

  const toolbar = h('div', {
    className: 'print:hidden mb-4 space-y-3'
  }, h('div', {
    className: 'flex flex-col md:flex-row md:justify-between md:items-center gap-3'
  }, h('div', null, h('h1', {
    className: 'text-xl font-bold text-gray-700'
  }, '食米用量系統 ', h('span', {
    className: 'text-sm font-normal text-gray-400'
  }, 'v2'), h('a', {
    href: '../',
    className: 'ml-3 text-xs font-normal text-blue-600 underline'
  }, '回舊版')), h('div', {
    className: 'mt-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 inline-flex'
  }, saveStatus)), h('div', {
    className: 'flex flex-wrap md:justify-end gap-2'
  }, h('button', {
    onClick: () => window.print(),
    className: `${btn} bg-blue-600 hover:bg-blue-700 text-white border-blue-600`
  }, h(PrinterIcon), '列印'), h('button', {
    onClick: handleExportCSV,
    className: btnGray
  }, h(DownloadIcon), '匯出 CSV'), h('button', {
    onClick: handleBackup,
    className: btnGray,
    title: '把所有月份存成一個檔案，可在別台電腦還原'
  }, h(DownloadIcon), '備份'), h('button', {
    onClick: () => fileInputRef.current && fileInputRef.current.click(),
    className: btnGray
  }, h(UploadIcon), '還原'), h('input', {
    ref: fileInputRef,
    type: 'file',
    accept: '.json,application/json',
    className: 'hidden',
    onChange: handleRestore
  }), h('button', {
    onClick: clearMonth,
    disabled: !store.sheets[currentKey],
    className: `${btnGray} disabled:opacity-40 disabled:cursor-not-allowed`
  }, h(TrashIcon), '清除本月'))), h('div', {
    className: 'flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-200 rounded p-2 text-sm'
  }, h('button', {
    onClick: () => goMonth(-1),
    className: btnGray,
    title: '上個月'
  }, '◀'), h('select', {
    value: year,
    onChange: e => setCurrent({
      year: Number(e.target.value)
    }),
    className: 'border border-gray-300 rounded px-2 py-1.5 bg-white'
  }, yearOptions.map(y => h('option', {
    key: y,
    value: y
  }, `${y} 年`))), h('select', {
    value: month,
    onChange: e => setCurrent({
      month: Number(e.target.value)
    }),
    className: 'border border-gray-300 rounded px-2 py-1.5 bg-white'
  }, Array.from({
    length: 12
  }, (_, i) => h('option', {
    key: i + 1,
    value: i + 1
  }, `${i + 1} 月`))), h('button', {
    onClick: () => goMonth(1),
    className: btnGray,
    title: '下個月'
  }, '▶'), h('div', {
    className: 'flex rounded border border-gray-300 overflow-hidden ml-1'
  }, Object.entries(RICE_TYPES).map(([type, name]) => h('button', {
    key: type,
    onClick: () => setCurrent({
      riceType: type
    }),
    className: `px-3 py-1.5 ${riceType === type ? 'bg-gray-700 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`
  }, name))), h('select', {
    value: merge.merged ? String(merge.from) : '',
    onChange: e => setHeaderField('mergeFrom', e.target.value),
    title: '開學日在上個月底時，可以把那幾天併到這張表，例如 8/31 開學併入 9 月',
    className: `border rounded px-2 py-1.5 ${merge.merged ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-gray-300 bg-white'}`
  }, h('option', {
    value: ''
  }, `不併入 ${merge.prevMonth} 月`), Array.from({
    length: 10
  }, (_, i) => merge.prevDays - i).map(d => h('option', {
    key: d,
    value: String(d)
  }, `併入 ${merge.prevMonth}/${d} 起（開學日）`))), h('label', {
    className: 'flex items-center gap-1',
    title: '上課日沒填人數時會自動帶入；新月份會沿用上個月的預設人數'
  }, '預設人數', h('input', {
    type: 'number',
    min: '0',
    value: sheet.defaultStudents || '',
    onChange: e => setHeaderField('defaultStudents', e.target.value),
    onWheel: blockWheel,
    className: 'w-20 border border-gray-300 rounded px-2 py-1.5 bg-white text-center'
  }), '人'), h('button', {
    onClick: () => setVacation(vacation ? null : {
      start: '',
      end: '',
      name: month >= 6 && month <= 9 ? '暑假' : '寒假'
    }),
    className: btnGray
  }, '設定寒暑假'), savedMonths.length > 0 && h('select', {
    value: store.sheets[currentKey] ? currentKey : '',
    onChange: e => e.target.value && setCurrent(parseSheetKey(e.target.value)),
    className: 'border border-gray-300 rounded px-2 py-1.5 bg-white'
  }, h('option', {
    value: ''
  }, `已存的${riceName}月份…`), savedMonths.map(m => h('option', {
    key: sheetKey(m.year, m.month, m.riceType),
    value: sheetKey(m.year, m.month, m.riceType)
  }, getPeriodText(store.sheets[sheetKey(m.year, m.month, m.riceType)], m.year, m.month)))), h('div', {
    className: 'flex-1'
  }), h('button', {
    onClick: startNextMonth,
    className: `${btn} bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600`,
    title: '切到下個月，並把本月結存量與尚未進貨數量帶過去'
  }, '開始下個月 →')), vacation && h('div', {
    className: 'flex flex-wrap items-center gap-2 bg-amber-50 border border-amber-200 rounded p-2 text-sm'
  }, h('span', {
    className: 'font-bold text-amber-900'
  }, '寒暑假設定'), h('input', {
    type: 'date',
    value: vacation.start,
    onChange: e => setVacation({
      ...vacation,
      start: e.target.value
    }),
    className: 'border border-gray-300 rounded px-2 py-1 bg-white'
  }), '到', h('input', {
    type: 'date',
    value: vacation.end,
    onChange: e => setVacation({
      ...vacation,
      end: e.target.value
    }),
    className: 'border border-gray-300 rounded px-2 py-1 bg-white'
  }), '名稱', h('input', {
    type: 'text',
    list: 'vacation-names',
    value: vacation.name,
    onChange: e => setVacation({
      ...vacation,
      name: e.target.value
    }),
    className: 'w-24 border border-gray-300 rounded px-2 py-1 bg-white'
  }), h('datalist', {
    id: 'vacation-names'
  }, ['寒假', '暑假', '停課', '颱風假'].map(n => h('option', {
    key: n,
    value: n
  }))), h('button', {
    onClick: () => applyVacation('off'),
    className: `${btn} bg-amber-600 hover:bg-amber-700 text-white border-amber-600`
  }, '設為放假'), h('button', {
    onClick: () => applyVacation('auto'),
    className: btnGray
  }, '改回自動判斷'), h('button', {
    onClick: () => setVacation(null),
    className: 'text-gray-500 hover:text-gray-700 px-2'
  }, '關閉'), h('div', {
    className: 'w-full text-xs text-amber-800'
  }, '可以跨月份，例如 2027/01/20 到 2027/02/10；放假日的備註欄會印出這個名稱。')), h('div', {
    className: 'text-xs text-gray-500 space-y-0.5'
  }, h('div', null, '・點「星期」欄可以切換上課日／放假日（例如補課、寒暑假、颱風假），有改過的會標 *。'), h('div', null, '・資料只存在這台電腦的這個瀏覽器，換電腦或清除瀏覽紀錄前請先按「備份」。')), !holidayYearStatus && h('div', {
    className: 'text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1'
  }, `沒有內建 ${year} 年的國定假日，目前只自動標示週末，國定假日請點星期欄手動設定。`), holidayYearStatus === 'estimated' && h('div', {
    className: 'text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1'
  }, `${year} 年的國定假日是推估的，請以人事行政總處公告為準，不同的日子請點星期欄調整。`), canCarryFromPrev && h('div', {
    className: 'flex flex-wrap items-center gap-2 text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded px-2 py-1.5'
  }, `最近有資料的月份（${prevPeriodText}）結存 ${prevCalc.finalBalance} 公斤、尚未進貨 ${prevCalc.currentNotReceived} 公斤，跟本月表頭不同。`, h('button', {
    onClick: carryFromPrev,
    className: 'px-2 py-0.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700'
  }, '帶入這些數字')), h('div', {
    className: `text-sm rounded px-2 py-1.5 border ${calc.issues.length ? 'text-red-800 bg-red-50 border-red-200' : 'text-emerald-800 bg-emerald-50 border-emerald-200'}`
  }, calc.issues.length ? h('div', null, h('div', {
    className: 'font-bold mb-0.5'
  }, `檢核：有 ${calc.issues.length} 個地方要確認`), h('ul', {
    className: 'list-disc pl-5 text-xs space-y-0.5'
  }, calc.issues.map((text, i) => h('li', {
    key: i
  }, text)))) : '檢核：目前沒有發現問題'));
  const title = h('div', {
    className: 'text-center mb-2 print:mb-1'
  }, h('div', {
    className: 'text-xl md:text-2xl print:text-lg font-bold flex items-center justify-center gap-1 mb-1'
  }, h('input', {
    type: 'text',
    value: store.settings.schoolName,
    onChange: e => setSettings('schoolName', e.target.value),
    placeholder: '請輸入學校名稱',
    className: 'w-56 text-center border-b border-gray-400 focus:outline-none focus:border-blue-500 font-bold placeholder-gray-300 print:hidden'
  }), h('span', {
    className: 'hidden print:inline'
  }, schoolTitle || '＿＿＿＿＿＿＿'), h('span', null, `${periodText}食米用量登記表`)), h('div', {
    className: 'text-xs text-gray-500 mb-2 print:mb-1'
  }, `附件三（白米、糙米分張填寫）　本張：${riceName}`), h('div', {
    className: 'flex flex-wrap justify-between items-center gap-2 px-2 text-sm print:text-xs'
  }, headerNumber('prevBalance', `前月${riceName}結存量`, 'text-blue-700'), headerNumber('prevNotReceived', '前月尚未進貨量', 'text-red-700'), headerNumber('thisMonthOrder', `本月${riceName}申購量`, '')));
  const table = h('div', {
    className: 'border-2 border-gray-800 print:border'
  }, h('table', {
    className: `w-full text-center border-collapse text-sm print:text-[11px] ${calc.rows.length > 31 ? 'dense-print' : ''}`
  }, h('thead', null, h('tr', {
    className: 'bg-gray-100 print:bg-gray-100/50'
  }, h('th', {
    className: `${cell} py-1 ${calc.merged ? 'w-12' : 'w-10'}`
  }, '日期'), h('th', {
    className: `${cell} py-1 w-10`
  }, '星期'), h('th', {
    className: `${cell} py-1 bg-pink-100 print:bg-pink-50 w-20`
  }, '進貨量', h('br'), h('span', {
    className: 'text-[10px] font-normal text-red-600 print:hidden'
  }, '(須為30倍數)')), h('th', {
    className: `${cell} py-1 w-24`
  }, '供應學生人數'), h('th', {
    className: `${cell} py-1 bg-green-50 w-20`
  }, `${riceName}用量`, h('br'), '(公斤)'), h('th', {
    className: `${cell} py-1 w-20`
  }, `${riceName}結存量`, h('br'), '(公斤)'), h('th', {
    className: `${cell} py-1 w-28`
  }, '填表人'), h('th', {
    className: `${cell} py-1 w-28`
  }, '備註'))), h('tbody', null, calc.rows.map(r => {
    const rowClass = r.isOff ? 'bg-gray-200 text-gray-500 print:bg-gray-100' : 'hover:bg-gray-50';
    const dayClass = r.dow === 0 || r.holiday ? 'text-red-600 font-bold' : r.dow === 6 ? 'text-green-700 font-bold' : '';
    const fillerPrint = r.isOff ? '' : r.day.filler || (r.hasData ? store.settings.filler : '');
    const notePrint = r.day.note || (r.isOff ? r.offLabel : '');
    const notePlaceholder = r.isOff ? r.offLabel : r.autoOff ? '上課日' : '';
    return h('tr', {
      key: r.key,
      className: rowClass
    }, h('td', {
      className: `${cell} font-semibold py-0.5 print:py-0`
    }, r.date), h('td', {
      className: `${cell} py-0.5 print:py-0 cursor-pointer select-none hover:ring-2 hover:ring-inset hover:ring-blue-300 ${dayClass}`,
      title: r.isOff ? '點一下改成上課日' : '點一下改成放假日',
      onClick: () => toggleDayType(r)
    }, r.dayOfWeek, r.day.dayType !== 'auto' && h('span', {
      className: 'text-amber-600 print:hidden'
    }, '*')), numberCell(r, 'received', !r.isReceivedValid ? 'bg-red-50' : '', !r.isReceivedValid ? 'text-red-600 font-bold' : ''), studentsCell(r), numberCell(r, 'used'), h('td', {
      className: `${cell} font-bold ${r.balance < 0 ? 'text-red-600 bg-red-50' : 'text-blue-800 bg-gray-50/50'} print:bg-transparent`
    }, r.balance), r.isOff ? h('td', {
      className: cell
    }) : textCell(r, 'filler', fillerPrint, store.settings.filler || ''), textCell(r, 'note', notePrint, notePlaceholder, 'text-left'));
  }), h('tr', {
    className: 'bg-gray-100 font-bold border-t-2 border-gray-800 print:bg-gray-50'
  }, h('td', {
    className: `${cell} py-1`,
    colSpan: 2
  }, '合計'), h('td', {
    className: `${cell} py-1 text-red-700`
  }, calc.totalReceived || ''), h('td', {
    className: `${cell} py-1`
  }), h('td', {
    className: `${cell} py-1 text-green-700`
  }, calc.totalUsed || ''), h('td', {
    className: `${cell} py-1 ${calc.finalBalance < 0 ? 'text-red-600' : 'text-blue-800'}`
  }, calc.finalBalance), h('td', {
    className: `${cell} py-1`
  }), h('td', {
    className: `${cell} py-1`
  })))));
  const footer = h('div', {
    className: 'mt-2 px-2 print:mt-1'
  }, h('div', {
    className: 'flex flex-wrap justify-between items-end gap-2 mb-1'
  }, h('div', {
    className: 'flex items-center gap-2 text-sm print:text-xs'
  }, h('span', {
    className: 'font-bold text-orange-900'
  }, '本月尚未進貨數量'), h('span', {
    className: `text-lg print:text-base font-bold underline underline-offset-4 px-2 ${calc.currentNotReceived < 0 ? 'text-red-600 bg-red-50' : 'text-red-600'}`
  }, calc.currentNotReceived), h('span', {
    className: 'font-bold'
  }, '公斤。')), h('div', {
    className: 'flex items-center gap-2 font-bold text-sm print:text-xs'
  }, '填表人：', h('input', {
    type: 'text',
    value: store.settings.filler,
    onChange: e => setSettings('filler', e.target.value),
    placeholder: '營養師或午秘姓名',
    title: '每天的填表人沒填時，列印會自動帶入這個名字（只帶入有資料的日子）',
    className: 'border-b border-gray-800 px-2 w-40 text-center font-medium tracking-widest focus:outline-none placeholder-gray-300 print:border-gray-800'
  }))), h('div', {
    className: 'text-xs font-semibold text-gray-600 print:text-[10px]'
  }, '註：中央廚房學校填寫本表應包括委辦學校食米提領及使用部分。'));
  return h('div', {
    className: 'min-h-screen bg-gray-50 p-2 md:p-4 font-sans text-gray-800 print:bg-white print:p-0'
  }, h('div', {
    className: 'max-w-5xl mx-auto bg-white shadow-lg rounded-lg p-4 md:p-6 print:shadow-none print:p-0 print:max-w-full'
  }, toolbar, title, table, footer));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(h(App));
