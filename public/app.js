// OSRS Enhanced Hiscores dashboard. Plain DOM, no build step.
// All user-supplied data goes through textContent / attributes, never innerHTML.

const app = document.getElementById('app');
const boardbar = document.getElementById('boardbar');
const tooltip = document.getElementById('tooltip');

const PAGE_SIZE = 25;
const ACCOUNT_TYPES = ['', 'Ironman', 'Ultimate ironman', 'Hardcore ironman', 'Group ironman',
  'Hardcore group ironman', 'Unranked group ironman'];
const GAME_MODES = { HARDCORE_MAIN: 'Hardcore Worlds', FRESH_START_WORLD: 'Fresh Start', SEASONAL: 'Leagues', DEADMAN: 'Deadman' };
const SKILLS = ['ATTACK', 'DEFENCE', 'STRENGTH', 'HITPOINTS', 'RANGED', 'PRAYER', 'MAGIC', 'COOKING', 'WOODCUTTING',
  'FLETCHING', 'FISHING', 'FIREMAKING', 'CRAFTING', 'SMITHING', 'MINING', 'HERBLORE', 'AGILITY', 'THIEVING',
  'SLAYER', 'FARMING', 'RUNECRAFT', 'HUNTER', 'CONSTRUCTION', 'SAILING'];
const STATS = [
  { key: 'loot_value', label: 'Loot value', format: (v) => gp(v) },
  { key: 'total_kills', label: 'Kills', format: (v) => num(v) },
  { key: 'collection_log', label: 'Collection log', format: (v) => num(v) },
  { key: 'quest_points', label: 'Quest points', format: (v) => num(v) },
  { key: 'playtime', label: 'Hours played', format: (v) => hours(v) },
  { key: 'quests_completed', label: 'Quests completed', format: (v) => num(v) },
  { key: 'diaries', label: 'Achievement diaries', format: (v) => `${num(v)} / 48` },
  { key: 'ca_points', label: 'Combat achievements', format: (v) => `${num(v)} pts` },
  { key: 'slayer_points', label: 'Slayer points', format: (v) => num(v) },
  { key: 'slayer_streak', label: 'Slayer task streak', format: (v) => num(v) },
];
const PERIODS = [['day', 'Today'], ['week', 'This week'], ['month', 'This month']];

let boards = [];

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v); // CSSOM, so the strict CSP allows it
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const num = (v) => (v == null ? '–' : Number(v).toLocaleString());
function compact(v) {
  const n = Number(v ?? 0);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 1 : 2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
const gp = (v) => compact(v) + ' gp';
const hours = (minutes) => (minutes == null ? '–' : num(Math.floor(minutes / 60)) + ' h');
const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const skillName = (s) => titleCase(s);
const skillIcon = (s) => h('img', { class: 'skill-icon', src: `/icons/skills/${s.toLowerCase()}.png`, alt: '', width: 16, height: 16 });

/** 5_400_000 -> "1h 30m"; days for long spans. */
function duration(ms) {
  if (ms == null) return '–';
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const d = Math.floor(m / 1440), hr = Math.floor((m % 1440) / 60), min = m % 60;
  if (d) return `${d}d ${hr}h`;
  return hr ? `${hr}h ${min}m` : `${min}m`;
}
/** "clue scrolls (elite)" -> "Clue Scrolls (Elite)"; "larran's big chest" -> "Larran's Big Chest". */
const SMALL_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'to', 'a']);
const prettyName = (s) => s.replace(/(^|[\s(])([a-z]+)/g, (_, pre, w) =>
  pre + (pre !== '' && pre !== '(' && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
const isClue = (name) => name.startsWith('clue scrolls');
/** Personal best seconds -> "1:01.20" (minutes:seconds). */
function pbTime(sec) {
  if (sec == null) return '–';
  const m = Math.floor(sec / 60);
  const rest = sec - m * 60;
  const frac = Math.abs(rest % 1) > 1e-9;
  const secs = frac ? rest.toFixed(2).padStart(5, '0') : String(Math.round(rest)).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${secs}` : `${m}:${secs}`;
}
const date = (ms) => (ms == null ? '–' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units = [[86400 * 365, 'y'], [86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, unit] of units) if (s >= secs) return `${Math.floor(s / secs)}${unit} ago`;
  return 'just now';
}

const itemIcon = (id, name) => h('img', {
  class: 'item-icon', src: `https://static.runelite.net/cache/item/icon/${encodeURIComponent(id)}.png`,
  alt: name ?? '', loading: 'lazy', width: 36, height: 32,
});

async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await fetch(qs ? `${path}?${qs}` : path, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

// ---------- routing ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, params: new URLSearchParams(qs) };
}

/** Build a hash link. Empty/default params are dropped to keep URLs short. */
function href(path, params = {}) {
  const defaults = { board: 'normal', cat: 'overall', page: '0', metric: 'kills' };
  const qs = new URLSearchParams(Object.entries(params)
    .filter(([k, v]) => v != null && v !== '' && String(v) !== defaults[k])).toString();
  return '#' + path + (qs ? '?' + qs : '');
}

const playerHref = (name, board, season) => href(`/player/${encodeURIComponent(name)}`, { board, season });
const playerLink = (name, board, season) => h('a', { href: playerHref(name, board, season) }, name);
const boardLabel = (id) => boards.find((b) => b.id === id)?.label ?? id;

function accountBadges(accountType, gameMode) {
  return [
    accountType ? h('span', { class: 'badge' }, ACCOUNT_TYPES[accountType] ?? 'Ironman') : null,
    GAME_MODES[gameMode] ? h('span', { class: 'badge' }, GAME_MODES[gameMode]) : null,
  ];
}

// Hover + keyboard-focus tooltip. `content` returns the tooltip's child nodes.
function withTooltip(el, content) {
  const show = (x, y) => {
    tooltip.replaceChildren(...content());
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.min(x + 14, window.innerWidth - r.width - 8) + 'px';
    tooltip.style.top = Math.min(y + 14, window.innerHeight - r.height - 8) + 'px';
  };
  el.addEventListener('mousemove', (e) => show(e.clientX, e.clientY));
  el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); show(r.left + r.width / 2, r.bottom); });
  const hide = () => { tooltip.hidden = true; };
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
  return el;
}

const errorView = (e) => h('div', { class: 'card error' }, e.message ?? String(e));

function tile(label, value, sub) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    sub ? h('div', { class: 'tile-sub' }, sub) : null);
}

