'use strict';

// Theme picker. Themes are CSS classes on <body>; this script handles selection,
// persistence, date-based auto-suggest, and rendering the picker chips.
// Runs at script load so the body class is applied before the first paint.

(function () {
  const THEMES = [
    { id: 'classic',    label: '🟢 Classic' },
    { id: 'light',      label: '☀️ Light' },
    { id: 'christmas',  label: '🎄 Christmas' },
    { id: 'halloween',  label: '🎃 Halloween' },
    { id: 'valentines', label: '💝 Valentine\'s' },
    { id: 'diwali',     label: '✨ Diwali' }
  ];

  // Date-based default. Year-agnostic: month/day windows.
  // Diwali floats — using a generous late-October to mid-November window.
  function seasonalDefault(today = new Date()) {
    const m = today.getMonth() + 1;       // 1–12
    const d = today.getDate();
    if (m === 12 || (m === 1 && d <= 5))           return 'christmas';
    if ((m === 10 && d >= 20) || (m === 11 && d <= 5)) return 'halloween';
    if (m === 11 && d >= 6 && d <= 20)             return 'diwali';
    if (m === 2 && d >= 7 && d <= 17)              return 'valentines';
    // Respect OS-level light-mode preference when no holiday matches.
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'classic';
  }

  const STORAGE_KEY = 'elbbarcs:theme';

  function apply(theme) {
    const root = document.documentElement;
    const klasses = THEMES.map(t => 'theme-' + t.id);
    root.classList.remove(...klasses);
    document.body.classList.remove(...klasses);
    if (theme && theme !== 'classic') {
      root.classList.add('theme-' + theme);
    }
  }

  function getActive() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some(t => t.id === saved)) return saved;
    return seasonalDefault();
  }

  function setActive(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
    renderChips();
  }

  function renderChips() {
    const row = document.getElementById('theme-row');
    if (!row) return;
    const active = getActive();
    row.innerHTML = '';
    for (const t of THEMES) {
      const chip = document.createElement('button');
      chip.className = 'theme-chip' + (t.id === active ? ' active' : '');
      chip.textContent = t.label;
      chip.type = 'button';
      chip.addEventListener('click', () => setActive(t.id));
      row.appendChild(chip);
    }
  }

  // Apply immediately so there's no flash of classic when arriving with a saved theme.
  apply(getActive());

  // Render the chips once the lobby DOM is ready.
  if (document.readyState !== 'loading') renderChips();
  else document.addEventListener('DOMContentLoaded', renderChips);

  // Expose for debugging if needed
  window.Themes = { apply, getActive, setActive, list: THEMES };
})();
