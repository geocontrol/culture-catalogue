/* Culture Catalogue: the directory page.
 *
 * Loads the index (/api/catalogue) and the UK gazetteer, then shows one
 * filtered query three ways. Every filter lives in the URL, so any view is
 * a link someone can share.
 */
import { codeName, loadGazetteer } from './gazetteer/areas.js';
import { areaPicker } from './lib/area-picker.js';
import { createMap } from './lib/map.js';
import {
  ACCESS, OFFER_TYPES, SPACE_TYPES, facets, filterEntries, filterValueFor, filtersFromQuery,
  label, mapLayers, normaliseAll, queryFromFilters, summarise,
} from './lib/model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = filtersFromQuery(location.search);
let gaz = null;
let entries = [];
let byId = new Map();
let map = null;

/* ---------- loading ---------- */
async function load() {
  const fresh = new URLSearchParams(location.search).get('fresh');
  const [g, index] = await Promise.all([
    loadGazetteer('/gazetteer/dist'),
    fetch(`/api/catalogue${fresh ? `?fresh=${encodeURIComponent(fresh)}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the index answered ${r.status}`)))),
  ]);
  gaz = g;
  entries = normaliseAll(index, gaz);
  byId = new Map(entries.map((e) => [e.id, e]));
  if (fresh) { // drop the one-off parameter from the address
    const q = new URLSearchParams(location.search);
    q.delete('fresh');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  }
}

function areaName(code) {
  if (!code || !gaz) return '';
  if (/^Q\d+$/.test(code)) return gaz.entries.find((e) => e.q === code)?.n || '';
  return codeName(gaz, code);
}

/* ---------- controls ---------- */
function syncControls() {
  $('q').value = state.q;
  for (const r of document.querySelectorAll('input[name="who"]')) r.checked = r.value === state.who;
  for (const r of document.querySelectorAll('input[name="view"]')) r.checked = r.value === state.view;
  $('offers').checked = state.offers;
  picker.set(state.area ? { label: areaName(state.area) || state.area } : null);
}

function setState(patch, { push = false } = {}) {
  Object.assign(state, patch);
  const url = `${location.pathname}${queryFromFilters(state)}`;
  if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
  render();
}

let typing;
$('q').addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => setState({ q: $('q').value.trim() }), 150);
});
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); setState({ q: $('q').value.trim() }); });
$('who').addEventListener('change', (e) => setState({ who: e.target.value, ...(e.target.value === 'person' ? { type: '' } : {}) }));
$('view').addEventListener('change', (e) => setState({ view: e.target.value }));
$('type').addEventListener('change', (e) => setState({ type: e.target.value }));
$('discipline').addEventListener('change', (e) => setState({ discipline: e.target.value }));
$('offers').addEventListener('change', (e) => setState({ offers: e.target.checked }));
window.addEventListener('popstate', () => { Object.assign(state, filtersFromQuery(location.search)); syncControls(); render(); });

let picker = { set() {} };

function fillSelect(sel, items, chosen) {
  const keep = chosen && !items.some((i) => i.value === chosen) ? [{ value: chosen, text: chosen }] : [];
  sel.innerHTML = '<option value="">Any</option>'
    + [...keep, ...items].map((i) => `<option value="${esc(i.value)}"${i.value === chosen ? ' selected' : ''}>${esc(i.text)}</option>`).join('');
  sel.disabled = !items.length && !keep.length;
}

/* ---------- rendering ---------- */
const whereOf = (e) => (e.areas[0]?.label || '').split(',')[0];
function kindLine(e) {
  if (e.kind === 'place') return e.spaceTypes.map((t) => label(t, SPACE_TYPES)).join(', ') || 'Place';
  return e.disciplines.join(', ') || 'Creative';
}
const offerLine = (e) => (e.offers.length === 1 ? (e.offers[0].kind === 'need' ? 'Looking: ' : 'Offering: ') + e.offers[0].title
  : e.offers.length ? `${e.offers.length} offers open` : '');

function card(e) {
  return `<button type="button" class="card" data-id="${esc(e.id)}" aria-label="${esc(e.name)}, ${esc(kindLine(e))}${whereOf(e) ? `, ${esc(whereOf(e))}` : ''}">
    <span class="card__head"><span class="card__name">${esc(e.name)}</span><span class="card__where">${esc(whereOf(e))}</span></span>
    <span class="card__body">
      <span class="card__kind">${esc(kindLine(e))}</span>
      ${e.summary ? `<span class="card__text">${esc(e.summary)}</span>` : ''}
      ${e.offers.length ? `<span class="card__offer">${esc(offerLine(e))}</span>` : ''}
    </span></button>`;
}

function row(e) {
  return `<button type="button" class="row" data-id="${esc(e.id)}">
    <span class="row__name">${esc(e.name)}<small class="row__kind">${e.kind === 'person' ? 'Person' : 'Place'}</small></span>
    <span class="row__meta">${esc(kindLine(e))}</span>
    <span class="row__where">${esc(e.areas.map((a) => a.label.split(',')[0]).join(', '))}</span>
    <span class="row__offer">${esc(e.offers.length ? (e.offers.length === 1 ? '1 offer' : `${e.offers.length} offers`) : '')}</span>
  </button>`;
}

function emptyMessage() {
  if (!entries.length) {
    return `<p><strong>The catalogue is empty so far.</strong></p>
      <p>Entries appear here when people and places publish them from their own accounts. Be the first: <a href="/join/">add yourself</a>.</p>`;
  }
  const where = areaName(state.area);
  return `<p><strong>Nothing matches${where ? ` in ${esc(where)}` : ''}.</strong></p>
    <p>Try a wider area, or clear a filter. If you know somewhere that should be here, tell them about <a href="/join/">adding themselves</a>.</p>`;
}

function render() {
  if (!gaz) return;
  const shown = filterEntries(entries, state);
  // menus count what the other filters leave, so a choice never leads to nothing
  const f = facets(filterEntries(entries, { ...state, type: '', discipline: '' }));
  fillSelect($('type'), f.types.map((t) => ({ value: t.code, text: `${t.label} (${t.n})` })), state.type);
  fillSelect($('discipline'), f.disciplines.map((d) => ({ value: d.label, text: `${d.label} (${d.n})` })), state.discipline);
  $('type').closest('.field').hidden = state.who === 'person';
  $('discipline').closest('.field').hidden = state.who === 'place';

  $('result-summary').textContent = summarise(shown, areaName(state.area));
  const views = { list: $('view-list'), cards: $('view-cards'), map: $('view-map') };
  for (const [k, el] of Object.entries(views)) el.hidden = k !== state.view || (!shown.length && k !== 'map');
  $('empty').hidden = Boolean(shown.length);
  if (!shown.length) $('empty').innerHTML = emptyMessage();

  if (state.view === 'cards') $('view-cards').innerHTML = shown.map(card).join('');
  if (state.view === 'list') $('view-list').innerHTML = shown.map(row).join('');
  if (state.view === 'map') {
    map ||= createMap($('map'), {
      onOpen: (id) => setState({ open: id }, { push: true }),
      onArea: (code) => { picker.set({ label: areaName(code) }); setState({ area: code, view: 'cards' }); },
    });
    map.show(mapLayers(shown, gaz, state.area), byId).catch((e) => {
      $('map').innerHTML = `<p class="empty">The map couldn’t load (${esc(e.message)}). The list and cards still work.</p>`;
    });
  }
  renderDetail();
}

for (const id of ['view-cards', 'view-list']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) setState({ open: b.dataset.id }, { push: true });
  });
}

/* ---------- detail ---------- */
const dialog = $('detail');
dialog.addEventListener('close', () => { if (state.open) setState({ open: '' }, { push: true }); });
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

function offerHtml(o) {
  const meta = [o.type ? label(o.type, OFFER_TYPES) : '', o.price, o.remote ? 'Remote possible' : '',
    o.until ? `Until ${new Date(o.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : '']
    .filter(Boolean).join('. ');
  return `<div class="offer">
    <p class="offer__title">${o.kind === 'need' ? 'Looking for: ' : ''}${esc(o.title)}</p>
    ${o.description ? `<p>${esc(o.description)}</p>` : ''}
    ${meta ? `<p class="offer__meta">${esc(meta)}</p>` : ''}
    ${o.links.map((l) => `<p><a href="${esc(l)}" rel="noopener nofollow ugc">${esc(new URL(l).host)}</a></p>`).join('')}
  </div>`;
}

function detailHtml(e) {
  const facts = [];
  if (e.kind === 'person') {
    if (e.basedIn.length) facts.push(['Based in', e.basedIn.map((a) => a.label).join('; ')]);
    if (e.activeIn.length) facts.push(['Also active in', e.activeIn.map((a) => a.label).join('; ')]);
  } else {
    if (e.address) facts.push(['Address', e.address]);
    if (e.access) facts.push(['Access', label(e.access, ACCESS)]);
    if (e.hours) facts.push(['Hours', e.hours]);
    if (e.capacity) facts.push(['Capacity', String(e.capacity)]);
    if (e.accessibility) facts.push(['Accessibility', e.accessibility]);
    if (e.serviceArea.length) facts.push(['Serves', e.serviceArea.map((a) => a.label).join('; ')]);
    if (e.tags.length) facts.push(['Tags', e.tags.join(', ')]);
  }
  if (e.links.length) facts.push(['Links', e.links.map((l) => `<a href="${esc(l)}" rel="noopener nofollow ugc">${esc(new URL(l).host.replace(/^www\./, ''))}</a>`).join(', '), true]);
  const handle = e.handle ? `@${e.handle}` : e.did;
  return `<article class="detail__card">
    <header class="detail__head">
      <h2 id="detail-name">${esc(e.name)}</h2>
      <button type="button" class="detail__close" aria-label="Close" data-close>×</button>
    </header>
    ${e.image ? `<img class="detail__image" src="${esc(e.image)}" alt="">` : ''}
    <p class="detail__kind">${esc(e.kind === 'person' ? 'Person' : 'Place')}: ${esc(kindLine(e))}</p>
    ${e.summary ? `<p class="detail__summary">${esc(e.summary)}</p>` : ''}
    ${facts.length ? `<dl class="facts">${facts.map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>` : ''}
    ${e.offers.length ? `<h3>${e.offers.some((o) => o.kind === 'offer') ? 'Offers' : 'Looking for'}</h3>${e.offers.map(offerHtml).join('')}` : ''}
    <p class="detail__source">Published by <a href="https://bsky.app/profile/${esc(e.handle || e.did)}" rel="noopener">${esc(handle)}</a> in their own account${e.legacy ? ', as an older venue record' : ''}. Culture Catalogue shows it; they can change or remove it at any time.</p>
  </article>`;
}

dialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dialog.close(); });

function renderDetail() {
  const e = state.open && byId.get(state.open);
  if (!e) {
    if (dialog.open) dialog.close();
    return;
  }
  $('detail-body').innerHTML = detailHtml(e);
  if (!dialog.open) dialog.showModal();
}

/* ---------- start ---------- */
try {
  await load();
  picker = areaPicker({
    input: $('area-input'), list: $('area-list'), clear: $('area-clear'), gaz,
    onPick: (hit) => setState({ area: filterValueFor(hit) }),
  });
  syncControls();
  render();
} catch (e) {
  $('result-summary').textContent = 'The catalogue couldn’t load.';
  $('empty').hidden = false;
  $('empty').innerHTML = `<p><strong>The catalogue couldn’t load.</strong></p><p>${esc(e.message)}. Reload the page to try again.</p>`;
}