// ---------- game mode bar ----------

/** Render the board selector. `linkFor(boardId)` gives the destination for the current page. */
function renderBoardbar(current, linkFor, only) {
  const visible = only ? boards.filter((b) => only.includes(b.id)) : boards;
  const groups = [...new Set(visible.map((b) => b.group))];
  const select = h('select', { class: 'board-select', 'aria-label': 'Game mode',
    onchange: (e) => { location.hash = linkFor(e.target.value); } },
  groups.map((g) => h('optgroup', { label: g },
    visible.filter((b) => b.group === g).map((b) => h('option', { value: b.id, selected: b.id === current }, b.label)))));

  // Like the official hiscores: single boards are links, groups open a menu.
  const nav = h('div', { class: 'board-nav board-group' }, groups.map((g) => {
    const items = visible.filter((b) => b.group === g);
    if (items.length === 1) {
      const b = items[0];
      return h('a', { class: 'pill', href: linkFor(b.id), 'aria-current': b.id === current ? 'page' : null }, b.label);
    }
    const active = items.find((b) => b.id === current);
    const group = h('div', { class: 'nav-group' + (active ? ' current' : '') });
    const button = h('button', { type: 'button', 'aria-haspopup': 'true',
      onclick: () => group.classList.toggle('open') }, active ? active.label : g);
    group.append(button, h('div', { class: 'nav-menu', role: 'menu', 'aria-label': g },
      items.map((b) => h('a', { class: 'pill', role: 'menuitem', href: linkFor(b.id), 'aria-current': b.id === current ? 'page' : null }, b.label))));
    return group;
  }));
  boardbar.replaceChildren(nav, select);
}

// ---------- theme ----------

// Themes: classic (like the official hiscores, default), then modern light and dark.
const THEMES = ['classic', 'light', 'dark'];
const THEME_NAMES = { classic: 'Classic', light: 'Modern light', dark: 'Modern dark' };
const themeToggle = document.getElementById('theme-toggle');
const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  themeToggle.title = `Theme: ${THEME_NAMES[t]} (click to change)`;
  themeToggle.setAttribute('aria-label', themeToggle.title);
};
applyTheme(THEMES.includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'classic');
themeToggle.addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length];
  applyTheme(next);
  localStorage.setItem('theme', next);
});
// Close open game-mode menus when clicking elsewhere.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.nav-group.open').forEach((g) => { if (!g.contains(e.target)) g.classList.remove('open'); });
});

// ---------- header search ----------

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const suggestions = document.getElementById('search-suggestions');
let suggestTimer;
let lastSuggestions = [];

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) return suggestions.replaceChildren();
  suggestTimer = setTimeout(async () => {
    lastSuggestions = (await api('/api/players', { q }).catch(() => [])) ?? [];
    suggestions.replaceChildren(...lastSuggestions.map((r) => h('option', { value: r.username })));
  }, 200);
});

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = searchInput.value.trim();
  if (!name) return;
  const match = lastSuggestions.find((s) => s.username.toLowerCase() === name.toLowerCase());
  location.hash = match ? playerHref(match.username, match.board, match.season) : playerHref(name);
});

// ---------- hiscores page ----------

function categoryTitle(cat, params) {
  if (cat === 'overall') return 'Overall';
  if (cat.startsWith('skill:')) return skillName(cat.slice(6));
  if (cat === 'source') return params.get('name') ?? 'Boss';
  if (cat === 'quest') return params.get('qname') ?? 'Quest speed';
  if (cat === 'kc') return prettyName(params.get('name') ?? 'Kill count');
  if (cat === 'gains') {
    const skill = params.get('skill') ?? 'overall';
    const period = PERIODS.find(([k]) => k === (params.get('period') ?? 'week'))?.[1] ?? 'This week';
    return `${skill === 'overall' ? 'Overall' : skillName(skill)} XP gained · ${period}`;
  }
  return STATS.find((s) => s.key === cat)?.label ?? cat;
}

