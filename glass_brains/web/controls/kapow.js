/**
 * kapow.js — comic-book flair. The whole package renders brains like comic
 * panels, so: on a pointer-down anywhere in the GUI there's a 50% chance a small
 * "BOOM!/POW/THWACK" pops up at the cursor and fades away, like a comic SFX.
 * Toggled by the top-right "Kapow" checkbox.
 */
const IMGS = ['kapow/1.png', 'kapow/2.png', 'kapow/3.png', 'kapow/4.png', 'kapow/5.png'];
IMGS.forEach((s) => { const im = new Image(); im.src = s; });   // preload

export function initKapow(checkbox) {
    document.addEventListener('pointerdown', (e) => {
        if (!checkbox || !checkbox.checked) return;
        if (Math.random() < 0.5) return;                        // ~half the time
        pop(e.clientX, e.clientY);
    }, true);                                                   // capture: fires on any control
}

function pop(x, y) {
    const img = document.createElement('img');
    img.src = IMGS[(Math.random() * IMGS.length) | 0];          // random SFX
    img.className = 'kapow-fx';
    img.style.left = x + 'px';
    img.style.top = y + 'px';
    img.style.width = (64 + Math.random() * 56) + 'px';         // 64–120px — small
    document.body.appendChild(img);
    const rot = Math.random() * 28 - 14;                        // -14°..14° tilt
    const base = `translate(-50%,-50%) rotate(${rot}deg)`;
    img.animate([
        { transform: `${base} scale(0.2)`, opacity: 0 },
        { transform: `${base} scale(1.18)`, opacity: 1, offset: 0.28 },  // overshoot pop
        { transform: `${base} scale(0.96)`, opacity: 1, offset: 0.55 },
        { transform: `${base} scale(1.0)`, opacity: 0 },                  // settle + fade
    ], { duration: 680, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => img.remove();
}
