// The study screen's brain: owns the session engine, times each question, and saves after
// every change. A port of the Mac's StudyModel (QVaultApp/Session/StudyModel.swift);
// inventory §2 "App wrapper rules" is the rulebook.
//
// `persist(set)` is handed `engine.persistableSet()` wherever the Mac saves, with the
// session stopwatch brought up to date first. A failed save is kept in `saveError`, never
// thrown, and cleared by the next save that works. `remove(id)` is called before a question
// is deleted, so the store can back up and take it out of the bank that owns it.

import { startSession, resumeSession } from './sessionEngine.js';
import { identity, shuffled, present, writtenLetter } from './optionOrder.js';
import { keywordHits } from './keywords.js';

const msBetween = (from, to) => Math.trunc(to.getTime() - from.getTime());

export function createStudyModel({
  set,
  settings,
  resume: resumeSaved = false,
  now = () => new Date(),
  random = Math.random,
  persist = () => {},
  remove = () => {},
  orderOptions = (question) => shuffled(question, random),
}) {
  const engine = resumeSaved && set.session
    ? resumeSession(set, set.session, settings, now(), random)
    : startSession(set, settings, now(), random);

  // The question on screen, as written. A copy taken when it came up, not a live read of
  // the engine: an answer retires or requeues at once, so by the time grading returns the
  // engine is already on the next question, and its own copy has the new attempt in it.
  let currentQuestion = null;
  // Position i on screen shows written option displayOrder[i]. Drawn fresh each time a
  // question comes up and held while it stays on screen.
  let displayOrder = [];

  const start = now();
  let questionStartedAt = start;
  let pausedAt = null;
  const activeMsBeforeThisSitting = engine.state.activeMs ?? 0;
  const sittingStartedAt = start;
  let pausedThisSittingMs = 0;

  // The ms just recorded, kept here because the engine has moved on by the time
  // repeatLater runs.
  let lastAnswerMs = null;
  // The open question's time, frozen at the moment it was revealed (the answer was in).
  let revealedAtMs = null;

  const copy = (q) => (q ? structuredClone(q) : null);
  const liveQuestion = (id) => engine.set.questions.find((q) => q.id === id) ?? null;

  function order(question) {
    if (!question) return [];
    return engine.state.settings.shuffleOptions ? orderOptions(question) : identity(question);
  }

  function presentCurrent() {
    currentQuestion = copy(engine.current());
    displayOrder = order(currentQuestion);
  }

  /** Measured to the pause, so time spent paused never counts. */
  function elapsedMs() {
    return Math.max(0, msBetween(questionStartedAt, pausedAt ?? now()));
  }

  /** Records against the engine. Does not save: callers save once, after everything. */
  function record(outcome, chose) {
    const ms = revealedAtMs ?? elapsedMs();
    engine.answer(outcome, chose, ms, now());
    model.lastOutcome = outcome;
    lastAnswerMs = ms;
  }

  function resetForNextQuestion() {
    model.revealed = false;
    model.chosen = null;
    model.typedAnswer = '';
    model.lastOutcome = null;
    model.hits = [];
    lastAnswerMs = null;
    revealedAtMs = null;
    questionStartedAt = now();
    // A new question is never handed over already paused.
    pausedAt = null;
    presentCurrent();
  }

  function save() {
    try {
      // The stopwatch goes into the file too, so a resume tomorrow carries on from here.
      engine.recordActiveTime(model.activeMs(now()));
      persist(engine.persistableSet());
      model.saveError = null;
    } catch (error) {
      model.saveError = error;
    }
  }

  const model = {
    revealed: false,
    /** The letter chosen, as shown on screen. */
    chosen: null,
    typedAnswer: '',
    lastOutcome: null,
    /** `[{keyword, hit}]` for an open question, filled in at reveal. */
    hits: [],
    saveError: null,

    /** Writes the session now, stopwatch included, without touching the pause. For leaving the screen. */
    save() {
      save();
    },

    // MARK: Reading

    /** The question as shown: options in this showing's order, answer letter moved. */
    get current() {
      return currentQuestion ? present(currentQuestion, displayOrder) : null;
    },

    /** The question as written in the file. What an editor or note sheet is given. */
    get currentAsWritten() {
      return currentQuestion;
    },

    get displayOrder() {
      return displayOrder;
    },

    /** `chosen`, as the file's letter. History is keyed by written letters. */
    get chosenAsWritten() {
      if (model.chosen === null || model.chosen === undefined || !currentQuestion) return model.chosen;
      return writtenLetter(model.chosen, currentQuestion, displayOrder) ?? model.chosen;
    },

    /** When the question now on screen was shown (moved on by pauses). */
    get questionStarted() {
      return questionStartedAt;
    },

    /** The time recorded for this answer, or for an open question the time at reveal. */
    get recordedMs() {
      return lastAnswerMs ?? revealedAtMs;
    },

    get isPaused() {
      return pausedAt !== null;
    },

    /** What the question clock shows instead of running: the recorded time or the pause. */
    get frozenMs() {
      const recorded = model.recordedMs;
      if (recorded !== null) return recorded;
      if (pausedAt === null) return null;
      return Math.max(0, msBetween(questionStartedAt, pausedAt));
    },

    get canRestartQuestionTimer() {
      return currentQuestion !== null && model.recordedMs === null;
    },

    get canUndo() {
      return engine.canUndo();
    },

    /** Only right after a correct answer. */
    get canRepeatLater() {
      return model.lastOutcome === 'correct';
    },

    get setName() {
      return engine.set.name;
    },

    /** The session stopwatch: saved time plus this sitting, less pauses. Holds while paused. */
    activeMs(date) {
      const end = pausedAt ?? date;
      const thisSitting = msBetween(sittingStartedAt, end) - pausedThisSittingMs;
      return activeMsBeforeThisSitting + Math.max(0, thisSitting);
    },

    /** The question clock as of `date`; holds at the pause while paused. */
    questionElapsedMs(date) {
      return Math.max(0, msBetween(questionStartedAt, pausedAt ?? date));
    },

    progress() {
      const { cleared, repeating, total } = engine.counts();
      return { cleared, repeating, total };
    },

    isFinished() {
      return engine.isFinished();
    },

    // MARK: Answering

    /** Grades the shown letter against the shown answer, records the written letter, reveals. */
    choose(letter) {
      const shown = model.current;
      // Once revealed, a second tap must not grade the engine's next question. The Mac's
      // view gates this; on a phone a double-tap is easy, so the model gates it too.
      if (!shown || model.revealed) return;
      model.chosen = letter;
      model.revealed = true;
      record(letter === shown.answer ? 'correct' : 'wrong', model.chosenAsWritten);
      save();
    },

    /** Shows an open question's answer and freezes its clock. Never grades or advances. */
    reveal() {
      model.revealed = true;
      revealedAtMs = elapsedMs();
      if (currentQuestion?.type === 'open') {
        model.hits = keywordHits(model.typedAnswer, currentQuestion.keywords ?? []);
      }
    },

    /** Grades a revealed open question. Anything but correct moves on at once. */
    grade(outcome) {
      if (!model.revealed || model.lastOutcome !== null) return;
      record(outcome, null);
      if (outcome !== 'correct') resetForNextQuestion();
      save();
    },

    /** Records "don't know" with no choice and reveals. Does not advance. */
    dontKnow() {
      if (model.revealed) return;
      model.revealed = true;
      revealedAtMs = elapsedMs();
      if (currentQuestion?.type === 'open') {
        model.hits = keywordHits(model.typedAnswer, currentQuestion.keywords ?? []);
      }
      record('dontknow', null);
      save();
    },

    /** Turns the last correct answer into shaky: undo, then answer again with the same choice and time. */
    repeatLater() {
      if (!model.canRepeatLater || lastAnswerMs === null) return;
      const ms = lastAnswerMs;
      const chose = model.chosenAsWritten;
      engine.undoLastAnswer();
      engine.answer('shaky', chose, ms, now());
      model.lastOutcome = 'shaky';
      lastAnswerMs = ms;
      save();
    },

    // MARK: The clock

    /** Stops the clock. Pausing twice keeps the first moment. */
    pause() {
      if (pausedAt !== null) return;
      pausedAt = now();
    },

    /** Starts the clock again with the whole pause discounted. */
    resume() {
      if (pausedAt === null) return;
      const paused = msBetween(pausedAt, now());
      questionStartedAt = new Date(questionStartedAt.getTime() + paused);
      pausedThisSittingMs += paused;
      pausedAt = null;
    },

    /** Puts this question's clock back to zero, only before its answer is recorded. */
    restartQuestionTimer() {
      if (!model.canRestartQuestionTimer) return;
      questionStartedAt = now();
      if (pausedAt !== null) pausedAt = questionStartedAt;
    },

    // MARK: Moving

    advance() {
      resetForNextQuestion();
      save();
    },

    /** Moves past the engine's current question without recording anything. */
    skip() {
      engine.skip(now());
      resetForNextQuestion();
      save();
    },

    /** Rolls back the last answer and returns to that question. */
    undo() {
      engine.undoLastAnswer();
      resetForNextQuestion();
      save();
    },

    // MARK: Editing

    /** Flips the flag on the question on screen (not the engine's next one). */
    flagCurrent() {
      const id = currentQuestion?.id;
      if (id === undefined) return;
      engine.toggleFlag(id);
      currentQuestion = copy(liveQuestion(id));
      save();
    },

    /** Replaces the question on screen with an edited copy; its id and history are kept. */
    updateCurrentQuestion(edited) {
      const id = currentQuestion?.id;
      if (id === undefined) return;
      if (!engine.update(id, edited)) return;
      currentQuestion = copy(liveQuestion(id));
      // Same showing, same order, unless the edit changed how many options there are.
      if (displayOrder.length !== (currentQuestion?.options?.length ?? 0)) {
        displayOrder = order(currentQuestion);
      }
      save();
    },

    /** Deletes the question on screen for good and moves on. The store is told first. */
    deleteCurrentQuestion() {
      const id = currentQuestion?.id;
      if (id === undefined) return;
      try {
        remove(id);
        model.saveError = null;
      } catch (error) {
        model.saveError = error;
        return;
      }
      engine.removeQuestion(id);
      resetForNextQuestion();
      save();
    },
  };

  presentCurrent();
  return model;
}