async function renderHiscores(params) {
  const board = params.get('board') ?? 'normal';
  const season = params.get('season') ?? '';
  const cat = params.get('cat') ?? 'overall';
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);
  const metric = params.get('metric') === 'value' ? 'value' : 'kills';
  const highlightRank = Number(params.get('rank') ?? 0) || null;
  const type = params.get('type') ?? '';
  const name = params.get('name') ?? '';
  const base = { board, season };

  renderBoardbar(board, (id) => href('/', { ...Object.fromEntries(params), board: id, season: '', page: 0, rank: '' }));

  const quest = params.get('quest') ?? '';
  const period = params.get('period') ?? 'week';
  const gskill = params.get('skill') ?? 'overall';
  const kcMetric = params.get('metric') === 'pb' ? 'pb' : 'kc';
  const [result, sources, summary, timedQuests, kcNames] = await Promise.all([
    api('/api/hiscores', { ...base, category: cat, page, type, name, quest,
      metric: cat === 'kc' ? kcMetric : cat === 'source' ? metric : undefined,
      period: cat === 'gains' ? period : undefined, skill: cat === 'gains' ? gskill : undefined }),
    api('/api/sources', base),
    api('/api/summary', base),
    api('/api/quests', base),
    api('/api/killcounts', base),
  ]);

  // Left: category sidebar, like the official skill list, plus our categories and bosses.
  const catLink = (c, label, icon) =>
    h('li', {}, h('a', { href: href('/', { ...base, cat: c }), 'aria-current': cat === c ? 'page' : null },
      h('span', { class: 'label' }, icon, label)));
  const sourceFilter = h('input', { type: 'search', placeholder: 'Filter bosses', 'aria-label': 'Filter bosses and activities' });
  const sourceList = h('ul', { class: 'cat-list' });
  const renderSources = () => {
    const f = sourceFilter.value.toLowerCase();
    sourceList.replaceChildren(...sources.filter((s) => !f || s.name.toLowerCase().includes(f)).map((s) =>
      h('li', {}, h('a', {
        href: href('/', { ...base, cat: 'source', type: s.type, name: s.name, metric }),
        'aria-current': cat === 'source' && s.type === type && s.name === name ? 'page' : null,
      }, h('span', {}, s.name), h('span', { class: 'count' }, num(s.players))))));
    if (!sourceList.childElementCount) sourceList.append(h('li', { class: 'empty' }, 'No bosses yet.'));
  };
  sourceFilter.addEventListener('input', renderSources);
  renderSources();

  // Official kill counts (Chat Commands plugin) and clue completions.
  const kcLink = (k) => h('li', {}, h('a', {
    href: href('/', { ...base, cat: 'kc', name: k.name, metric: cat === 'kc' ? kcMetric : undefined }),
    'aria-current': cat === 'kc' && k.name === name.toLowerCase() ? 'page' : null,
  }, h('span', {}, prettyName(k.name)), h('span', { class: 'count' }, num(k.players))));
  const kcFilter = h('input', { type: 'search', placeholder: 'Filter bosses', 'aria-label': 'Filter boss kill counts' });
  const kcList = h('ul', { class: 'cat-list' });
  const renderKcs = () => {
    const f = kcFilter.value.toLowerCase();
    const items = kcNames.filter((k) => !isClue(k.name) && (!f || k.name.includes(f)));
    kcList.replaceChildren(...(items.length ? items.map(kcLink) : [h('li', { class: 'empty' }, 'No kill counts yet.')]));
  };
  kcFilter.addEventListener('input', renderKcs);
  renderKcs();

  const sidebar = h('nav', { class: 'card sidebar', 'aria-label': 'Hiscore categories' },
    h('h3', {}, 'Skills'),
    h('ul', { class: 'cat-list' }, catLink('overall', 'Overall', skillIcon('overall')),
      SKILLS.map((s) => catLink(`skill:${s}`, skillName(s), skillIcon(s)))),
    h('h3', {}, 'Loot & account'),
    h('ul', { class: 'cat-list' }, STATS.map((s) => catLink(s.key, s.label))),
    h('h3', {}, 'Gains'),
    h('ul', { class: 'cat-list' }, h('li', {}, h('a', { href: href('/', { ...base, cat: 'gains' }),
      'aria-current': cat === 'gains' ? 'page' : null }, h('span', { class: 'label' }, skillIcon('overall'), 'XP gained')))),
    h('h3', {}, 'Boss kill counts'),
    kcFilter, kcList,
    h('h3', {}, 'Clue scrolls'),
    h('ul', { class: 'cat-list' }, kcNames.filter((k) => isClue(k.name)).length === 0
      ? h('li', { class: 'empty' }, 'No clue counts yet.')
      : kcNames.filter((k) => isClue(k.name)).map((k) => kcLink(k))),
    h('h3', {}, 'Loot by boss'),
    sourceFilter, sourceList,
    h('h3', {}, 'Quest speed'),
    h('ul', { class: 'cat-list' }, timedQuests.length === 0
      ? h('li', { class: 'empty' }, 'No timed quests yet.')
      : timedQuests.map((q) => h('li', {}, h('a', {
        href: href('/', { ...base, cat: 'quest', quest: q.id, qname: q.name }),
        'aria-current': cat === 'quest' && String(q.id) === quest ? 'page' : null,
      }, h('span', {}, q.name), h('span', { class: 'count' }, num(q.players)))))));

  // Centre: the table.
  const rows = result.rows;
  let columns;
  if (cat === 'overall' || cat.startsWith('skill:')) {
    columns = [['Level', (r) => num(r.level)], ['XP', (r) => num(r.xp)]];
  } else if (cat === 'source') {
    columns = [['Kills', (r) => num(r.kills)], ['Loot value', (r) => gp(r.value)]];
  } else if (cat === 'kc') {
    columns = [['Kill count', (r) => num(r.kc)], ['Personal best', (r) => pbTime(r.pb)]];
  } else if (cat === 'gains') {
    columns = [['XP gained', (r) => num(r.gained)]];
  } else if (cat === 'quest') {
    columns = [['Played time', (r) => duration(r.playedMs)], ['Start to finish', (r) => duration(r.elapsedMs)], ['Completed', (r) => date(r.completedAt)]];
  } else {
    const stat = STATS.find((s) => s.key === cat);
    columns = [[stat.label, (r) => stat.format(r.score)]];
  }

  let metricToggle = cat === 'source' ? h('div', { class: 'controls', role: 'group', 'aria-label': 'Rank by' },
    ['kills', 'value'].map((m) => h('a', { class: 'pill', href: href('/', { ...base, cat, type, name, metric: m }),
      'aria-pressed': String(metric === m) }, m === 'kills' ? 'Rank by kills' : 'Rank by loot value'))) : null;
  if (cat === 'kc') {
    metricToggle = h('div', { class: 'controls', role: 'group', 'aria-label': 'Rank by' },
      [['kc', 'Rank by kill count'], ['pb', 'Rank by personal best']].map(([m, label]) => h('a', { class: 'pill',
        href: href('/', { ...base, cat, name, metric: m === 'kc' ? undefined : m }), 'aria-pressed': String(kcMetric === m) }, label)));
  } else if (cat === 'gains') {
    metricToggle = h('div', { class: 'controls', role: 'group', 'aria-label': 'Period' },
      PERIODS.map(([k, label]) => h('a', { class: 'pill', href: href('/', { ...base, cat, period: k === 'week' ? undefined : k, skill: gskill === 'overall' ? undefined : gskill }),
        'aria-pressed': String(period === k) }, label)),
      h('select', { 'aria-label': 'Skill', onchange: (e) => {
        location.hash = href('/', { ...base, cat, period: period === 'week' ? undefined : period, skill: e.target.value === 'overall' ? undefined : e.target.value });
      } }, h('option', { value: 'overall', selected: gskill === 'overall' }, 'Overall'),
      SKILLS.map((sk) => h('option', { value: sk, selected: gskill === sk }, skillName(sk)))));
  }

  const seasonPicker = (() => {
    const seasons = boards.find((b) => b.id === board)?.seasons ?? [];
    if (seasons.length < 2) return null;
    return h('select', { 'aria-label': 'Season', onchange: (e) => { location.hash = href('/', { ...Object.fromEntries(params), season: e.target.value, page: 0 }); } },
      seasons.map((s) => h('option', { value: s, selected: s === result.season }, titleCase(s.replace(/_/g, ' ')))));
  })();

  const table = rows.length === 0 ? h('p', { class: 'empty' }, 'No players on this board yet.') : h('table', {},
    h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'Rank'), h('th', {}, 'Name'),
      columns.map(([label]) => h('th', { class: 'num' }, label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: r.rank === highlightRank ? 'highlight' : null },
      h('td', { class: 'num' }, num(r.rank)),
      h('td', {}, playerLink(r.username, board, result.season), ' ', accountBadges(board === 'normal' ? r.accountType : 0)),
      columns.map(([, value]) => h('td', { class: 'num' }, value(r)))))));

  const pageLink = (p) => href('/', { ...Object.fromEntries(params), page: p, rank: '' });
  const pager = h('div', { class: 'pager' },
    h('a', { class: 'pill', href: pageLink(0), hidden: page === 0 }, 'First'),
    h('a', { class: 'pill', href: pageLink(page - 1), hidden: page === 0 }, 'Previous'),
    h('span', { class: 'muted' }, `Ranks ${num(page * PAGE_SIZE + 1)}–${num(page * PAGE_SIZE + rows.length || page * PAGE_SIZE)}`),
    h('a', { class: 'pill', href: pageLink(page + 1), hidden: rows.length < PAGE_SIZE }, 'Next'));

  const centre = h('section', { class: 'card' },
    h('div', { class: 'table-head' },
      h('h1', {}, `${boardLabel(board)} · ${categoryTitle(cat, params)}`),
      h('span', { class: 'muted' }, `${num(summary.players)} players · ${gp(summary.lootValue)} tracked`)),
    h('div', { class: 'controls' }, metricToggle, seasonPicker),
    table, pager);

  // Right: search boxes, like the official site.
  const nameInput = h('input', { type: 'search', placeholder: 'Player name', maxlength: 12, 'aria-label': 'Player name', required: true });
  const rankInput = h('input', { type: 'number', min: 1, placeholder: 'Rank', 'aria-label': 'Rank', required: true });
  const compareA = h('input', { type: 'search', placeholder: 'Player 1', maxlength: 12, 'aria-label': 'First player', required: true });
  const compareB = h('input', { type: 'search', placeholder: 'Player 2', maxlength: 12, 'aria-label': 'Second player', required: true });
  const side = h('aside', { class: 'side-boxes' },
    h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); location.hash = playerHref(nameInput.value.trim(), board, result.season); } },
      h('h2', {}, 'Search by name'), h('div', { class: 'row' }, nameInput, h('button', { type: 'submit' }, 'Go'))),
    h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      const rank = Math.max(1, Number(rankInput.value) || 1);
      location.hash = href('/', { ...Object.fromEntries(params), page: Math.floor((rank - 1) / PAGE_SIZE), rank });
    } }, h('h2', {}, 'Search by rank'), h('p', { class: 'muted', style: { margin: 0, fontSize: '0.82rem' } }, `In ${categoryTitle(cat, params)}`),
    h('div', { class: 'row' }, rankInput, h('button', { type: 'submit' }, 'Go'))),
    h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      location.hash = href('/compare', { a: compareA.value.trim(), b: compareB.value.trim(), board, season: result.season });
    } }, h('h2', {}, 'Compare players'), compareA, compareB, h('button', { type: 'submit' }, 'Compare')));

  document.title = `${boardLabel(board)} ${categoryTitle(cat, params)} · OSRS Enhanced Hiscores`;
  app.replaceChildren(h('div', { class: 'hiscores' }, sidebar, centre, side));
  app.querySelector('tr.highlight')?.scrollIntoView({ block: 'center' });
}

