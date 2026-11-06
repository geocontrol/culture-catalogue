/* An accessible area combobox over the gazetteer, used by the directory's
 * area filter and by the join forms (based in, active in, offer areas).
 *
 *   const p = areaPicker({ input, list, clear, gaz, onPick })
 *   p.set(hitOrNull)   // show a chosen area
 *
 * Keyboard: ↓/↑ move, Enter picks, Escape closes. Villages load on demand
 * the first time a search finds little in the core file.
 */
import { searchAreasDeep } from '../gazetteer/areas.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uid = 0;

export function areaPicker({ input, list, clear, gaz, onPick, keepText = true }) {
  let hits = [];
  let active = -1;
  let seq = 0;
  const id = `ap${++uid}`;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const paint = () => {
    list.innerHTML = hits.map((h, i) =>
      `<li role="option" id="${id}-${i}" aria-selected="${i === active}"><span>${esc(h.label)}</span><small>${esc(h.kindLabel)}</small></li>`).join('');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
  };
  const pick = (i) => {
    const h = hits[i];
    if (!h) return;
    input.value = keepText ? h.label : '';
    if (clear) clear.hidden = !keepText;
    close();
    onPick(h);
  };

  input.addEventListener('input', async () => {
    const mine = ++seq;
    const q = input.value;
    if (clear) clear.hidden = !q;
    if (q.trim().length < 2) { hits = []; close(); return; }
    const found = await searchAreasDeep(gaz, q, { limit: 8 });
    if (mine !== seq) return; // a later keystroke won
    hits = found;
    active = hits.length ? 0 : -1;
    if (!hits.length) {
      list.innerHTML = '<li role="option" aria-disabled="true"><span>No area by that name</span></li>';
    } else paint();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden || !hits.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % hits.length; paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + hits.length) % hits.length; paint(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(active); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[id]');
    if (li) { e.preventDefault(); pick(Number(li.id.split('-').pop())); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  clear?.addEventListener('click', () => {
    input.value = ''; clear.hidden = true; hits = []; close(); onPick(null); input.focus();
  });

  return {
    set(hit) {
      input.value = hit ? hit.label : '';
      if (clear) clear.hidden = !hit;
    },
  };
}
