/* "Add yourself": sign in (or create an account), then publish a CreativeID,
 * a place, and offers to your own repository.
 *
 * Nothing is kept on this site. Records are read from and written to the
 * person's own server through OAuth (lib/oauth.js), with permission to
 * touch only these three record types (and image uploads) where the server
 * supports narrow permissions. The form logic is in lib/records.js.
 */
import * as oauth from '../lib/oauth.js';
import { loadGazetteer, toAreaRef } from '../gazetteer/areas.js';
import { areaPicker } from '../lib/area-picker.js';
import { ACCESS, OFFER_TYPES, SPACE_TYPES, label } from '../lib/model.js';
import {
  ACCESS_CODES, NSID, OFFER_TYPE_CODES, SPACE_TYPE_CODES, areaForPostcode, isUkPostcode, offerForm,
  offerRecord, personForm, personRecord, placeForm, placeRecord, validateOffer, validatePerson,
  validatePlace, withStatus,
} from '../lib/records.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SCOPE = ['atproto',
  `repo:${NSID.person}?action=create&action=update`,
  `repo:${NSID.place}?action=create&action=update`,
  `repo:${NSID.offer}?action=create&action=update`,
  'blob:image/*'].join(' ');
const SECTIONS = ['s-signin', 's-choose', 's-person', 's-gate', 's-place', 's-offers', 's-done'];
const STEP_OF = { 's-signin': 'account', 's-choose': 'entry', 's-person': 'entry', 's-gate': 'entry',
  's-place': 'entry', 's-offers': 'offers', 's-done': 'entry' };

const st = { me: null, gaz: null, person: null, places: [], offers: [], editingPlace: null,
  editingOffer: null, placeArea: null, history: [] };

/* ---------- small UI helpers ---------- */
function show(id, { push = true } = {}) {
  const current = SECTIONS.find((s) => !$(s).hidden);
  if (push && current && current !== id) st.history.push(current);
  for (const s of SECTIONS) $(s).hidden = s !== id;
  const step = STEP_OF[id];
  const order = ['account', 'entry', 'offers'];
  for (const li of $('steps').children) {
    const i = order.indexOf(li.dataset.step);
    if (li.dataset.step === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    li.classList.toggle('done', i < order.indexOf(step));
  }
  const h = $(id).querySelector('h2');
  if (h && push) { h.setAttribute('tabindex', '-1'); h.focus(); }
}
function back() { show(st.history.pop() || 's-choose', { push: false }); }
document.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) back(); });

function say(text, { error = false } = {}) {
  $('status').textContent = text || '';
  $('status').hidden = !text;
  $('status').classList.toggle('is-error', error);
}
function showErrors(prefix, errs, fields) {
  for (const f of fields) {
    const el = $(`${prefix}-${f}`);
    if (!el) continue;
    const e = errs.find((x) => x.field === f);
    el.textContent = e?.message || '';
    el.hidden = !e;
  }
  if (errs.length) $(`${prefix}-${errs[0].field}`)?.closest('.field, fieldset')?.querySelector('input, textarea, select')?.focus();
}
function busy(button, on, text) {
  button.disabled = on;
  if (on) { button.dataset.label = button.textContent; button.textContent = text; }
  else if (button.dataset.label) button.textContent = button.dataset.label;
}
const friendly = (e) => (e?.code === 'InvalidSwap'
  ? 'This record was changed somewhere else since you opened it. Reload the page to see the latest, then try again.'
  : e?.status === 401 || e?.status === 403
    ? 'Your account didn’t allow that change. Sign out, sign in again and accept the permissions.'
    : `Couldn’t publish: ${e?.message || 'unknown error'}.`);