// ---------- player page ----------

async function renderPlayer(username, params) {
  const data = await api(`/api/players/${encodeURIComponent(username)}`, { board: params.get('board'), season: params.get('season') });
  if (!data) {
    renderBoardbar(params.get('board') ?? 'normal', (id) => href('/', { board: id }));
    app.replaceChildren(h('div', { class: 'card' },
      h('h1', {}, username),
      h('p', { class: 'muted' }, 'This player isn\'t on the hiscores. They need the OSRS Enhanced Hiscores RuneLite plugin with "Submit data" turned on.')));
    return;
  }
  const { profile: p, ranks, board, season } = data;
  const q = { board, season };
  document.title = `${p.username} · OSRS Enhanced Hiscores`;
  renderBoardbar(board, (id) => href('/', { board: id }));

  const enc = encodeURIComponent(p.username);
  const [drops, clogItems, quests, killCounts, progress] = await Promise.all([
    api(`/api/players/${enc}/drops`, { ...q, limit: 30 }),
    api(`/api/players/${enc}/collection-log`, q),
    api(`/api/players/${enc}/quests`, q),
    api(`/api/players/${enc}/killcounts`, q),
    api(`/api/players/${enc}/progress`, q),
  ]);

  const rankCell = (rank) => h('td', { class: 'num' }, rank == null ? '–' : num(rank));
  const catHref = (cat, extra = {}) => href('/', { ...q, cat, ...extra });

  const skillsCard = h('section', { class: 'card' },
    h('h2', {}, 'Skills'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Skill'), h('th', { class: 'num' }, 'Rank'), h('th', { class: 'num' }, 'Level'), h('th', { class: 'num' }, 'XP'))),
      h('tbody', {},
        h('tr', {}, h('td', {}, skillIcon('overall'), h('a', { href: catHref('overall') }, h('strong', {}, 'Overall'))), rankCell(ranks.overall.rank),
          h('td', { class: 'num' }, num(ranks.overall.level)), h('td', { class: 'num' }, num(ranks.overall.xp))),
        ranks.skills.map((s) => h('tr', {},
          h('td', {}, skillIcon(s.skill), h('a', { href: catHref(`skill:${s.skill}`) }, skillName(s.skill))), rankCell(s.rank),
          h('td', { class: 'num' }, num(s.level)), h('td', { class: 'num' }, num(s.xp)))))));

  const statsCard = h('section', { class: 'card' },
    h('h2', {}, 'Loot & account'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Category'), h('th', { class: 'num' }, 'Rank'), h('th', { class: 'num' }, 'Score'))),
      h('tbody', {}, ranks.stats.map((s) => {
        const format = STATS.find((x) => x.key === s.key)?.format ?? num;
        return h('tr', {}, h('td', {}, h('a', { href: catHref(s.key) }, s.label)), rankCell(s.rank),
          h('td', { class: 'num' }, s.score == null ? '–' : format(s.score)));
      }))),
    p.playtimeMinutes == null ? h('p', { class: 'muted', style: { fontSize: '0.82rem' } }, 'Hours played appear once the player reveals them in the Character Summary tab.') : null);

  const clog = p.collectionLog;
  app.replaceChildren(
    h('div', { class: 'player-header' }, h('h1', {}, p.username), accountBadges(p.accountType, p.gameMode),
      h('span', { class: 'muted' }, `Updated ${timeAgo(p.lastUpdated)}`),
      h('a', { class: 'pill', href: href('/compare', { a: p.username, board, season }), style: { marginLeft: 'auto' } }, 'Compare…')),
    p.boards.length > 1 ? h('div', { class: 'board-pills', role: 'group', 'aria-label': 'Ranks on board' },
      h('span', { class: 'muted' }, 'Ranks on:'),
      p.boards.map((id) => h('a', { class: 'pill', href: playerHref(p.username, id, season), 'aria-pressed': String(id === board) }, boardLabel(id)))) : null,
    h('div', { class: 'tiles' },
      tile('Total level', num(p.totalLevel), p.combatLevel ? `Combat ${p.combatLevel}` : null),
      tile('Total XP', compact(p.totalXp ?? 0)),
      tile('Loot value', gp(p.lootValue), `${num(p.totalKills)} kills tracked`),
      tile('Collection log', clog ? `${num(clog.obtained)} / ${num(clog.total)}` : '–',
        clog ? `${((clog.obtained / Math.max(clog.total, 1)) * 100).toFixed(1)}% complete` : null),
      tile('Quest points', num(p.questPoints), p.questsCompleted != null ? `${num(p.questsCompleted)} quests done` : null),
      tile('Hours played', hours(p.playtimeMinutes)),
      tile('Combat achievements', p.combatAchievements ? `${num(p.combatAchievements.points)} pts` : '–',
        p.combatAchievements ? `${num(p.combatAchievements.tasks)} tasks` : null),
      tile('Achievement diaries', p.diariesCompleted != null ? `${num(p.diariesCompleted)} / 48` : '–'),
      tile('Slayer', p.slayer ? `${num(p.slayer.points)} pts` : '–', p.slayer ? `Streak ${num(p.slayer.streak)}` : null)),
    h('div', { class: 'grid-2' }, skillsCard, h('div', { class: 'stack' }, statsCard, clogCategories(clog))),
    lootSection(p.username, q, ranks.sources),
    h('div', { class: 'grid-2' }, killCountsCard(killCounts ?? [], q), diariesCard(p.diaries)),
    progressCard(progress, q),
    questsCard(quests ?? [], q),
    h('div', { class: 'grid-2' }, dropsFeed(drops ?? []), clogItemsCard(clogItems ?? [])));
}

