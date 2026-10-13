// The study screen's keyboard, for a Bluetooth keyboard or a clicker remote: one pure
// function from a key press and what is on screen to the action it stands for, or null
// for a key the screen leaves alone (so it types, or the browser keeps it). A port of the
// Mac's StudyKeyboard.swift `handle(_:in:)` and StudyView's `studyKey(for:)` and
// `handleKeyPress`; study.js does the action.
//
// The rule both keep: no key moves past a question that has not been answered, except
// the explicit skip (⌘→). Once a choice question is answered, only the correct option's
// letter or number moves on, so a reflex press of a wrong one cannot skip the answer unread.
//
// `state` is a plain object:
//   type            'mcq' | 'tf' | 'open', or null when there is no question (finished)
//   revealed        the answer is on screen
//   graded          an outcome is recorded for this showing
//   answerLetter    the correct option's letter, as shown
//   optionLetters   the option letters in shown order
//   hasImage        the question has a picture
//   typingAnswer    the open-answer box has the keyboard
//   pictureOpen     the picture is full screen
//   paused          the pause sheet is up
//   canUndo, canRepeatLater
//
// Actions: 'choose:<letter>', 'advance', 'reveal', 'gradeCorrect', 'gradeWrong',
// 'dontKnow', 'repeatLater', 'skip', 'undo', 'togglePicture', 'escape'.

const isChoice = (type) => type === 'mcq' || type === 'tf';

/** Return's job (and Space's, which clicker remotes send). */
function returnAction(s) {
  if (isChoice(s.type)) return s.revealed ? 'advance' : null;
  if (!s.revealed) return 'reveal';
  // A revealed open question moves on only once it has a grade.
  return s.graded ? 'advance' : null;
}

/** A letter or number picks that option; once revealed, only the correct one moves on. */
function optionAction(letter, s) {
  if (!isChoice(s.type) || !(s.optionLetters ?? []).includes(letter)) return null;
  if (s.revealed) return letter === s.answerLetter ? 'advance' : null;
  return `choose:${letter}`;
}

/** ⌘D: before the reveal on any question; on an open question, also as its grade. */
function dontKnowAction(s) {
  if (!s.revealed) return 'dontKnow';
  if (s.type === 'open' && !s.graded) return 'dontKnow';
  return null;
}

/** What `event` (a keydown) does on the study screen in `state`, or null. */
export function keyAction(event, state) {
  if (!event || !state || event.repeat || event.isComposing) return null;
  const { key } = event;
  if (typeof key !== 'string') return null;
  if (event.altKey) return null;
  // ⌘ on a Mac keyboard, Ctrl on others; both at once is neither.
  if (event.metaKey && event.ctrlKey) return null;
  const command = event.metaKey || event.ctrlKey;
  const s = state;

  if (!s.type) return null; // the session is done: the Exit button is all there is

  // Over the picture, only S and Esc; over the pause sheet, only Esc.
  if (s.pictureOpen) {
    if (command || event.shiftKey) return null;
    if (key === 'Escape') return 'escape';
    if (key.toLowerCase() === 's') return 'togglePicture';
    return null;
  }
  if (s.paused) {
    return key === 'Escape' && !command && !event.shiftKey ? 'escape' : null;
  }

  if (command) {
    if (event.shiftKey) return null;
    const lower = key.toLowerCase();
    // ⌘D has no meaning in the answer box, so the Mac lets it through even there.
    if (lower === 'd') return dontKnowAction(s);
    // ⌘Z and ⌘→ edit the answer while it is being typed.
    if (s.typingAnswer) return null;
    if (lower === 'z') return s.canUndo ? 'undo' : null;
    if (key === 'ArrowRight') return 'skip';
    return null; // ⌘E, ⌘N, ⌘/ and every browser shortcut
  }

  // Shift+Return types a newline; shifted letters are not shortcuts on the Mac either.
  if (event.shiftKey) return null;

  if (key === 'Escape') return 'escape';

  // Typing an answer: Return reveals, everything else is the answer.
  if (s.typingAnswer) return key === 'Enter' ? 'reveal' : null;

  if (key === 'Enter' || key === ' ' || key === 'Spacebar') return returnAction(s);

  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    if (s.type !== 'open' || !s.revealed) return null;
    if (!s.graded) return key === 'ArrowRight' ? 'gradeCorrect' : 'gradeWrong';
    // Graded and holding for Repeat later: → is Next, as on the Mac. ← has nothing to do.
    return key === 'ArrowRight' ? 'advance' : null;
  }

  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  // F (flag) and K (tags) are the Mac's; the phone has neither yet. They are still
  // claimed, as on the Mac, so they never pick option F or K.
  if (lower === 'f' || lower === 'k') return null;
  if (lower === 'r') return s.canRepeatLater ? 'repeatLater' : null;
  // S is the picture only when there is one; otherwise it is option S.
  if (lower === 's' && s.hasImage) return 'togglePicture';

  if (lower >= '1' && lower <= '9') {
    const letter = (s.optionLetters ?? [])[Number(lower) - 1];
    return letter ? optionAction(letter, s) : null;
  }
  if (lower >= 'a' && lower <= 'z') return optionAction(lower.toUpperCase(), s);
  return null;
}