/* A chip list of chosen areas over an area picker. */
function areaList(el, max) {
  const name = el.dataset.areas;
  el.classList.add('areas');
  const prefix = { 'person-form': 'p', 'place-form': 'l', 'offer-form': 'o' }[el.closest('form').id];
  el.innerHTML = `<div class="combo"><input type="text" id="${prefix}-${name}-input" role="combobox"
      aria-autocomplete="list" aria-expanded="false" aria-controls="${name}-list" autocomplete="off" placeholder="Start typing a place">
    <ul class="combo__list" id="${name}-list" role="listbox" hidden></ul></div><div class="chips"></div>`;
  let items = [];
  const chips = el.querySelector('.chips');
  const input = el.querySelector('input');
  const paint = () => {
    chips.innerHTML = items.map((a, i) => `<span class="chip">${esc(a.label)}<button type="button" data-i="${i}" aria-label="Remove ${esc(a.label)}">×</button></span>`).join('');
    input.disabled = items.length >= max;
    input.placeholder = items.length >= max ? `Up to ${max}` : 'Start typing a place';
  };
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) { items.splice(Number(b.dataset.i), 1); paint(); input.focus(); }
  });
  areaPicker({ input, list: el.querySelector('ul'), gaz: st.gaz, keepText: false,
    onPick: (hit) => {
      if (!hit) return;
      const ref = toAreaRef(st.gaz, hit);
      if (!items.some((a) => (a.wikidata && a.wikidata === ref.wikidata) || a.label === ref.label)) items.push(ref);
      items = items.slice(0, max);
      paint();
    } });
  paint();
  return { get: () => items.slice(), set: (list) => { items = (list || []).slice(0, max); paint(); } };
}
const areas = {};

/* ---------- reading the person's own records ---------- */
async function pdsGet(nsid, rkey) {
  const s = oauth.session();
  const r = await fetch(`${s.pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(s.did)}`
    + `&collection=${encodeURIComponent(nsid)}&rkey=${encodeURIComponent(rkey)}`);
  if (r.status === 400 || r.status === 404) return null;
  if (!r.ok) throw new Error(`reading your account failed (${r.status})`);
  return r.json();
}
async function pdsList(nsid) {
  const s = oauth.session();
  const out = [];
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${s.pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(s.did)}`
      + `&collection=${encodeURIComponent(nsid)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status === 400 || r.status === 404) break;
    if (!r.ok) throw new Error(`reading your account failed (${r.status})`);
    const page = await r.json();
    out.push(...(page.records || []));
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return out;
}
async function loadMine() {
  const [person, places, offers] = await Promise.all([pdsGet(NSID.person, 'self'), pdsList(NSID.place), pdsList(NSID.offer)]);
  st.person = person;
  st.places = places;
  st.offers = offers;
}
const rkeyOf = (uri) => uri.split('/').pop();

/* ---------- 1. account ---------- */
$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const h = $('handle').value.trim().replace(/^@/, '');
  const err = $('e-handle');
  if (!h) { err.textContent = 'Enter your handle. It looks like name.bsky.social.'; err.hidden = false; return; }
  err.hidden = true;
  const b = e.submitter || e.target.querySelector('button');
  busy(b, true, 'Opening your account…');
  try {
    await oauth.startLogin(h, SCOPE);
  } catch (x) {
    busy(b, false);
    err.textContent = `Couldn’t start sign-in: ${x.message}.`;
    err.hidden = false;
  }
});
$('other-host').addEventListener('focus', () => { document.querySelector('input[name="host"][value="other"]').checked = true; });
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const choice = document.querySelector('input[name="host"]:checked').value;
  const host = choice === 'other' ? $('other-host').value.trim() : choice;
  const err = $('e-host');
  if (!host) { err.textContent = 'Enter the address of the host, like pds.example.org.'; err.hidden = false; return; }
  err.hidden = true;
  const b = e.submitter || e.target.querySelector('button');
  busy(b, true, 'Opening sign-up…');
  try {
    await oauth.startSignup(host, SCOPE);
  } catch (x) {
    busy(b, false);
    err.textContent = `Couldn’t start sign-up: ${x.message}.`;
    err.hidden = false;
  }
});
$('sign-out').addEventListener('click', async () => {
  await oauth.signOut();
  location.href = '/join/';
});