function killCountsCard(kcs, q) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Kill counts & personal bests'));
  if (kcs.length === 0) {
    card.append(h('p', { class: 'empty' }, 'Kill counts come from RuneLite\'s Chat Commands plugin; they appear after the game shows a kill count.'));
    return card;
  }
  const sorted = [...kcs].sort((a, b) => Number(isClue(a.name)) - Number(isClue(b.name)) || a.name.localeCompare(b.name));
  card.append(h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Boss / activity'), h('th', { class: 'num' }, 'KC'), h('th', { class: 'num' }, 'Rank'),
      h('th', { class: 'num' }, 'PB'), h('th', { class: 'num' }, 'PB rank'))),
    h('tbody', {}, sorted.map((k) => h('tr', {},
      h('td', {}, h('a', { href: href('/', { ...q, cat: 'kc', name: k.name }) }, prettyName(k.name))),
      h('td', { class: 'num' }, num(k.kc)), h('td', { class: 'num' }, num(k.kcRank)),
      h('td', { class: 'num' }, pbTime(k.pb)), h('td', { class: 'num' }, num(k.pbRank))))))));
  return card;
}

function diariesCard(diaries) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Achievement diaries'));
  if (!diaries) {
    card.append(h('p', { class: 'empty' }, 'Diaries sync after logging in with the plugin.'));
    return card;
  }
  const tiers = ['Easy', 'Medium', 'Hard', 'Elite'];
  card.append(h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Region'), tiers.map((t) => h('th', { class: 'num' }, t)))),
    h('tbody', {}, Object.entries(diaries).map(([region, done]) => h('tr', {},
      h('td', {}, region),
      done.map((d, i) => h('td', { class: 'num', 'aria-label': `${tiers[i]}: ${d ? 'complete' : 'not complete'}` },
        d ? h('span', { class: 'status-done' }, '✔') : h('span', { class: 'muted' }, '–'))))))));
  return card;
}

/** XP gains for a period plus a line chart of total XP per day. */
function progressCard(progress, q) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'XP gains'));
  if (!progress || !progress.gains.month) {
    card.append(h('p', { class: 'empty' }, 'Gains appear once the plugin has sent stats on at least one day.'));
    return card;
  }
  let period = 'week';
  const tableHost = h('div');
  const buttons = h('div', { class: 'controls', role: 'group', 'aria-label': 'Period', style: { marginBottom: '8px' } });
  const render = () => {
    buttons.replaceChildren(...PERIODS.map(([k, label]) => h('button', { type: 'button', class: 'pill', 'aria-pressed': String(period === k),
      onclick: () => { period = k; render(); } }, label)));
    const g = progress.gains[period];
    const rows = g ? g.skills.filter((x) => x.xp > 0).sort((a, b) => b.xp - a.xp) : [];
    tableHost.replaceChildren(!g ? h('p', { class: 'empty' }, 'No data for this period yet.') : h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Skill'), h('th', { class: 'num' }, 'XP gained'))),
      h('tbody', {},
        h('tr', {}, h('td', {}, skillIcon('overall'), h('a', { href: href('/', { ...q, cat: 'gains', period: period === 'week' ? undefined : period }) }, h('strong', {}, 'Overall'))),
          h('td', { class: 'num' }, h('strong', {}, num(g.overall)))),
        rows.map((x) => h('tr', {}, h('td', {}, skillIcon(x.skill),
          h('a', { href: href('/', { ...q, cat: 'gains', skill: x.skill, period: period === 'week' ? undefined : period }) }, skillName(x.skill))),
        h('td', { class: 'num' }, num(x.xp)))))));
  };
  render();
  card.append(h('div', { class: 'grid-2' },
    h('div', {}, buttons, tableHost),
    h('div', {}, h('h3', {}, 'Total XP by day'), xpChart(progress.history), milestones(progress.levelUps))));
  return card;
}

