// Small building blocks shared by the screens: pill buttons, the mastery ring, banners,
// the Q mark, and relative dates. DOM is only touched inside the functions, so this module
// (and relativeDate in particular) also imports in Node.

const SVG = 'http://www.w3.org/2000/svg';

/** An element with a class and optional text. */
export function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** A capsule button at least 44px tall. */
export function pillButton({ label, style = 'primary', onTap = null, disabled = false }) {
  const button = el('button', `pill pill-${style}`, label);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  if (onTap) button.addEventListener('click', (event) => {
    if (!button.disabled) onTap(event);
  });
  return button;
}

let gradientCounter = 0;

/** A <linearGradient> running magenta → violet → accent across its shape's diagonal. */
function primaryGradient(id, span = { x1: 0, y1: 0, x2: 1, y2: 1 }) {
  const gradient = svg('linearGradient', { id, ...span });
  [
    ['0%', '--magenta'],
    ['50%', '--violet'],
    ['100%', '--accent'],
  ].forEach(([offset, token]) => {
    const stop = svg('stop', { offset });
    stop.style.stopColor = `var(${token})`;
    gradient.append(stop);
  });
  return gradient;
}

/**
 * The Mac's mastery ring: a faint track, an arc in the primary gradient sweeping clockwise
 * from 12 o'clock, and the percentage in the middle. `fraction` null draws the empty ring
 * with a dash (never studied, which is not the same as 0%).
 */
export function masteryRing(fraction, size = 44) {
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  const wrap = el('div', 'ring');
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;

  const ring = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });
  const track = svg('circle', { cx: centre, cy: centre, r: radius, fill: 'none', 'stroke-width': stroke });
  track.classList.add('ring-track');
  ring.append(track);

  const known = fraction !== null && fraction !== undefined && Number.isFinite(fraction);
  const clamped = known ? Math.min(Math.max(fraction, 0), 1) : 0;
  if (known && clamped > 0) {
    const id = `ring-gradient-${(gradientCounter += 1)}`;
    const defs = svg('defs');
    defs.append(primaryGradient(id));
    ring.append(defs);
    const circumference = 2 * Math.PI * radius;
    const arc = svg('circle', {
      cx: centre,
      cy: centre,
      r: radius,
      fill: 'none',
      stroke: `url(#${id})`,
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${circumference * clamped} ${circumference}`,
      transform: `rotate(-90 ${centre} ${centre})`,
    });
    ring.append(arc);
  }

  const label = el('span', known ? 'ring-label' : 'ring-label ring-empty', known ? `${Math.round(clamped * 100)}%` : '—');
  wrap.append(ring, label);
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', known ? `Mastery ${Math.round(clamped * 100)} percent` : 'Not studied yet');
  return wrap;
}

/** The QVault mark: a thick ring with a tail, in the primary gradient (same as the icon). */
export function qMark(size = 96) {
  const id = `q-gradient-${(gradientCounter += 1)}`;
  const mark = svg('svg', { width: size, height: size, viewBox: '0 0 100 100', class: 'q-mark', 'aria-hidden': 'true' });
  const defs = svg('defs');
  // One gradient across the whole mark, so the ring and the tail run on from each other.
  defs.append(primaryGradient(id, { gradientUnits: 'userSpaceOnUse', x1: 18, y1: 16, x2: 82, y2: 80 }));
  mark.append(defs);
  // The same geometry as scripts/icons.mjs, so the mark and the home-screen icon agree.
  mark.append(svg('circle', { cx: 48, cy: 46, r: 24.25, fill: 'none', stroke: `url(#${id})`, 'stroke-width': 11.5 }));
  mark.append(svg('line', { x1: 56, y1: 54, x2: 79, y2: 77, stroke: `url(#${id})`, 'stroke-width': 11 }));
  return mark;
}

/** A message strip. `action` is {label, onTap}; the strip is announced to screen readers. */
export function banner({ message, tone = 'bad', action = null }) {
  const strip = el('div', `banner banner-${tone}`);
  strip.setAttribute('role', tone === 'good' ? 'status' : 'alert');
  strip.append(el('span', 'banner-dot'), el('p', 'banner-text', message));
  if (action) strip.append(pillButton({ label: action.label, style: 'secondary', onTap: action.onTap }));
  return strip;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "today", "yesterday", "3 days ago", "2 weeks ago", else a short date in the phone's
 * locale (with the year when it is not this year). Takes a Date or an ISO string; null
 * gives null.
 */
export function relativeDate(date, now = new Date()) {
  if (date === null || date === undefined) return null;
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) return null;
  // Calendar days, rounded so a daylight-saving shift never makes a day 23 or 25 hours.
  const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 28) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  const options = { day: 'numeric', month: 'short' };
  if (when.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return when.toLocaleDateString(undefined, options);
}

/** "1 question" / "5 questions". */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