/* ---------- 2. choose ---------- */
function renderChoose() {
  $('choose-person-title').textContent = st.person ? 'Edit your creative profile' : 'Myself, as a creative';
  const mine = [];
  if (st.person) mine.push(`<li><span><span class="mine__name">${esc(st.person.value?.name || 'Your profile')}</span><span class="mine__kind">You, as a creative</span></span><a class="btn btn--quiet" href="/?u=${encodeURIComponent(st.person.uri)}">View</a></li>`);
  for (const p of st.places) {
    mine.push(`<li><span><span class="mine__name">${esc(p.value?.name || 'Your place')}</span><span class="mine__kind">${esc((p.value?.spaceTypes || []).map((t) => label(t, SPACE_TYPES)).join(', '))}</span></span>
      <span class="actions"><button type="button" class="btn btn--quiet" data-edit-place="${esc(p.uri)}">Edit</button></span></li>`);
  }
  const open = st.offers.filter((o) => o.value?.status === 'open').length;
  if (st.offers.length) mine.push(`<li><span><span class="mine__name">Offers</span><span class="mine__kind">${open} open of ${st.offers.length}</span></span><button type="button" class="btn btn--quiet" data-go-offers>Manage</button></li>`);
  $('mine').hidden = !mine.length;
  $('mine').innerHTML = mine.length ? `<h3>Already in your account</h3><ul>${mine.join('')}</ul>` : '';
}
$('mine').addEventListener('click', (e) => {
  const p = e.target.closest('[data-edit-place]');
  if (p) openPlace(st.places.find((x) => x.uri === p.dataset.editPlace));
  if (e.target.closest('[data-go-offers]')) openOffers();
});
$('choose-person').addEventListener('click', () => openPerson());
$('choose-place').addEventListener('click', () => show('s-gate'));
$('gate-yes').addEventListener('click', () => openPlace(null));
$('gate-no').addEventListener('click', () => openPerson());

/* ---------- 2a. person ---------- */
function openPerson() {
  const f = personForm(st.person?.value);
  $('p-name').value = f.name || (st.me?.displayName || '');
  $('p-bio').value = f.bio;
  $('p-disciplines').value = f.disciplines;
  $('p-website').value = f.website;
  areas.basedIn.set(f.basedIn);
  areas.activeIn.set(f.activeIn);
  $('person-title').textContent = st.person ? 'Your creative profile' : 'You, as a creative';
  showErrors('pe', [], ['name', 'bio', 'disciplines', 'basedIn', 'activeIn', 'website']);
  show('s-person');
}
$('person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = { name: $('p-name').value, bio: $('p-bio').value, disciplines: $('p-disciplines').value,
    basedIn: areas.basedIn.get(), activeIn: areas.activeIn.get(), website: $('p-website').value };
  const errs = validatePerson(f);
  showErrors('pe', errs, ['name', 'bio', 'disciplines', 'basedIn', 'activeIn', 'website']);
  if (errs.length) return;
  const b = $('person-submit');
  busy(b, true, 'Publishing…');
  try {
    const rec = personRecord(f, st.person?.value);
    const res = await oauth.putRecord(NSID.person, 'self', rec, st.person?.cid);
    st.person = { uri: res.uri, cid: res.cid, value: rec };
    done(res.uri, `${rec.name} is in your account. It will show in the catalogue within a few minutes; the link below shows it now.`);
  } catch (x) {
    say(friendly(x), { error: true });
  } finally {
    busy(b, false);
  }
});

/* ---------- 2c. place ---------- */
function ticks(el, name, codes, table, type) {
  el.innerHTML = codes.map((c) => `<label><input type="${type}" name="${name}" value="${c}"><span>${esc(label(c, table))}</span></label>`).join('');
}
function setTicks(name, values) {
  for (const i of document.querySelectorAll(`input[name="${name}"]`)) i.checked = values.includes(i.value);
}
const ticked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

function accessChanged() {
  const online = ticked('l-access')[0] === 'online_only';
  $('l-address').hidden = online;
  $('l-serviceArea-opt').hidden = online;
}