/** Single-series line chart with a hover crosshair + tooltip. */
function xpChart(history) {
  if (history.length < 2) return h('p', { class: 'empty' }, 'The chart fills in as the plugin sends stats on more days.');
  const W = 420, H = 150, PAD = { l: 52, r: 8, t: 8, b: 22 };
  const xs = history.map((_, i) => PAD.l + (i / (history.length - 1)) * (W - PAD.l - PAD.r));
  const min = Math.min(...history.map((d) => d.totalXp)), max = Math.max(...history.map((d) => d.totalXp));
  const span = max - min || 1;
  const y = (v) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'xp-chart', role: 'img',
    'aria-label': `Total XP from ${compact(min)} on ${history[0].day} to ${compact(max)} on ${history[history.length - 1].day}` });
  for (const v of [min, (min + max) / 2, max]) {
    svg.append(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'grid' }));
    const t = el('text', { x: PAD.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }); t.textContent = compact(v); svg.append(t);
  }
  for (const i of [0, history.length - 1]) {
    const t = el('text', { x: xs[i], y: H - 6, 'text-anchor': i === 0 ? 'start' : 'end', class: 'axis' });
    t.textContent = history[i].day.slice(5); svg.append(t);
  }
  svg.append(el('polyline', { points: history.map((d, i) => `${xs[i]},${y(d.totalXp)}`).join(' '), class: 'line' }));
  const cross = el('line', { y1: PAD.t, y2: H - PAD.b, class: 'crosshair', visibility: 'hidden' });
  const dot = el('circle', { r: 4, class: 'dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = el('rect', { x: PAD.l, y: 0, width: W - PAD.l - PAD.r, height: H, fill: 'transparent' });
  svg.append(hit);
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true; };
  hit.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    let i = 0;
    for (let j = 1; j < xs.length; j++) if (Math.abs(xs[j] - vx) < Math.abs(xs[i] - vx)) i = j;
    const d = history[i];
    cross.setAttribute('x1', xs[i]); cross.setAttribute('x2', xs[i]); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', xs[i]); dot.setAttribute('cy', y(d.totalXp)); dot.setAttribute('visibility', 'visible');
    const prev = history[i - 1];
    tooltip.replaceChildren(h('strong', {}, d.day), `${num(d.totalXp)} XP`, prev ? h('br') : null, prev ? `+${num(d.totalXp - prev.totalXp)} vs previous` : null);
    tooltip.hidden = false;
    tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8) + 'px';
    tooltip.style.top = (e.clientY + 14) + 'px';
  });
  hit.addEventListener('mouseleave', hide);
  return svg;
}

function milestones(levelUps) {
  const box = h('div', {}, h('h3', {}, 'Recent level-ups'));
  if (!levelUps.length) {
    box.append(h('p', { class: 'empty' }, 'Level-ups appear here as they happen.'));
    return box;
  }
  box.append(h('ul', { class: 'cat-list' }, levelUps.slice(0, 12).map((l) => h('li', {}, h('span', { class: 'label', style: { padding: '2px 10px', display: 'flex', justifyContent: 'space-between', width: '100%' } },
    h('span', {}, skillIcon(l.skill), `${skillName(l.skill)} ${l.level}`, l.level === 99 ? h('strong', {}, ' ★') : null),
    h('span', { class: 'muted' }, timeAgo(l.at)))))));
  return box;
}

function questsCard(quests, q) {
  const done = quests.filter((x) => x.state === 'FINISHED').length;
  const card = h('section', { class: 'card' }, h('h2', {}, `Quests (${num(done)} / ${num(quests.length)} completed)`));
  if (quests.length === 0) {
    card.append(h('p', { class: 'empty' }, 'Quest progress syncs after logging in with the plugin.'));
    return card;
  }
  const FILTERS = [['all', 'All'], ['FINISHED', 'Completed'], ['IN_PROGRESS', 'In progress'], ['NOT_STARTED', 'Not started'], ['timed', 'Timed']];
  let filter = 'all';
  const tableHost = h('div', { class: 'scroll' });
  const buttons = h('div', { class: 'controls', role: 'group', 'aria-label': 'Show quests', style: { marginBottom: '8px' } });
  const status = (x) => (x.state === 'FINISHED' ? h('span', { class: 'status-done' }, '✔ Completed')
    : x.state === 'IN_PROGRESS' ? h('span', { class: 'status-progress' }, '… In progress') : h('span', { class: 'muted' }, 'Not started'));
  const render = () => {
    buttons.replaceChildren(...FILTERS.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(filter === k),
      class: 'pill', onclick: () => { filter = k; render(); } }, label)));
    const rows = quests.filter((x) => filter === 'all' || (filter === 'timed' ? x.playedMs != null : x.state === filter));
    tableHost.replaceChildren(rows.length === 0 ? h('p', { class: 'empty' }, 'None.') : h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Quest'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Completed'),
        h('th', { class: 'num' }, 'Played time'), h('th', { class: 'num' }, 'Start to finish'))),
      h('tbody', {}, rows.map((x) => h('tr', {},
        h('td', {}, x.playedMs != null ? h('a', { href: href('/', { ...q, cat: 'quest', quest: x.id, qname: x.name }) }, x.name) : x.name),
        h('td', {}, status(x)),
        h('td', { class: 'num' }, date(x.completedAt)),
        h('td', { class: 'num' }, duration(x.playedMs)),
        h('td', { class: 'num' }, duration(x.elapsedMs)))))));
  };
  render();
  card.append(buttons, tableHost,
    h('p', { class: 'muted', style: { fontSize: '0.82rem' } }, 'Times are measured by the plugin, so only quests started after installing it have them. "Played time" counts time logged in.'));
  return card;
}

function clogCategories(clog) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Collection log'));
  const entries = clog ? Object.entries(clog.categories ?? {}) : [];
  if (entries.length === 0) {
    card.append(h('p', { class: 'empty' }, 'Collection log totals sync after logging in with the plugin.'));
    return card;
  }
  card.append(h('div', { class: 'meters' }, entries.map(([name, [obtained, total]]) => {
    const pct = total > 0 ? (obtained / total) * 100 : 0;
    return withTooltip(h('div', { class: 'meter-row', tabindex: 0, 'aria-label': `${name}: ${obtained} of ${total}` },
      h('span', {}, name),
      h('span', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': obtained },
        h('span', { style: { width: `${pct}%` } })),
      h('span', { class: 'num muted' }, `${num(obtained)} / ${num(total)}`)),
    () => [h('strong', {}, name), `${num(obtained)} of ${num(total)} (${pct.toFixed(1)}%)`]);
  })));
  return card;
}

