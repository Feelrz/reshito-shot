// Minimal split-flap counter. Only digits that change flip; the first value rolls in digit by digit.
export function createFlap(root, digits = 6) {
  root.classList.add('flaps');
  const cells = [];
  for (let i = 0; i < digits; i++) {
    const c = document.createElement('span');
    c.className = 'flap';
    c.innerHTML = '<span class="ft"><i>0</i></span><span class="fb"><i>0</i></span><span class="flt"><i>0</i></span><span class="flb"><i>0</i></span>';
    root.appendChild(c);
    cells.push({ el: c, d: '0', q: [], busy: false, parts: [...c.querySelectorAll('i')] });
  }

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function flipTo(cell, to) {
    const [ft, fb, flt, flb] = cell.parts;
    if (reduce) { ft.textContent = fb.textContent = flt.textContent = flb.textContent = to; cell.d = to; return Promise.resolve(); }
    return new Promise((res) => {
      ft.textContent = to;           // top half: new (revealed when the leaf falls)
      fb.textContent = cell.d;       // bottom half: old (covered when the leaf lands)
      flt.textContent = cell.d;      // falling leaf: old top
      flb.textContent = to;          // landing leaf: new bottom
      cell.el.classList.remove('flip'); void cell.el.offsetWidth; cell.el.classList.add('flip');
      setTimeout(() => {
        fb.textContent = to; flt.textContent = to;
        cell.el.classList.remove('flip');
        cell.d = to;
        res();
      }, 230);
    });
  }

  async function run(cell) {
    if (cell.busy) return;
    cell.busy = true;
    while (cell.q.length) await flipTo(cell, cell.q.shift());
    cell.busy = false;
  }

  return {
    set(n, { roll = false } = {}) {
      const max = 10 ** digits - 1;
      const s = String(Math.max(0, Math.min(max, Math.floor(n || 0)))).padStart(digits, '0');
      cells.forEach((cell, i) => {
        const to = s[i];
        const last = cell.q.length ? cell.q[cell.q.length - 1] : cell.d;
        if (to === last) return;
        if (roll) {          // pass through the digits in between, like a real board
          let d = +last;
          const steps = [];
          while (String(d) !== to && steps.length < 10) { d = (d + 1) % 10; steps.push(String(d)); }
          setTimeout(() => { cell.q.push(...steps); run(cell); }, i * 70);
        } else {
          cell.q.push(to); run(cell);
        }
      });
      root.setAttribute('aria-label', `${Number(s)} prints so far`);
    },
  };
}