function openPlace(rec) {
  st.editingPlace = rec;
  const f = placeForm(rec?.value);
  $('l-name').value = f.name;
  setTicks('l-types', f.spaceTypes);
  $('l-otherTypes').value = f.otherTypes;
  $('l-description').value = f.description;
  setTicks('l-access', [f.access]);
  $('l-street').value = f.street;
  $('l-locality').value = f.locality;
  $('l-postcode').value = f.postcode;
  st.placeArea = f.area;
  $('l-area-found').textContent = f.area ? `Listed in ${f.area.label}` : '';
  areas.serviceArea.set(f.serviceArea);
  $('l-hours').value = f.hours;
  $('l-capacity').value = f.capacity;
  $('l-accessibility').value = f.accessibility;
  $('l-website').value = f.website;
  $('l-tags').value = f.tags;
  $('l-image').value = '';
  const img = rec?.value?.images?.[0];
  $('l-alt').value = img?.alt || '';
  $('l-image-current').textContent = img ? 'A photo is already published. Choose a new file to replace it.' : '';
  $('place-title').textContent = rec ? `Edit ${f.name}` : 'Your place';
  accessChanged();
  showErrors('le', [], ['name', 'spaceTypes', 'description', 'access', 'street', 'locality', 'postcode', 'serviceArea', 'hours', 'capacity', 'accessibility', 'website', 'tags', 'image']);
  show('s-place');
}

