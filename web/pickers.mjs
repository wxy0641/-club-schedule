// 应用内日期选择器与时区搜索列表。所有选择都必须由用户显式确认，
// 不依赖浏览器原生日期弹层，也不从设备时区推断空间时区。
import {
  monthGrid, monthLabel, shiftMonth, timezoneLabel, timezoneOptions, todayInZone, validMonth, weekdayMon1,
} from './calendar-model.mjs';

const pad2 = (value) => String(value).padStart(2, '0');

function localToday() {
  return todayInZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') ?? '';
}

function allowedDate(date, { mondayOnly, min, max }) {
  if (!date) return false;
  if (mondayOnly && weekdayMon1(date) !== 1) return false;
  if (min && date < min) return false;
  if (max && date > max) return false;
  return true;
}

export function createDatePicker() {
  const dialog = document.getElementById('date-picker-dialog');
  const title = document.getElementById('date-picker-title');
  const rule = document.getElementById('date-picker-rule');
  const input = document.getElementById('date-picker-input');
  const applyText = document.getElementById('date-picker-apply-text');
  const prevYear = document.getElementById('date-picker-prev-year');
  const nextYear = document.getElementById('date-picker-next-year');
  const yearLabel = document.getElementById('date-picker-year');
  const months = document.getElementById('date-picker-months');
  const grid = document.getElementById('date-picker-grid');
  const status = document.getElementById('date-picker-status');
  const confirm = document.getElementById('date-picker-confirm');
  const cancel = document.getElementById('date-picker-cancel');
  const close = document.getElementById('date-picker-close');

  let options = { mondayOnly: false };
  let selected = null;
  let view = { year: 2026, month: 1 };
  let onConfirm = null;

  for (let month = 1; month <= 12; month += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-picker-month';
    button.textContent = `${month} 月`;
    button.addEventListener('click', () => {
      view = { ...view, month };
      render();
    });
    months.append(button);
  }

  function setViewFromDate(date) {
    if (typeof date !== 'string' || date.length < 7) return;
    const month = validMonth(date.slice(0, 7));
    if (!month) return;
    view = { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
  }

  function render() {
    yearLabel.textContent = `${view.year} 年`;
    for (const button of months.querySelectorAll('.date-picker-month')) {
      const month = Number(button.textContent.replace(/[^\d]/g, ''));
      button.setAttribute('aria-pressed', String(month === view.month));
    }
    grid.replaceChildren();
    const today = localToday();
    const month = `${view.year}-${pad2(view.month)}`;
    for (const week of monthGrid(month)) {
      for (const date of week) {
        if (!date) {
          const empty = document.createElement('span');
          empty.className = 'date-picker-empty';
          grid.append(empty);
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'date-picker-day';
        button.dataset.date = date;
        button.textContent = String(Number(date.slice(8, 10)));
        const enabled = allowedDate(date, options);
        button.disabled = !enabled;
        if (date === today) button.classList.add('is-today');
        if (date === selected) button.setAttribute('aria-selected', 'true');
        button.setAttribute('aria-label', `${date}${date === today ? '，今天' : ''}${enabled ? '' : '，不可选择'}`);
        button.addEventListener('click', () => {
          selected = date;
          input.value = date;
          status.textContent = '';
          render();
          confirm.focus();
        });
        grid.append(button);
      }
    }
    if (!grid.querySelector('.date-picker-day')) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '该月份没有可选择的日期。';
      grid.append(empty);
    }
    confirm.disabled = !allowedDate(selected, options);
  }

  function moveFocus(event) {
    const buttons = [...grid.querySelectorAll('.date-picker-day:not([disabled])')];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement);
    const step = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
    }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1,
      (index < 0 ? 0 : index) + step))];
    next?.focus();
  }

  function applyManual() {
    const value = input.value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      status.textContent = '请按 YYYY-MM-DD 输入真实日期。';
      return;
    }
    const month = validMonth(value.slice(0, 7));
    if (!month) {
      status.textContent = '日期不合法，请重新输入。';
      return;
    }
    if (!allowedDate(value, options)) {
      status.textContent = options.mondayOnly ? '第一教学周起点必须是周一。' : '该日期不在可选范围内。';
      return;
    }
    selected = value;
    setViewFromDate(value);
    status.textContent = '';
    render();
    confirm.focus();
  }

  function open({
    title: heading = '选择日期', value = '', mondayOnly = false, min = '', max = '', hint = '', onConfirm: callback = null,
  } = {}) {
    options = { mondayOnly, min, max };
    selected = allowedDate(value, options) ? value : null;
    input.value = selected ?? '';
    title.textContent = heading;
    rule.textContent = hint || (mondayOnly
      ? '只能选择周一；年份与月份可快速切换，也可手动输入后识别。'
      : '可选择任意真实日期；年份与月份可快速切换，也可手动输入后识别。');
    status.textContent = '';
    onConfirm = callback;
    const base = selected || localToday();
    setViewFromDate(base);
    if (!selected) view = { year: Number(base.slice(0, 4)) || view.year, month: Number(base.slice(5, 7)) || view.month };
    render();
    dialog.showModal();
    input.focus();
  }

  function accept() {
    if (!allowedDate(selected, options)) return;
    const callback = onConfirm;
    const result = selected;
    dialog.close();
    onConfirm = null;
    if (callback) callback(result);
  }

  function cancelPick() {
    onConfirm = null;
    dialog.close();
  }

  applyText.addEventListener('click', applyManual);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyManual();
    }
  });
  prevYear.addEventListener('click', () => { view = { ...view, year: view.year - 1 }; render(); });
  nextYear.addEventListener('click', () => { view = { ...view, year: view.year + 1 }; render(); });
  grid.addEventListener('keydown', moveFocus);
  confirm.addEventListener('click', accept);
  cancel.addEventListener('click', cancelPick);
  close.addEventListener('click', cancelPick);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelPick();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) cancelPick();
  });

  return {
    open,
    openForField(hiddenInput, config = {}) {
      open({
        ...config,
        value: hiddenInput.value,
        title: config.title ?? '选择日期',
        onConfirm: (value) => {
          hiddenInput.value = value;
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    },
  };
}

export function createDateField(prefix, datePicker, config = {}) {
  const button = document.getElementById(`${prefix}-button`);
  const hidden = document.getElementById(`${prefix}`);
  if (!button || !hidden) return { setValue() {}, value: () => '' };
  const placeholder = config.placeholder ?? '选择日期';
  const sync = () => {
    const value = hidden.value;
    button.textContent = value || placeholder;
    button.classList.toggle('is-empty', !value);
  };
  button.addEventListener('click', () => {
    datePicker.openForField(hidden, {
      title: config.title ?? (config.mondayOnly ? '选择第一教学周周一' : '选择日期'),
      mondayOnly: config.mondayOnly === true,
      min: config.min,
      max: config.max,
      hint: config.hint,
    });
  });
  hidden.addEventListener('input', sync);
  hidden.addEventListener('change', sync);
  sync();
  return {
    setValue(value) {
      hidden.value = value ?? '';
      sync();
    },
    value: () => hidden.value,
  };
}

export function createTimezoneField(prefix) {
  const button = document.getElementById(`${prefix}-timezone-button`);
  const hidden = document.getElementById(`${prefix}-timezone`);
  const panel = document.getElementById(`${prefix}-timezone-panel`);
  const search = document.getElementById(`${prefix}-timezone-search`);
  const list = document.getElementById(`${prefix}-timezone-list`);
  if (!button || !hidden || !panel || !search || !list) return { setValue() {}, value: () => '' };

  const options = timezoneOptions()
    .filter((option) => option.value)
    .map((option) => [option.value, option.label]);
  let expanded = false;

  function closePanel() {
    expanded = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function renderList() {
    const query = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const [value, label] of options) {
      if (query && !`${value} ${label}`.toLowerCase().includes(query)) continue;
      const item = document.createElement('li');
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'tz-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(hidden.value === value));
      option.dataset.value = value;
      option.textContent = label;
      option.addEventListener('click', () => {
        hidden.value = value;
        button.textContent = timezoneLabel(value);
        button.classList.remove('is-empty');
        closePanel();
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
        button.focus();
      });
      item.append(option);
      list.append(item);
    }
    if (!list.children.length) {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = '没有匹配的时区。';
      list.append(item);
    }
  }

  function sync() {
    const value = hidden.value;
    button.textContent = value ? timezoneLabel(value) : '选择时区';
    button.classList.toggle('is-empty', !value);
    if (expanded) renderList();
  }

  button.addEventListener('click', () => {
    expanded = !expanded;
    panel.hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      search.value = '';
      renderList();
      search.focus();
    }
  });
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePanel();
      button.focus();
    }
  });
  hidden.addEventListener('input', sync);
  hidden.addEventListener('change', sync);
  document.addEventListener('click', (event) => {
    if (!expanded) return;
    if (panel.contains(event.target) || button.contains(event.target)) return;
    closePanel();
  });
  sync();
  return {
    setValue(value) {
      hidden.value = value ?? '';
      sync();
    },
    value: () => hidden.value,
  };
}
