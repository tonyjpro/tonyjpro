// Spaced-repetition scheduler, correctness-only (no time pressure -- see
// the note below).
//
// Two tiers, same idea as Anki:
//   - "learning" cards are drilled again within minutes, in frequent rotation,
//     until they graduate.
//   - "review" cards are graduated cards on a growing SM-2 style interval
//     (days), so well-known words are shown less and less often.
//
// A card has to be answered correctly through *every* learning step before
// it's allowed to leave the current session's rotation. A brand-new card
// uses the shorter LEARNING_STEPS_MS track (so a session doesn't front-load
// too much repetition for words you're seeing for the first time). A miss
// -- on any card, new or previously graduated -- switches it onto the
// longer MISS_RECOVERY_STEPS_MS track instead: a missed word needs real
// reinforcement, not just one lucky guess, so it takes more clean passes to
// earn its way back out, and the app layer (see app.js) also reinserts a
// recovering card much closer together than a fresh one. Once graduated,
// growth is the plain SM-2 progression (1 day, 6 days, then interval*ease),
// which is gradual by construction -- there's no separate "fast track."
//
// Response time isn't part of grading right now: it made a correct answer
// feel like it could still be marked "not known" just for taking a beat to
// read the choices, which is stressful and not a great signal on its own.
// The scheduler still records how long each correct answer took
// (avgTimeMs) purely as an informational stat -- a time-based signal is a
// good candidate to bring back deliberately in a later revision (see the
// "Ideas for later" section of the README), alongside real scoring.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

// Learning-step delays, in ms, applied in order each time a card in the
// learning queue is answered correctly. After the last step, the card
// graduates into the long-term review schedule.
export const LEARNING_STEPS_MS = [1 * MINUTE_MS, 10 * MINUTE_MS];

// Same idea, but for a card recovering from a miss: one more step than a
// brand-new card gets, since "got it right once after missing it" is weak
// evidence on a 6-way multiple choice -- it could just be a lucky guess.
export const MISS_RECOVERY_STEPS_MS = [1 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS];

export const GRADUATING_INTERVAL_DAYS = 1;
export const MIN_EASE = 1.3;
export const STARTING_EASE = 2.5;

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
    learningStep: 0, // index into the current track's steps array; null once graduated
    learningTrack: "new", // "new" (LEARNING_STEPS_MS) or "recovery" (MISS_RECOVERY_STEPS_MS)
    avgTimeMs: null,
    due: now,
    lastReviewed: null,
    totalReviews: 0,
    totalCorrect: 0,
  };
}

/**
 * Grades a single answer into an SM-2 style quality score: 4 (solid pass)
 * for correct, 0 (miss) for incorrect or "I don't know". Correctness-only
 * -- see the file header for why time isn't a factor right now.
 */
export function computeQuality(correct) {
  return correct ? 4 : 0;
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
  const quality = computeQuality(correct);
  const updated = { ...card };

  if (quality < 3) {
    updated.repetitions = 0;
    updated.interval = 0;
    updated.ease = Math.max(MIN_EASE, card.ease - 0.2);
    updated.learningStep = 0;
    updated.learningTrack = "recovery";
    updated.due = now + MISS_RECOVERY_STEPS_MS[0];
  } else if (card.learningStep != null) {
    const track = card.learningTrack === "recovery" ? "recovery" : "new";
    const steps = track === "recovery" ? MISS_RECOVERY_STEPS_MS : LEARNING_STEPS_MS;
    const nextStep = card.learningStep + 1;
    if (nextStep < steps.length) {
      updated.learningStep = nextStep;
      updated.learningTrack = track;
      updated.due = now + steps[nextStep];
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

  // Requeue in-session on a miss, or if the card hasn't cleared every
  // learning step yet -- so a fresh word needs its (shorter) track's worth
  // of clean passes before it's allowed to drop off, and a miss switches it
  // onto the longer recovery track, requiring those extra passes before it
  // does.
  const sessionRequeue = quality < 4 || updated.learningStep != null;

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
