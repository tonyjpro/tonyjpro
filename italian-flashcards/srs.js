// Spaced-repetition scheduler with a response-time signal.
//
// Two tiers, same idea as Anki:
//   - "learning" cards are drilled again within minutes, in frequent rotation,
//     until they graduate.
//   - "review" cards are graduated cards on a growing SM-2 style interval
//     (days), so well-known words are shown less and less often.
//
// The extra ingredient: correctness alone is graded into a 0-5 "quality"
// score using a flat response-time bar, not a per-card average. Every card
// is answered from the same 6-choice format, so the read-the-options
// overhead is roughly constant card to card -- a fixed cutoff is a fairer
// "do you actually know this" signal than comparing to your own past pace
// on that specific word. Answering well under the bar pushes the interval
// out the most; answering correctly but slower barely grows it and keeps
// the card in frequent rotation until it's passed cleanly several times in
// a row; an incorrect answer resets it into the learning queue.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// Learning-step delays, in ms, applied in order each time a card in the
// learning queue is answered correctly. After the last step, the card
// graduates into the long-term review schedule.
export const LEARNING_STEPS_MS = [1 * MINUTE_MS, 10 * MINUTE_MS];

export const GRADUATING_INTERVAL_DAYS = 1;
export const MIN_EASE = 1.3;
export const STARTING_EASE = 2.5;

// Flat response-time bar: answer well under this and it counts as "you
// know it" (quality 5); answer under it but not blazing fast, still solid
// (quality 4); answer at or past it (even if correct) counts as "you don't
// really know this yet" and the card goes back into frequent rotation.
export const INSTANT_MS = 1000;
export const KNOWN_MS = 2000;

// Weight for the exponential moving average of a card's response time.
// Purely informational (shown in the deck manager) -- not used for grading.
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
 * Grades a single answer into an SM-2 style quality score (0-5) using a
 * flat response-time bar: under KNOWN_MS counts as known, at or past it
 * (even if correct) counts as not confidently known yet.
 */
export function computeQuality(correct, responseMs) {
  if (!correct) return 0;
  if (responseMs <= INSTANT_MS) return 5;
  if (responseMs <= KNOWN_MS) return 4;
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
  const quality = computeQuality(correct, responseMs);
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
