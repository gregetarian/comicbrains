/**
 * grid.js — container size + row/col weights → per-cell pixel rectangles. Pure.
 *
 * Produces both the WebGL viewport rect (bottom-left origin) and the CSS rect
 * (top-left origin) from one computation, so the two can never drift apart
 * (the old code computed them in separate functions).
 *
 * All sizes are in CSS pixels; the WebGL renderer scales by pixelRatio itself,
 * so viewport coordinates here are CSS pixels too.
 */

function spans(total, weights, n) {
    const w = (weights && weights.length === n) ? weights : Array(n).fill(1);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    const sizes = w.map((x) => Math.floor((total * x) / sum));
    // distribute rounding remainder to the last cell so spans exactly tile `total`
    const used = sizes.reduce((a, b) => a + b, 0);
    sizes[n - 1] += total - used;
    const starts = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { starts.push(acc); acc += sizes[i]; }
    return { sizes, starts };
}

/**
 * @param {object} g - { width, height, rows, cols, rowWeights?, colWeights? }
 * @returns {{ rect(row,col,rowSpan?,colSpan?): Rect, width, height }}
 *   Rect = { x, y, w, h, cssLeft, cssTop, aspect }  (x,y = GL bottom-left origin)
 */
export function layoutGrid(g) {
    const { width, height, rows, cols } = g;
    const col = spans(width, g.colWeights, cols);
    const row = spans(height, g.rowWeights, rows);

    function rect(r, c, rowSpan = 1, colSpan = 1) {
        const cssLeft = col.starts[c];
        const w = col.sizes.slice(c, c + colSpan).reduce((a, b) => a + b, 0);
        const cssTop = row.starts[r];
        const h = row.sizes.slice(r, r + rowSpan).reduce((a, b) => a + b, 0);
        const y = height - cssTop - h; // GL origin is bottom-left
        return { x: cssLeft, y, w, h, cssLeft, cssTop, aspect: w / h };
    }

    return { rect, width, height };
}
