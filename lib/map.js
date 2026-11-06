/* The map view: MapLibre, loaded only when someone opens the map, over
 * OpenFreeMap's free vector tiles (no key, no tracking).
 *
 * Places are pins at their own address. People are drawn as one counted
 * circle per area they are based in, at the area's public centroid, so no
 * person is ever located more precisely than the area they chose.
 */
const MAPLIBRE = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const UK = [[-8.2, 49.8], [1.9, 58.7]];

let loading = null;
function loadLibrary() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${MAPLIBRE}.css`;
      document.head.append(css);
      const js = document.createElement('script');
      js.src = `${MAPLIBRE}.js`;
      js.onload = () => resolve(window.maplibregl);
      js.onerror = () => reject(new Error('the map library didn’t load'));
      document.head.append(js);
    });
  }
  return loading;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createMap(el, { onOpen, onArea }) {
  let map = null;
  let markers = [];
  let ready = null;

  async function ensure() {
    if (ready) return ready;
    ready = loadLibrary().then((ml) => new Promise((resolve) => {
      map = new ml.Map({ container: el, style: STYLE, bounds: UK, attributionControl: { compact: true },
        cooperativeGestures: true });
      map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
      map.on('load', () => resolve(ml));
    }));
    return ready;
  }

  async function show({ pins, areas }, people) {
    const ml = await ensure();
    markers.forEach((m) => m.remove());
    markers = [];
    const bounds = new ml.LngLatBounds();
    for (const a of areas) {
      const size = Math.min(56, 26 + a.count * 4);
      const b = document.createElement('button');
      b.className = 'areamark';
      b.type = 'button';
      b.style.width = b.style.height = `${size}px`;
      b.textContent = a.count;
      b.setAttribute('aria-label', `${a.count} ${a.count === 1 ? 'person' : 'people'} based in ${a.label}`);
      const names = a.people.map((id) => people.get(id)).filter(Boolean);
      const popup = new ml.Popup({ offset: size / 2, closeButton: true }).setDOMContent((() => {
        const d = document.createElement('div');
        d.innerHTML = `<strong>${esc(a.label)}</strong><ul>${names.map((n) =>
          `<li><button class="linkish" type="button" data-id="${esc(n.id)}">${esc(n.name)}</button></li>`).join('')}</ul>`
          + (a.code ? `<p><button class="linkish" type="button" data-area="${esc(a.code)}">Show everyone in ${esc(a.label)}</button></p>` : '');
        d.addEventListener('click', (e) => {
          const t = e.target.closest('button');
          if (t?.dataset.id) onOpen(t.dataset.id);
          if (t?.dataset.area) onArea(t.dataset.area);
        });
        return d;
      })());
      markers.push(new ml.Marker({ element: b }).setLngLat([a.lng, a.lat]).setPopup(popup).addTo(map));
      bounds.extend([a.lng, a.lat]);
    }
    for (const p of pins) {
      const b = document.createElement('button');
      b.className = 'pin';
      b.type = 'button';
      b.setAttribute('aria-label', `${p.name}${p.types.length ? `, ${p.types.join(', ')}` : ''}`);
      b.addEventListener('click', () => onOpen(p.id));
      markers.push(new ml.Marker({ element: b }).setLngLat([p.lng, p.lat]).addTo(map));
      bounds.extend([p.lng, p.lat]);
    }
    map.resize();
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
    else map.fitBounds(UK, { duration: 0 });
  }

  return { show };
}
