// A question's picture: shown above the prompt, loaded from the phone's cache or from
// Drive, and opened full screen on a tap. Loading never holds the question up: the frame
// says "Loading picture…" and fills itself in when the picture arrives, without a redraw
// of the screen around it. Object URLs are kept per name while the session is on screen
// and let go by `releasePictures()`.

import { el } from './components.js';
import { fetchPicture } from '../sync.js';

/** name → {status: 'loading'|'ready'|'failed', url, width, height, promise} */
const cache = new Map();

/** Loads an image off screen (onload, not decode(): decode can stall on a detached image). */
function measure(url) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe);
    probe.onerror = () => reject(new Error('not a picture'));
    probe.src = url;
  });
}

function load(name, { drive, store }) {
  let entry = cache.get(name);
  if (entry) return entry;
  entry = { status: 'loading', url: null, width: 0, height: 0, promise: null };
  cache.set(name, entry);
  entry.promise = fetchPicture({ drive, store, name })
    .catch(() => null)
    .then(async (blob) => {
      if (cache.get(name) !== entry) return entry; // let go while it was loading
      if (blob) {
        entry.url = URL.createObjectURL(blob);
        // Measured once, so every redraw reserves the picture's height before it has
        // decoded again. Without that the screen is short for a frame, and a scroll to
        // the explanation (or a kept scroll position) lands short.
        try {
          const probe = await measure(entry.url);
          entry.width = probe.naturalWidth;
          entry.height = probe.naturalHeight;
          entry.status = 'ready';
          if (cache.get(name) !== entry) URL.revokeObjectURL(entry.url); // let go meanwhile
        } catch {
          URL.revokeObjectURL(entry.url);
          entry.url = null;
          entry.status = 'failed';
        }
      } else {
        // Retried next time the session is opened, not over and over on this screen.
        entry.status = 'failed';
      }
      return entry;
    });
  return entry;
}

/** Lets every picture go (the study screen was left). */
export function releasePictures() {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
}

function fill(frame, entry, name, onEnlarge) {
  frame.replaceChildren();
  frame.classList.remove('picture-wait', 'picture-failed');
  if (entry.status === 'ready') {
    const button = el('button', 'picture-button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Show the picture full screen');
    const img = el('img', 'picture-img');
    if (entry.width && entry.height) {
      img.width = entry.width;
      img.height = entry.height;
    }
    img.src = entry.url;
    img.alt = name;
    button.append(img);
    button.addEventListener('click', () => onEnlarge(name));
    frame.append(button);
  } else if (entry.status === 'failed') {
    frame.classList.add('picture-failed');
    frame.append(el('p', 'picture-status', 'Picture unavailable'));
  } else {
    frame.classList.add('picture-wait');
    frame.append(el('p', 'picture-status', 'Loading picture…'));
  }
}

/** The picture frame for `name`. `onEnlarge(name)` is called on a tap. */
export function pictureView(name, { drive, store, onEnlarge }) {
  const frame = el('figure', 'picture');
  frame.dataset.name = name;
  const entry = load(name, { drive, store });
  fill(frame, entry, name, onEnlarge);
  if (entry.status === 'loading') {
    entry.promise.then((done) => {
      if (frame.isConnected) fill(frame, done, name, onEnlarge);
    });
  }
  return frame;
}

/** Whether `name` is loaded, so it can be shown full screen. */
export function pictureURL(name) {
  const entry = cache.get(name);
  return entry?.status === 'ready' ? entry.url : null;
}

/**
 * The full-screen view: black, the picture as big as the screen allows, pinch to zoom.
 * A tap or a swipe down closes it (a pinch does not).
 */
export function pictureOverlay(name, { onClose }) {
  const layer = el('div', 'picture-overlay');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', 'Picture, full screen. Tap to close.');
  const url = pictureURL(name);
  if (url) {
    const img = el('img', 'picture-full');
    img.src = url;
    img.alt = name;
    layer.append(img);
  }

  // A one-finger swipe down closes; two fingers (a pinch) never do, and nor does a drag
  // while the page is zoomed in.
  let start = null;
  let pinched = false;
  layer.addEventListener('touchstart', (event) => {
    if (event.touches.length > 1) {
      pinched = true;
      start = null;
      return;
    }
    if (event.touches.length === 1 && !pinched) {
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
  }, { passive: true });
  layer.addEventListener('touchend', (event) => {
    if (event.touches.length > 0) return;
    const began = start;
    start = null;
    if (pinched) {
      pinched = false;
      return;
    }
    if (!began) return;
    const touch = event.changedTouches[0];
    const dy = touch.clientY - began.y;
    const dx = Math.abs(touch.clientX - began.x);
    const zoomed = (globalThis.visualViewport?.scale ?? 1) > 1.01;
    if (!zoomed && dy > 60 && dy > dx) onClose();
  }, { passive: true });
  layer.addEventListener('click', () => onClose());
  return layer;
}
