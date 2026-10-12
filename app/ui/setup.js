// The setup sheet: a bottom sheet over the library with the Mac's choices for a session
// (QVaultApp/Session/SessionSetupSheet.swift), sized for a thumb. Every change is saved
// for the bank (or pool) straight away. Start, Resume and Start fresh hand off to
// setupLogic.startStudy and route to Study. The rules live in setupLogic.js.

import { el, pillButton, plural } from './components.js';
import { delayMode } from '../engine/settings.js';
import {
  loadSetup, saveSettings, startStudy, tagOptions, tagHint, inScopeCount, rangeBounds,
  effectiveSettings, recordedAnswers, subtitle, delayOf, delayHint, DELAY_BOUNDS,
} from './setupLogic.js';

const SCOPE_OPTIONS = [
  ['all', 'All'],
  ['unseen', 'Unseen'],
  ['missed', 'Missed'],
  ['flagged', 'Flagged'],
  ['range', 'Range'],
];

const SCOPE_HINTS = {
  all: 'Everything.',
  unseen: "Only ones I've never seen.",
  missed: "Only ones I've gotten wrong before.",
  flagged: 'Only flagged.',
  range: 'Questions from one position to another, counted after the tags.',
};

/** `{paths}` → the sheet's state, kept on `state.setup` so a redraw keeps it. */
export function newSetupState(paths) {
  return { paths, data: null, settings: null, confirming: false, starting: false, error: null, amounts: null, shown: false };
}

// ---------------------------------------------------------------------------------------
// Controls

/** A segmented control: one 44px segment per option, the chosen one filled. */
function segmented(label, options, selected, onPick) {
  const group = el('div', 'seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const on = value === selected;
    const button = el('button', on ? 'seg-option seg-on' : 'seg-option', text);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(on));
    button.addEventListener('click', () => {
      if (!on) onPick(value);
    });
    group.append(button);
  }
  return group;
}

/** A number with a minus and a plus, both 44px, then a unit. */
function stepper({ value, min, max, unit, label, onChange }) {
  const row = el('div', 'stepper');
  if (label) row.append(el('span', 'stepper-label', label));
  const minus = pillButton({ label: '−', style: 'secondary', disabled: value <= min, onTap: () => onChange(Math.max(value - 1, min)) });
  minus.setAttribute('aria-label', `Fewer ${unit}`);
  const plus = pillButton({ label: '+', style: 'secondary', disabled: value >= max, onTap: () => onChange(Math.min(value + 1, max)) });
  plus.setAttribute('aria-label', `More ${unit}`);
  const number = el('span', 'stepper-value', String(value));
  number.setAttribute('aria-live', 'polite');
  row.append(minus, number, plus);
  if (unit) row.append(el('span', 'stepper-unit', unit));
  return row;
}

/** Long tags are often file names: keep the start and, above all, the end. */
function middleTrim(name, limit = 32) {
  if (name.length <= limit) return name;
  const tail = Math.ceil((limit - 1) * 0.55);
  return `${name.slice(0, limit - 1 - tail)}…${name.slice(-tail)}`;
}

function tagChip(option, on, onToggle) {
  const chip = el('button', on ? 'chip chip-on' : 'chip');
  chip.type = 'button';
  chip.setAttribute('aria-pressed', String(on));
  chip.title = option.name;
  chip.append(el('span', 'chip-name', middleTrim(option.name)), el('span', 'chip-count', String(option.count)));
  chip.addEventListener('click', onToggle);
  return chip;
}

function section(title, ...children) {
  const node = el('section', 'sheet-section');
  node.append(el('h3', 'section-label', title), ...children);
  return node;
}

/** Built into the queue at the start, so frozen while a saved session is picked back up. */
function lock(node) {
  node.classList.add('section-locked');
  node.inert = true;
  node.setAttribute('aria-disabled', 'true');
  return node;
}

// ---------------------------------------------------------------------------------------
// The sheet

