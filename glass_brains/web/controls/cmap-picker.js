/**
 * cmap-picker.js — a per-overlay colormap picker with PREVIEWS.
 *
 * A fixed-width trigger button shows the current map's NAME (so a long name never shifts
 * the rest of the row); clicking opens a scrollable popup listing every colormap (grouped
 * by category) each with a gradient SWATCH preview. ‹ › steppers cycle. Swatches are drawn
 * from the loaded colormaps Map via sampleLUT (sRGB), so no new assets/deps. The previews
 * live ONLY in the popup. A hidden <select class="cmap-mirror">
 * stays synced to the value (screen-reader fallback + a stable automation/test hook).
 *
 * Replaces the bare native <select>; the apply path (onChange → set+recolor) is unchanged.
 * A future custom-colormap builder can inject a LUT via colormaps.set(name, {...}) and the
 * picker will list it.
 */
import { sampleLUT } from '../core/colormap.js';

const SW = 64, SH = 12;   // swatch bitmap px
const swatchCache = new Map();   // name -> ImageData (shared across rows/triggers)

function swatchData(ctx, cmap, name) {
    let img = swatchCache.get(name);
    if (img) return img;
    img = ctx.createImageData(SW, SH);
    for (let x = 0; x < SW; x++) {
        const [r, g, b] = sampleLUT(cmap, x / (SW - 1));   // sRGB 0..1
        const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
        for (let y = 0; y < SH; y++) { const k = (y * SW + x) * 4; img.data[k] = R; img.data[k + 1] = G; img.data[k + 2] = B; img.data[k + 3] = 255; }
    }
    swatchCache.set(name, img);
    return img;
}
function drawSwatch(canvas, cmap, name) {
    canvas.width = SW; canvas.height = SH;
    if (!cmap) return;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(swatchData(ctx, cmap, name), 0, 0);
}

// Ordered, category-grouped name list (mirrors populateCmap's grouping in bind.js).
function orderedItems(colormaps) {
    const byCat = {};
    for (const [name, m] of colormaps) (byCat[m.category] ||= []).push(name);
    const out = [];
    for (const cat of Object.keys(byCat).sort())
        for (const name of byCat[cat].sort()) out.push({ name, cat });
    return out;
}

export function createCmapPicker({ colormaps, value, onChange }) {
    const items = orderedItems(colormaps);
    const names = items.map((it) => it.name);
    let idx = Math.max(0, names.indexOf(value));
    let cur = names[idx] ?? value;

    const wrap = document.createElement('span'); wrap.className = 'cmap-picker';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'btn cmap-nav'; prev.textContent = '‹'; prev.title = 'Previous colormap';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'btn cmap-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    // Trigger shows the NAME only, in a fixed-width box (so a long map name never shifts the
    // rest of the row). The gradient swatches live in the popup.
    const tName = document.createElement('span'); tName.className = 'cmap-name';
    trigger.append(tName);
    const next = document.createElement('button'); next.type = 'button'; next.className = 'btn cmap-nav'; next.textContent = '›'; next.title = 'Next colormap';
    // hidden mirror <select>: keeps value reflected for a11y + automation (the .overlay-row select hook).
    const mirror = document.createElement('select'); mirror.className = 'cmap-mirror'; mirror.tabIndex = -1; mirror.setAttribute('aria-hidden', 'true');
    for (const { name } of items) { const o = document.createElement('option'); o.value = name; o.textContent = name; mirror.appendChild(o); }
    wrap.append(prev, trigger, next, mirror);

    function refresh() {
        tName.textContent = cur;
        if (names.includes(cur)) mirror.value = cur;
        trigger.dataset.cmap = cur;
        trigger.title = cur;
    }
    function setValue(name, fire = false) { const i = names.indexOf(name); if (i >= 0) idx = i; cur = name; refresh(); if (fire) onChange(cur); }
    function step(d) { if (!names.length) return; idx = (idx + d + names.length) % names.length; cur = names[idx]; refresh(); onChange(cur); }
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));

    // popup (appended to <body>, position:fixed so the bottom control-bar overflow can't clip it)
    let pop = null;
    function onDoc(e) { if (!e.target.closest('.cmap-popup, .cmap-trigger')) close(); }
    function close() { if (pop) { pop.remove(); pop = null; } document.removeEventListener('click', onDoc, true); trigger.setAttribute('aria-expanded', 'false'); }
    function open() {
        if (pop) { close(); return; }
        pop = document.createElement('div'); pop.className = 'cmap-popup'; pop.setAttribute('role', 'listbox');
        let cat = null;
        for (const it of items) {
            if (it.cat !== cat) { cat = it.cat; const h = document.createElement('div'); h.className = 'cmap-cat'; h.textContent = cat; pop.appendChild(h); }
            const row = document.createElement('button'); row.type = 'button'; row.className = 'cmap-item' + (it.name === cur ? ' sel' : ''); row.dataset.name = it.name;
            const sw = document.createElement('canvas'); sw.className = 'cmap-swatch'; drawSwatch(sw, colormaps.get(it.name), it.name);
            const nm = document.createElement('span'); nm.className = 'cmap-name'; nm.textContent = it.name;
            row.append(sw, nm);
            row.addEventListener('click', () => { setValue(it.name, true); close(); });
            pop.appendChild(row);
        }
        document.body.appendChild(pop);
        const r = trigger.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
        const above = r.top - pop.offsetHeight - 4;
        pop.style.top = (above >= 0 ? above : r.bottom + 4) + 'px';   // prefer above (controls sit at the bottom)
        pop.querySelector('.cmap-item.sel')?.scrollIntoView({ block: 'nearest' });
        trigger.setAttribute('aria-expanded', 'true');
        setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    }
    trigger.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
        else if (e.key === 'Escape') close();
    });

    refresh();
    return { el: wrap, setValue, getValue: () => cur, step };
}
