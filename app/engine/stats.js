// Port of QVaultKit Stats/Stats.swift (inventory section 7).
// A question carries its history in `question.stats.attempts`:
//   {at: Date, outcome: 'correct'|'shaky'|'wrong'|'dontknow', ms: number, chose?: string}

const attemptsOf = (question) => question.stats?.attempts ?? [];

/// Everything the stats screens show for one question.
/// `correct` counts correct plus shaky; `accuracy` is null when never seen;
/// `averageMs` is integer-division (truncated); `distractors` maps a wrong letter
/// to how often it was chosen and never includes `dontknow` attempts.
export function summary(question) {
  const attempts = attemptsOf(question);

  const distractors = {};
  for (const attempt of attempts) {
    if (attempt.outcome !== 'wrong' || attempt.chose == null) continue;
    distractors[attempt.chose] = (distractors[attempt.chose] ?? 0) + 1;
  }

  const count = (outcome) => attempts.filter((a) => a.outcome === outcome).length;
  const shaky = count('shaky');
  const correct = count('correct') + shaky;
  const totalMs = attempts.reduce((sum, a) => sum + a.ms, 0);

  return {
    seen: attempts.length,
    correct,
    wrong: count('wrong'),
    shaky,
    dontKnow: count('dontknow'),
    accuracy: attempts.length === 0 ? null : correct / attempts.length,
    averageMs: attempts.length === 0 ? null : Math.trunc(totalMs / attempts.length),
    lastMs: attempts.length === 0 ? null : attempts[attempts.length - 1].ms,
    distractors,
  };
}

/// At least 3 attempts, then any one of: 3+ wrong, accuracy under 0.4,
/// 2+ shaky, or the latest attempt was "don't know".
export function isTrouble(question) {
  const s = summary(question);
  if (s.seen < 3) return false;
  if (s.wrong >= 3) return true;
  if (s.accuracy !== null && s.accuracy < 0.4) return true;
  if (s.shaky >= 2) return true;
  const attempts = attemptsOf(question);
  return attempts[attempts.length - 1].outcome === 'dontknow';
}

/// Evaluated in order and mutually exclusive: never, trouble, shaky, solid.
export function masteryBand(question) {
  const s = summary(question);
  if (s.seen === 0) return 'never';
  if (isTrouble(question)) return 'trouble';
  if (s.shaky > 0) return 'shaky';
  if (s.accuracy !== null && s.accuracy < 0.8) return 'shaky';
  return 'solid';
}

/// Band counts, flagged count, accuracy pooled over every attempt (never an average
/// of per-question rates), and mastery = solid / total (0 for an empty list).
export function setSummary(questions) {
  const counts = { never: 0, trouble: 0, shaky: 0, solid: 0 };
  let attemptCount = 0;
  let correct = 0;
  let flagged = 0;
  for (const question of questions) {
    counts[masteryBand(question)] += 1;
    if (question.flagged) flagged += 1;
    const s = summary(question);
    attemptCount += s.seen;
    correct += s.correct;
  }
  return {
    total: questions.length,
    ...counts,
    flagged,
    accuracy: attemptCount === 0 ? null : correct / attemptCount,
    mastery: questions.length === 0 ? 0 : counts.solid / questions.length,
  };
}

/// The latest attempt time across the questions, or null if none was ever answered.
export function lastStudied(questions) {
  let latest = null;
  for (const question of questions) {
    for (const attempt of attemptsOf(question)) {
      if (latest === null || attempt.at.getTime() > latest.getTime()) latest = attempt.at;
    }
  }
  return latest;
}