export async function renderSetup(root, { store, state, actions }) {
  const setup = state.setup;
  if (!setup) return;
  if (!setup.data) {
    try {
      setup.data = await loadSetup(store, setup.paths);
    } catch (error) {
      state.setup = null;
      state.route = 'library';
      state.error = `Could not open that bank: ${error?.message || error}`;
      actions.render();
      return;
    }
    if (state.setup !== setup) return; // closed while loading
    setup.settings = setup.data.settings;
    // Remembered per unit while the sheet is open, so Questions → Minutes → Questions
    // comes back to the number picked, not a default.
    const mode = delayMode(setup.settings.delay);
    setup.amounts = {
      questions: mode === 'questions' ? setup.settings.delay.questions : DELAY_BOUNDS.questions.default,
      minutes: mode === 'minutes' ? setup.settings.delay.minutes : DELAY_BOUNDS.minutes.default,
    };
  }
  drawSheet(root, { store, state, actions });
}

function drawSheet(root, context) {
  const { store, state, actions } = context;
  const setup = state.setup;
  const { data } = setup;
  const redraw = () => drawSheet(root, context);

  const change = (patch) => {
    setup.settings = { ...setup.settings, ...patch };
    setup.error = null;
    saveSettings(store, data.key, setup.settings).catch((error) => {
      setup.error = `Could not remember these choices: ${error?.message || error}`;
      redraw();
    });
    redraw();
  };

  const close = () => {
    state.setup = null;
    state.route = 'library';
    actions.render();
  };

  const start = async (mode) => {
    if (setup.starting) return;
    setup.starting = true;
    setup.error = null;
    redraw();
    try {
      const session = await startStudy({
        store,
        paths: data.paths,
        settings: setup.settings,
        mode,
        onSaveError: (error) => {
          if (state.session) state.session.model.saveError = error;
          state.saveError = `Could not save your progress: ${error?.message || error}`;
          actions.render();
        },
      });
      state.session = session;
      state.setup = null;
      state.banks = null; // the library reads progress again when it is next shown
      state.route = 'study';
      actions.render();
    } catch (error) {
      setup.starting = false;
      setup.error = `Could not start: ${error?.message || error}`;
      redraw();
    }
  };

  const { questions, session } = data;
  const settings = setup.settings;
  const resuming = session !== null && !setup.confirming;
  // While resuming, the frozen sections show what the saved session was built from.
  const shown = resuming
    ? { ...settings, scope: session.settings.scope, rangeLower: session.settings.rangeLower, rangeUpper: session.settings.rangeUpper, tags: session.settings.tags }
    : settings;
  const effective = effectiveSettings(questions, shown);
  const inScope = inScopeCount(questions, effective);
  const total = questions.length;

  // ---- header
  const head = el('header', 'sheet-head');
  const heading = el('div', 'sheet-heading');
  const title = el('h2', 'sheet-title', data.title);
  title.id = 'sheet-title';
  heading.append(
    title,
    el('p', 'sheet-subtitle', subtitle({ total, inScope, resuming, remaining: session ? session.queue.length : null })),
  );
  head.append(heading, pillButton({ label: 'Close', style: 'ghost', onTap: close }));

  // ---- body
  const body = el('div', 'sheet-body');

  const scopeParts = [
    segmented('Which questions', SCOPE_OPTIONS, shown.scope, (scope) => change({ scope })),
    el('p', 'hint', SCOPE_HINTS[shown.scope]),
  ];
  if (shown.scope === 'range') {
    const bounds = rangeBounds(questions, shown);
    const range = el('div', 'range');
    range.append(
      stepper({
        label: 'From', value: bounds.lower, min: Math.min(1, bounds.max), max: bounds.upper, unit: `of ${bounds.max}`,
        onChange: (value) => change({ rangeLower: value }),
      }),
      stepper({
        label: 'To', value: bounds.upper, min: bounds.lower, max: bounds.max, unit: `of ${bounds.max}`,
        onChange: (value) => change({ rangeUpper: value }),
      }),
    );
    scopeParts.push(range);
  }
  const scopeSection = section('Which questions', ...scopeParts);
  if (resuming) {
    lock(scopeSection);
    scopeSection.append(el('p', 'hint hint-locked', 'Picked when this session started. Start fresh to change it.'));
  }
  body.append(scopeSection);

  const options = tagOptions(questions);
  if (options.length > 0) {
    const chips = el('div', 'chips');
    for (const option of options) {
      const on = shown.tags.includes(option.name);
      chips.append(tagChip(option, on, () => {
        const tags = on ? settings.tags.filter((t) => t !== option.name) : [...settings.tags, option.name].sort();
        change({ tags });
      }));
    }
    const tagSection = section('Tags', chips, el('p', 'hint', tagHint(shown, options)));
    if (resuming) lock(tagSection);
    body.append(tagSection);
  }

  body.append(section('Order', segmented('Order', [['shuffle', 'Shuffle'], ['original', 'CSV order']], settings.order, (order) => change({ order }))));

  const mode = delayMode(settings.delay);
  const delayParts = [
    segmented('Repeat missed after', [['questions', 'Questions'], ['minutes', 'Minutes'], ['endOfSet', 'End of set']], mode, (next) => {
      change({ delay: delayOf(next, setup.amounts[next]) });
    }),
  ];
  if (mode !== 'endOfSet') {
    const bounds = DELAY_BOUNDS[mode];
    delayParts.push(stepper({
      value: settings.delay[mode], min: bounds.min, max: bounds.max, unit: mode === 'minutes' ? 'minutes' : 'questions',
      onChange: (value) => {
        setup.amounts[mode] = value;
        change({ delay: delayOf(mode, value) });
      },
    }));
  }
  delayParts.push(el('p', 'hint', delayHint(settings.delay)));
  body.append(section('Repeat missed after', ...delayParts));

  body.append(section('Retire after getting it right', segmented(
    'Retire after getting it right', [[1, '1×'], [2, '2× in a row'], [3, '3× in a row']], settings.retireThreshold,
    (retireThreshold) => change({ retireThreshold }),
  )));

  body.append(section('Stop after', segmented(
    'Stop after', [[null, 'No limit'], [25, '25'], [50, '50']], settings.maxQuestions,
    (maxQuestions) => change({ maxQuestions }),
  )));

  body.append(section('Answer choices',
    segmented('Answer choices', [[true, 'Shuffle'], [false, 'As written']], settings.shuffleOptions, (shuffleOptions) => change({ shuffleOptions })),
    el('p', 'hint', settings.shuffleOptions
      ? 'A new order every time a question comes up. "All of the above" stays put.'
      : 'The order the file has them in.'),
  ));

  // ---- footer
  const foot = el('footer', 'sheet-foot');
  if (setup.error) foot.append(el('p', 'sheet-error', setup.error));
  const row = el('div', 'sheet-actions');
  const busy = setup.starting;
  if (session === null) {
    row.append(pillButton({ label: 'Start', style: 'primary', disabled: busy || inScope === 0, onTap: () => start('start') }));
  } else if (!setup.confirming) {
    const recorded = recordedAnswers(data.banks.flatMap((bank) => bank.questions));
    row.append(
      pillButton({
        label: 'Start fresh',
        style: 'secondary',
        disabled: busy,
        onTap: () => {
          if (recorded > 0) {
            setup.confirming = true;
            redraw();
          } else {
            start('fresh');
          }
        },
      }),
      pillButton({ label: 'Resume', style: 'primary', disabled: busy, onTap: () => start('resume') }),
    );
  } else {
    const recorded = recordedAnswers(data.banks.flatMap((bank) => bank.questions));
    foot.append(el('p', 'sheet-warn', `This erases ${plural(recorded, 'recorded answer')}${data.banks.length > 1 ? ' across these banks' : ''}, so mastery begins from nothing.`));
    row.append(
      pillButton({
        label: 'Cancel',
        style: 'secondary',
        disabled: busy,
        onTap: () => {
          setup.confirming = false;
          redraw();
        },
      }),
      pillButton({ label: 'Erase and start', style: 'bad', disabled: busy || inScope === 0, onTap: () => start('fresh') }),
    );
  }
  foot.append(row);

  // ---- assemble, keeping the scroll position across redraws
  const previous = root.querySelector('.sheet-layer');
  const keepScroll = previous?.querySelector('.sheet-body')?.scrollTop ?? 0;

  const layer = el('div', setup.shown ? 'sheet-layer' : 'sheet-layer sheet-enter');
  const scrim = el('div', 'sheet-scrim');
  scrim.setAttribute('aria-hidden', 'true');
  scrim.addEventListener('click', close);
  const sheet = el('div', 'sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  sheet.append(el('div', 'sheet-grabber'), head, body, foot);
  layer.append(scrim, sheet);

  if (previous) previous.replaceWith(layer);
  else root.append(layer);
  if (keepScroll) body.scrollTop = keepScroll;
  setup.shown = true;

  // The library under the sheet is out of reach while it is open.
  root.querySelector('.screen')?.setAttribute('inert', '');
}