function lootSection(username, q, sources) {
  const state = { sort: 'value', dir: -1, filter: '', selected: null };
  const tableHost = h('div', { class: 'scroll' });
  const itemsHost = h('div', {}, h('p', { class: 'empty' }, 'Select a boss or activity to see its loot.'));
  const filter = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter bosses and activities' });
  filter.addEventListener('input', () => { state.filter = filter.value.toLowerCase(); render(); });

  const header = (key, label, numeric) => h('th', { class: numeric ? 'num' : null,
    'aria-sort': state.sort === key ? (state.dir < 0 ? 'descending' : 'ascending') : null },
  h('button', { type: 'button', onclick: () => {
    state.dir = state.sort === key ? -state.dir : (numeric ? -1 : 1);
    state.sort = key; render();
  } }, label, state.sort === key ? (state.dir < 0 ? ' ▾' : ' ▴') : ''));

  async function select(source) {
    state.selected = source; render();
    itemsHost.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const items = await api(`/api/players/${encodeURIComponent(username)}/loot/items`, { ...q, type: source.type, name: source.name });
      itemsHost.replaceChildren(
        h('h2', {}, source.name),
        h('p', { class: 'muted' }, `${num(source.kills)} kills (rank ${num(source.killRank)}) · ${gp(source.value)} (rank ${num(source.valueRank)}) · `,
          h('a', { href: href('/', { ...q, cat: 'source', type: source.type, name: source.name }) }, 'leaderboard')),
        h('div', { class: 'item-grid' }, items.map((i) => withTooltip(
          h('div', { class: 'item-slot', tabindex: 0, 'aria-label': `${i.name} x${num(i.quantity)}` },
            h('span', { class: 'qty' }, compact(i.quantity)), itemIcon(i.id, i.name)),
          () => [h('strong', {}, i.name), `Quantity: ${num(i.quantity)}`, h('br'), `Value: ${num(i.value)} gp`]))));
    } catch (e) {
      itemsHost.replaceChildren(errorView(e));
    }
  }

  function render() {
    const rows = sources
      .filter((s) => !state.filter || s.name.toLowerCase().includes(state.filter))
      .sort((a, b) => {
        const av = a[state.sort], bv = b[state.sort];
        return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * state.dir;
      });
    tableHost.replaceChildren(rows.length === 0 ? h('p', { class: 'empty' }, 'No loot tracked yet.') : h('table', {},
      h('thead', {}, h('tr', {}, header('name', 'Boss / activity', false), header('kills', 'Kills', true),
        header('killRank', 'Rank', true), header('value', 'Loot', true))),
      h('tbody', {}, rows.map((s) => h('tr', {
        class: 'clickable' + (state.selected === s ? ' selected' : ''), tabindex: 0,
        onclick: () => select(s), onkeydown: (e) => { if (e.key === 'Enter') select(s); },
      },
      h('td', {}, s.name),
      h('td', { class: 'num' }, num(s.kills)),
      h('td', { class: 'num' }, num(s.killRank)),
      h('td', { class: 'num', title: `${num(s.value)} gp` }, compact(s.value)))))));
  }

  render();
  return h('section', { class: 'card' },
    h('h2', {}, 'Loot by boss'),
    h('div', { class: 'grid-2' },
      h('div', {}, h('div', { class: 'controls', style: { marginBottom: '8px' } }, filter), tableHost),
      itemsHost));
}

function dropsFeed(drops) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Recent drops'));
  if (drops.length === 0) return card.appendChild(h('p', { class: 'empty' }, 'No drops recorded yet.')), card;
  card.append(h('div', { class: 'drops scroll' }, drops.map((d) => h('div', { class: 'drop' },
    h('span', {}, h('strong', {}, d.name), h('span', { class: 'muted' }, ` · ${timeAgo(d.timestamp)}`)),
    h('span', { class: 'num' }, gp(d.value)),
    h('div', { class: 'drop-items' }, d.items.map((i) => withTooltip(
      h('span', { tabindex: 0, 'aria-label': `${i.name} x${num(i.quantity)}` }, itemIcon(i.id, i.name)),
      () => [h('strong', {}, i.name), `x${num(i.quantity)}`])))))));
  return card;
}

function clogItemsCard(items) {
  const card = h('section', { class: 'card' }, h('h2', {}, `Collection log items (${num(items.length)})`));
  if (items.length === 0) {
    card.append(h('p', { class: 'empty' }, 'Items appear as the player browses their collection log in game.'));
    return card;
  }
  card.append(h('div', { class: 'item-grid scroll' }, items.map((i) => withTooltip(
    h('div', { class: 'item-slot', tabindex: 0, 'aria-label': `${i.name} x${num(i.quantity)}` },
      i.quantity > 1 ? h('span', { class: 'qty' }, compact(i.quantity)) : null, itemIcon(i.id, i.name)),
    () => [h('strong', {}, i.name), `Obtained: ${num(i.quantity)}`]))));
  return card;
}

// ---------- compare page ----------

