// Port of QVaultKit VirtualSet / VirtualSetStore, `allSets` kind only (inventory section 5),
// pooled over the banks the user explicitly selected.

/// Gathers the pool. `sources` ([{path, name, questions}]) must already be in library
/// sort order: that order is the study order and decides which copy of a duplicated
/// question wins. Question ids hash the prompt, so the same question in two banks has
/// the same id; the first occurrence is kept and later copies are dropped.
/// A pool carries no session: it is always studied fresh.
export function buildPool(sources) {
  const claimed = new Set();
  const questions = [];
  const origins = new Map();
  const contributing = [];

  for (const source of sources) {
    let contributed = false;
    for (const question of source.questions) {
      if (claimed.has(question.id)) continue;
      claimed.add(question.id);
      questions.push(question);
      origins.set(question.id, source.path);
      contributed = true;
    }
    if (contributed) contributing.push(source);
  }

  const title = contributing.length === 1 ? contributing[0].name : `${contributing.length} sets`;
  return { title, questions, origins };
}

/// Sends a pooled session's questions back to the banks that own them.
/// A question is skipped if it has no origin, or its bank is gone, or its id is no longer
/// in that bank. Otherwise, if it differs in any field it replaces the bank's copy in
/// place. Returns copies of only the banks that changed (input order); every other field
/// of a bank, including its own `session`, is carried through untouched.
/// The input banks are never mutated.
export function writeBack(pool, questions, banks) {
  const byPath = new Map(banks.map((bank) => [bank.path, bank]));
  const replacements = new Map(); // path -> Map<id, question>

  for (const question of questions) {
    const path = pool.origins.get(question.id);
    if (path === undefined) continue;
    const bank = byPath.get(path);
    if (!bank) continue;
    const current = (replacements.get(path)?.get(question.id))
      ?? bank.questions.find((candidate) => candidate.id === question.id);
    if (current === undefined) continue;
    if (canonical(current) === canonical(question)) continue;
    if (!replacements.has(path)) replacements.set(path, new Map());
    replacements.get(path).set(question.id, question);
  }

  const changed = [];
  for (const bank of banks) {
    const replaced = replacements.get(bank.path);
    if (!replaced) continue;
    changed.push({
      ...bank,
      questions: bank.questions.map((candidate) => replaced.get(candidate.id) ?? candidate),
    });
  }
  return changed;
}

/// JSON-stable form: object keys sorted, Dates by time, undefined fields ignored.
function canonical(value) {
  return JSON.stringify(normalise(value));
}

function normalise(value) {
  if (value instanceof Date) return { __date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = normalise(value[key]);
    }
    return out;
  }
  return value;
}
