// Spaced-repetition scheduler with a response-time signal.
//
// Two tiers, same idea as Anki:
//   - "learning" cards are drilled again within minutes, in frequent rotation,
//     until they graduate.
//   - "review" cards are graduated cards on a growing SM-2 style interval
//     (days), so well-known words are shown less and less often.
//
// The extra ingredient: correctness alone is graded into a 0-5 "quality"
// score by comparing this answer's response time against a per-card rolling
// average of that card's own past correct answers. Answering faster than
// your own average pushes the interval out further; answering slower (but
// still correct) barely grows it and keeps the card in frequent rotation a
// bit longer; an incorrect answer resets it into the learning queue.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// Learning-step delays, in ms, applied in order each time a card in the
// learning queue is answered correctly. After the last step, the card
// graduates into the long-term review schedule.
export const LEARNING_STEPS_MS = [1 * MINUTE_MS, 10 * MINUTE_MS];

export const GRADUATING_INTERVAL_DAYS = 1;
export const MIN_EASE = 1.3;
export const STARTING_EASE = 2.5;

// Absolute fallback thresholds, used only until a card has a personal
// average time to compare against (i.e. its first correct answer).
export const DEFAULT_FAST_MS = 3000;
export const DEFAULT_SLOW_MS = 8000;

// Weight for the exponential moving average of a card's response time.
// Higher = more weight on the most recent answer.
const TIME_EWMA_ALPHA = 0.3;

export function createCard({ id, front, back, now = Date.now() }) {
  return {
    id,
    front,
    back,
    repetitions: 0,
    interval: 0,
    ease: STARTING_EASE,
    learningStep: 0, // index into LEARNING_STEPS_MS; null once graduated
    avgTimeMs: null,
    due: now,
    lastReviewed: null,
    totalReviews: 0,
    totalCorrect: 0,
  };
}

/**
 * Grades a single answer into an SM-2 style quality score (0-5), using the
 * card's own historical average correct-answer time as the "fast" baseline.
 */
export function computeQuality(correct, responseMs, avgTimeMs) {
  if (!correct) return 0;

  const fastCutoff = avgTimeMs == null ? DEFAULT_FAST_MS : avgTimeMs * 0.6;
  const slowCutoff = avgTimeMs == null ? DEFAULT_SLOW_MS : avgTimeMs * 1.15;

  if (responseMs <= fastCutoff) return 5;
  if (responseMs <= slowCutoff) return 4;
  return 3;
}

function nextAvgTime(avgTimeMs, responseMs) {
  if (avgTimeMs == null) return responseMs;
  return avgTimeMs * (1 - TIME_EWMA_ALPHA) + responseMs * TIME_EWMA_ALPHA;
}

/**
 * Applies one answer to a card and returns the updated card plus grading
 * info. Does not mutate the input card.
 *
 * sessionRequeue tells the caller (the UI's session queue) whether this
 * card should be reinserted a few cards later in the current session,
 * rather than waiting for its persisted `due` timestamp.
 */
export function schedule(card, { correct, responseMs, now = Date.now() }) {
  const quality = computeQuality(correct, responseMs, card.avgTimeMs);
  const updated = { ...card };

  if (quality < 3) {
    updated.repetitions = 0;
    updated.interval = 0;
    updated.ease = Math.max(MIN_EASE, card.ease - 0.2);
    updated.learningStep = 0;
    updated.due = now + LEARNING_STEPS_MS[0];
  } else if (card.learningStep != null) {
    const nextStep = card.learningStep + 1;
    if (nextStep < LEARNING_STEPS_MS.length) {
      updated.learningStep = nextStep;
      updated.due = now + LEARNING_STEPS_MS[nextStep];
    } else {
      updated.learningStep = null;
      updated.repetitions = 1;
      updated.interval = GRADUATING_INTERVAL_DAYS;
      updated.due = now + updated.interval * DAY_MS;
    }
    updated.ease = adjustEase(card.ease, quality);
  } else {
    const repetitions = card.repetitions + 1;
    let interval;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(card.interval * card.ease);

    updated.repetitions = repetitions;
    updated.interval = interval;
    updated.due = now + interval * DAY_MS;
    updated.ease = adjustEase(card.ease, quality);
  }

  updated.avgTimeMs = correct ? nextAvgTime(card.avgTimeMs, responseMs) : card.avgTimeMs;
  updated.lastReviewed = now;
  updated.totalReviews = card.totalReviews + 1;
  updated.totalCorrect = card.totalCorrect + (correct ? 1 : 0);

  // Anything less than a clean, fast pass gets drilled again soon in this
  // same session, on top of whatever its persisted `due` schedule says.
  const sessionRequeue = quality < 4;

  return { card: updated, quality, sessionRequeue };
}

function adjustEase(ease, quality) {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  return Math.max(MIN_EASE, ease + delta);
}

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}

export function isLearning(card) {
  return card.learningStep != null;
}

// A card counts as "mastered" once it's graduated and its interval has
// grown past this many days.
export const MASTERED_INTERVAL_DAYS = 21;

export function isMastered(card) {
  return !isLearning(card) && card.interval >= MASTERED_INTERVAL_DAYS;
}