async function renderCompare(params) {
  const board = params.get('board') ?? 'normal';
  const season = params.get('season') ?? '';
  const names = [params.get('a') ?? '', params.get('b') ?? ''];
  renderBoardbar(board, (id) => href('/compare', { a: names[0], b: names[1], board: id }));

  const inputs = names.map((n, i) => h('input', { type: 'search', value: n, maxlength: 12, placeholder: `Player ${i + 1}`, 'aria-label': `Player ${i + 1}`, required: true }));
  const form = h('form', { class: 'card controls', onsubmit: (e) => {
    e.preventDefault();
    location.hash = href('/compare', { a: inputs[0].value.trim(), b: inputs[1].value.trim(), board, season });
  } }, h('h1', { style: { marginRight: '8px' } }, `Compare · ${boardLabel(board)}`), inputs[0], 'vs', inputs[1], h('button', { type: 'submit' }, 'Compare'));

  if (!names[0] || !names[1]) { app.replaceChildren(form); return; }
  // Compare on the requested board even if a player's own default differs, so ranks are like-for-like.
  const players = await Promise.all(names.map((n) => api(`/api/players/${encodeURIComponent(n)}`, { board, season })));
  const missing = names.filter((_, i) => !players[i]);
  if (missing.length) {
    app.replaceChildren(form, h('div', { class: 'card error' }, `Not on the hiscores: ${missing.join(', ')}`));
    return;
  }
  const [a, b] = players;

  /** Row: label, then each player's display value; the higher `score` wins. */
  const row = (label, ca, cb, sa, sb, link) => {
    const aw = sa != null && (sb == null || sa > sb);
    const bw = sb != null && (sa == null || sb > sa);
    return h('tr', {}, h('td', {}, link ? h('a', { href: link }, label) : label),
      h('td', { class: 'num' + (aw ? ' win' : '') }, ca), h('td', { class: 'num' + (bw ? ' win' : '') }, cb));
  };
  const lvlXp = (x) => (x.level == null ? '–' : `${num(x.level)} · ${compact(x.xp)} xp`);
  const q = { board, season };

  const sourcesA = new Map(a.ranks.sources.map((s) => [`${s.type}:${s.name}`, s]));
  const shared = b.ranks.sources.filter((s) => sourcesA.has(`${s.type}:${s.name}`));

  const header = h('thead', {}, h('tr', {}, h('th', {}, ''),
    h('th', { class: 'num' }, playerLink(a.profile.username, board, season)),
    h('th', { class: 'num' }, playerLink(b.profile.username, board, season))));

  app.replaceChildren(form, h('div', { class: 'grid-2' },
    h('section', { class: 'card' }, h('h2', {}, 'Skills'), h('table', {}, header,
      h('tbody', {},
        row('Overall', lvlXp(a.ranks.overall), lvlXp(b.ranks.overall), a.ranks.overall.xp, b.ranks.overall.xp, href('/', { ...q })),
        SKILLS.map((s, i) => row(skillName(s), lvlXp(a.ranks.skills[i]), lvlXp(b.ranks.skills[i]),
          a.ranks.skills[i].xp, b.ranks.skills[i].xp, href('/', { ...q, cat: `skill:${s}` })))))),
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', {}, 'Loot & account'), h('table', {}, header.cloneNode(true),
        h('tbody', {}, a.ranks.stats.map((s, i) => {
          const format = STATS.find((x) => x.key === s.key)?.format ?? num;
          const sb = b.ranks.stats[i];
          return row(s.label, s.score == null ? '–' : format(s.score), sb.score == null ? '–' : format(sb.score), s.score, sb.score, href('/', { ...q, cat: s.key }));
        })))),
      h('section', { class: 'card' }, h('h2', {}, 'Shared bosses & activities (kills)'),
        shared.length === 0 ? h('p', { class: 'empty' }, 'No bosses in common.') : h('table', {}, header.cloneNode(true),
          h('tbody', {}, shared.map((sb) => {
            const sa = sourcesA.get(`${sb.type}:${sb.name}`);
            return row(sb.name, num(sa.kills), num(sb.kills), sa.kills, sb.kills, href('/', { ...q, cat: 'source', type: sb.type, name: sb.name }));
          })))))));
  document.title = `${a.profile.username} vs ${b.profile.username} · OSRS Enhanced Hiscores`;
}

// ---------- about & privacy ----------

const PLUGIN_REPO = 'https://github.com/scottyla/osrs-enhanced-hiscores';

function renderAbout() {
  document.title = 'About & privacy · OSRS Enhanced Hiscores';
  renderBoardbar('normal', (id) => href('/', { board: id }));
  const link = (url, text) => h('a', { href: url, rel: 'noopener' }, text);
  const li = (...c) => h('li', {}, ...c);
  app.replaceChildren(h('section', { class: 'card about' },
    h('h1', {}, 'About OSRS Enhanced Hiscores'),
    h('p', {}, 'Hiscores for what the official hiscores don\'t track: loot, the collection log, quest completion times, achievement diaries, combat achievements, Slayer, boss kill counts and personal bests, hours played and XP gains. Every game mode has its own boards, like the official hiscores.'),
    h('h2', {}, 'How to get on the hiscores'),
    h('ol', {},
      li('Install ', h('strong', {}, 'OSRS Enhanced Hiscores'), ' from the RuneLite Plugin Hub.'),
      li('Enable RuneLite\'s built-in ', h('strong', {}, 'Loot Tracker'), ' (and ', h('strong', {}, 'Chat Commands'), ' for kill counts).'),
      li('In the plugin\'s settings, turn on ', h('strong', {}, 'Submit data'), '. Nothing is sent until you do.'),
      li('Log in. Your stats and Loot Tracker history upload within a few seconds.')),
    h('h2', {}, 'What is collected'),
    h('ul', {},
      li('Your display name, account type (e.g. ironman), game mode, and RuneLite\'s anonymous account hash, which keeps your history across name changes.'),
      li('Levels and XP, quest points and quest progress, collection log totals and the items you view in it, achievement diaries, combat achievements, Slayer points and streak, hours played (only if you reveal it in game).'),
      li('Loot Tracker totals and individual drops; kill counts and personal bests saved by RuneLite\'s Chat Commands plugin; clue completion counts.'),
      li('Like any website, the server sees your IP address when the plugin sends data. It is used for rate limiting and isn\'t stored with your profile.')),
    h('p', {}, h('strong', {}, 'Not collected: '), 'bank contents or wealth, chat messages, location, or any login details. Each kind of data has its own on/off setting in the plugin.'),
    h('h2', {}, 'Removing your data'),
    h('p', {}, 'Turn off ', h('strong', {}, 'Submit data'), ' in the plugin, then open an issue at ',
      link(`${PLUGIN_REPO}/issues`, `${PLUGIN_REPO.replace('https://', '')}/issues`), ' with your display name and we\'ll delete your profile.'),
    h('h2', {}, 'Open source'),
    h('p', {}, 'Plugin: ', link(PLUGIN_REPO, PLUGIN_REPO.replace('https://', '')), h('br'),
      'Website and server: ', link(`${PLUGIN_REPO}-server`, `${PLUGIN_REPO.replace('https://', '')}-server`)),
    h('p', { class: 'muted' }, 'Not affiliated with Jagex or RuneLite. Old School RuneScape is a trademark of Jagex Ltd. Skill and item icons are from the game, via RuneLite.')));
}

// ---------- router ----------

async function route() {
  tooltip.hidden = true;
  const { path, params } = parseHash();
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    if (boards.length === 0) boards = await api('/api/boards');
    const player = path.match(/^\/player\/(.+)$/);
    if (player) await renderPlayer(decodeURIComponent(player[1]), params);
    else if (path === '/compare') await renderCompare(params);
    else if (path === '/about') renderAbout();
    else await renderHiscores(params);
  } catch (e) {
    app.replaceChildren(errorView(e));
  }
  if (!params.get('rank')) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