/* Postcode → the area the place is listed in, via postcodes.io. */
let lookupSeq = 0;
async function lookupPostcode() {
  const pc = $('l-postcode').value.trim();
  const found = $('l-area-found');
  st.placeArea = null;
  if (!isUkPostcode(pc)) { found.textContent = ''; return; }
  const mine = ++lookupSeq;
  found.textContent = 'Finding the area…';
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc.replace(/\s+/g, ''))}`);
    if (mine !== lookupSeq) return;
    if (!r.ok) { found.textContent = 'We couldn’t find that postcode.'; return; }
    const hit = areaForPostcode(st.gaz, (await r.json()).result);
    st.placeArea = hit ? toAreaRef(st.gaz, hit) : null;
    found.textContent = st.placeArea ? `Listed in ${st.placeArea.label}` : 'We couldn’t place that postcode.';
  } catch {
    if (mine === lookupSeq) found.textContent = 'The postcode lookup didn’t answer. Try again in a moment.';
  }
}
$('l-postcode').addEventListener('change', lookupPostcode);
$('l-postcode').addEventListener('blur', lookupPostcode);

async function imageRef(file, alt) {
  if (!file) return undefined;
  if (file.size > 2_000_000) throw Object.assign(new Error('The photo is over 2 MB. Choose a smaller one.'), { field: 'image' });
  const dims = await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { resolve({ width: im.naturalWidth, height: im.naturalHeight }); URL.revokeObjectURL(url); };
    im.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    im.src = url;
  });
  const blob = await oauth.uploadBlob(file);
  return { image: blob, alt: alt.trim(), ...(dims?.width ? { aspectRatio: dims } : {}) };
}

function newPlaceKey(name) {
  if (!st.places.length) return 'self';
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'place';
  let k = base;
  for (let i = 2; st.places.some((p) => rkeyOf(p.uri) === k); i++) k = `${base}-${i}`;
  return k;
}

$('place-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isUkPostcode($('l-postcode').value) && !st.placeArea) await lookupPostcode();
  const f = { name: $('l-name').value, spaceTypes: ticked('l-types'), otherTypes: $('l-otherTypes').value,
    description: $('l-description').value, access: ticked('l-access')[0] || '',
    street: $('l-street').value, locality: $('l-locality').value, postcode: $('l-postcode').value,
    area: st.placeArea, serviceArea: areas.serviceArea.get(), hours: $('l-hours').value,
    capacity: $('l-capacity').value, accessibility: $('l-accessibility').value,
    website: $('l-website').value, tags: $('l-tags').value };
  const fields = ['name', 'spaceTypes', 'description', 'access', 'street', 'locality', 'postcode', 'serviceArea', 'hours', 'capacity', 'accessibility', 'website', 'tags', 'image'];
  const errs = validatePlace(f);
  showErrors('le', errs, fields);
  if (errs.length) return;
  const b = $('place-submit');
  busy(b, true, 'Publishing…');
  try {
    const image = await imageRef($('l-image').files[0], $('l-alt').value);
    const prev = st.editingPlace;
    let rec = placeRecord(f, prev?.value, { image });
    if (image === undefined && prev?.value?.images?.[0] && $('l-alt').value.trim() !== (prev.value.images[0].alt || '')) {
      rec = { ...rec, images: [{ ...prev.value.images[0], alt: $('l-alt').value.trim() }, ...prev.value.images.slice(1)] };
    }
    const rkey = prev ? rkeyOf(prev.uri) : newPlaceKey(f.name);
    const res = await oauth.putRecord(NSID.place, rkey, rec, prev?.cid);
    const entry = { uri: res.uri, cid: res.cid, value: rec };
    st.places = prev ? st.places.map((p) => (p.uri === prev.uri ? entry : p)) : [...st.places, entry];
    done(res.uri, `${rec.name} is in your account. It will show in the catalogue within a few minutes; the link below shows it now.`);
  } catch (x) {
    if (x.field === 'image') showErrors('le', [{ field: 'image', message: x.message }], ['image']);
    else say(friendly(x), { error: true });
  } finally {
    busy(b, false);
  }
});

/* ---------- 3. offers ---------- */
function offerMeta(v) {
  const bits = [v.status === 'open' ? 'Open' : v.status === 'paused' ? 'Paused' : 'Closed'];
  if (v.offerType) bits.push(label(v.offerType, OFFER_TYPES));
  if (v.price) bits.push(v.price);
  if (v.validUntil) bits.push(`until ${new Date(v.validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`);
  const from = st.places.find((p) => p.uri === v.offeredBy?.uri);
  if (from) bits.push(`From ${from.value?.name}`);
  return bits.join('. ');
}
function renderOffers() {
  const list = [...st.offers].sort((a, b) => String(b.value?.updatedAt || b.value?.createdAt).localeCompare(String(a.value?.updatedAt || a.value?.createdAt)));
  $('offer-list').innerHTML = list.length ? list.map((o) => {
    const v = o.value || {};
    const s = v.status;
    const btns = [
      s === 'open' ? `<button type="button" class="btn btn--quiet" data-status="paused" data-uri="${esc(o.uri)}">Pause</button>` : '',
      s !== 'open' ? `<button type="button" class="btn btn--quiet" data-status="open" data-uri="${esc(o.uri)}">Reopen</button>` : '',
      s !== 'closed' ? `<button type="button" class="btn btn--quiet" data-status="closed" data-uri="${esc(o.uri)}">Close</button>` : '',
      `<button type="button" class="btn btn--quiet" data-edit-offer="${esc(o.uri)}">Edit</button>`,
    ].join('');
    return `<div class="offer-item is-${esc(s)}"><span class="offer-item__title">${v.kind === 'need' ? 'Looking for: ' : ''}${esc(v.title)}</span>
      <span class="offer-item__meta">${esc(offerMeta(v))}</span><div class="actions">${btns}</div></div>`;
  }).join('') : '<p class="hint">No offers yet.</p>';
}
function openOffers() {
  $('offer-form').hidden = true;
  $('offer-new').hidden = false;
  renderOffers();
  show('s-offers');
}
$('offer-list').addEventListener('click', async (e) => {
  const sb = e.target.closest('[data-status]');
  const eb = e.target.closest('[data-edit-offer]');
  if (eb) return openOfferForm(st.offers.find((o) => o.uri === eb.dataset.editOffer));
  if (!sb) return;
  const o = st.offers.find((x) => x.uri === sb.dataset.uri);
  busy(sb, true, 'Saving…');
  try {
    const rec = withStatus(o.value, sb.dataset.status);
    const res = await oauth.putRecord(NSID.offer, rkeyOf(o.uri), rec, o.cid);
    st.offers = st.offers.map((x) => (x.uri === o.uri ? { uri: res.uri, cid: res.cid, value: rec } : x));
    say(sb.dataset.status === 'open' ? 'Reopened.' : sb.dataset.status === 'paused' ? 'Paused. Reopen it whenever you like.' : 'Closed.');
    renderOffers();
  } catch (x) {
    say(friendly(x), { error: true });
    busy(sb, false);
  }
});
function openOfferForm(rec) {
  st.editingOffer = rec;
  const f = offerForm(rec?.value);
  for (const r of document.querySelectorAll('input[name="o-kind"]')) r.checked = r.value === f.kind;
  $('o-from').innerHTML = `<option value="">${st.person ? esc(st.person.value?.name || 'Me') : 'Me'}</option>`
    + st.places.map((p) => `<option value="${esc(p.uri)}">${esc(p.value?.name || 'A place')}</option>`).join('');
  $('o-from').value = f.offeredBy;
  $('o-from-field').hidden = !st.places.length;
  $('o-title').value = f.title;
  $('o-type').innerHTML = '<option value="">Choose</option>' + OFFER_TYPE_CODES.map((c) => `<option value="${c}">${esc(label(c, OFFER_TYPES))}</option>`).join('');
  $('o-type').value = f.offerType;
  $('o-description').value = f.description;
  $('o-price').value = f.price;
  $('o-until').value = f.until;
  areas.areas.set(f.areas);
  $('o-remote').checked = f.remote;
  $('o-link').value = f.link;
  $('offer-form-title').textContent = rec ? 'Edit offer' : 'New offer';
  $('offer-submit').textContent = rec ? 'Publish changes' : 'Publish offer';
  showErrors('oe', [], ['title', 'description', 'price', 'until', 'areas', 'link']);
  $('offer-form').hidden = false;
  $('offer-new').hidden = true;
  $('o-title').focus();
}
$('offer-new').addEventListener('click', () => openOfferForm(null));
$('offer-cancel').addEventListener('click', () => { $('offer-form').hidden = true; $('offer-new').hidden = false; });
$('offer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prev = st.editingOffer;
  const f = { kind: document.querySelector('input[name="o-kind"]:checked').value, offeredBy: $('o-from').value,
    title: $('o-title').value, offerType: $('o-type').value, description: $('o-description').value,
    price: $('o-price').value, until: $('o-until').value, areas: areas.areas.get(),
    remote: $('o-remote').checked, link: $('o-link').value, status: prev?.value?.status || 'open' };
  const errs = validateOffer(f);
  showErrors('oe', errs, ['title', 'description', 'price', 'until', 'areas', 'link']);
  if (errs.length) return;
  const b = $('offer-submit');
  busy(b, true, 'Publishing…');
  try {
    const rec = offerRecord(f, prev?.value);
    const res = prev
      ? await oauth.putRecord(NSID.offer, rkeyOf(prev.uri), rec, prev.cid)
      : await oauth.createRecord(NSID.offer, rec);
    const entry = { uri: res.uri, cid: res.cid, value: rec };
    st.offers = prev ? st.offers.map((o) => (o.uri === prev.uri ? entry : o)) : [entry, ...st.offers];
    say(prev ? 'Offer updated.' : 'Offer published. It shows on your entry in the catalogue.');
    openOffers();
  } catch (x) {
    say(friendly(x), { error: true });
  } finally {
    busy(b, false);
  }
});

/* ---------- done ---------- */
function done(uri, text) {
  say('');
  $('done-text').textContent = text;
  $('done-view').href = `/?u=${encodeURIComponent(uri)}&fresh=${encodeURIComponent(oauth.session().did)}`;
  renderChoose();
  show('s-done');
}
$('done-offers').addEventListener('click', openOffers);
$('done-more').addEventListener('click', () => { renderChoose(); show('s-choose'); });

/* ---------- start ---------- */
async function start() {
  ticks($('l-types'), 'l-types', SPACE_TYPE_CODES, SPACE_TYPES, 'checkbox');
  ticks($('l-access'), 'l-access', ACCESS_CODES, ACCESS, 'radio');
  $('l-access').addEventListener('change', accessChanged);
  st.gaz = await loadGazetteer('/gazetteer/dist');
  for (const el of document.querySelectorAll('[data-areas]')) areas[el.dataset.areas] = areaList(el, Number(el.dataset.max));

  if (oauth.pendingCallback()) {
    say('Finishing sign-in…');
    try {
      await oauth.completeLogin();
      say('');
    } catch (x) {
      say(`Sign-in didn’t finish: ${x.message}.`, { error: true });
    }
  }
  const s = oauth.session();
  if (!s) return show('s-signin', { push: false });
  st.me = s;
  $('who-handle').textContent = `Signed in as @${s.handle}`;
  $('who-bar').hidden = false;
  try {
    await loadMine();
  } catch (x) {
    say(`Couldn’t read your account: ${x.message}.`, { error: true });
  }
  renderChoose();
  show('s-choose', { push: false });
}

start();
