import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCard,
  schedule,
  computeQuality,
  isLearning,
  DAY_MS,
  MINUTE_MS,
  LEARNING_STEPS_MS,
  GRADUATING_INTERVAL_DAYS,
  INSTANT_MS,
  KNOWN_MS,
} from "./srs.js";

const NOW = 1_700_000_000_000;

test("computeQuality: incorrect is always 0 regardless of speed", () => {
  assert.equal(computeQuality(false, 100), 0);
  assert.equal(computeQuality(false, 5000), 0);
});

test("computeQuality: uses a flat response-time bar, not a per-card average", () => {
  assert.equal(computeQuality(true, INSTANT_MS - 200), 5); // near-instant
  assert.equal(computeQuality(true, (INSTANT_MS + KNOWN_MS) / 2), 4); // under the bar, not instant
  assert.equal(computeQuality(true, KNOWN_MS + 500), 3); // at/past the "known" bar
});

test("a new card starts in the learning queue and is due immediately", () => {
  const card = createCard({ id: "1", front: "ciao", back: "hi", now: NOW });
  assert.equal(isLearning(card), true);
  assert.equal(card.due, NOW);
  assert.equal(card.repetitions, 0);
});

test("fast correct answers advance faster than slow correct answers", () => {
  // Walk both cards through the learning steps and graduate them, so both
  // have a comparable interval baseline before we diverge on speed.
  let fast = createCard({ id: "fast", front: "sì", back: "yes", now: NOW });
  let slow = createCard({ id: "slow", front: "sì", back: "yes", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    fast = schedule(fast, { correct: true, responseMs: 500, now: NOW }).card;
    slow = schedule(slow, { correct: true, responseMs: 500, now: NOW }).card;
  }
  assert.equal(isLearning(fast), false);
  assert.equal(isLearning(slow), false);
  assert.equal(fast.interval, GRADUATING_INTERVAL_DAYS);
  assert.equal(slow.interval, GRADUATING_INTERVAL_DAYS);

  // Now diverge: one keeps answering well under the "known" bar, the
  // other answers slow-but-correct every time.
  for (let i = 0; i < 3; i++) {
    fast = schedule(fast, { correct: true, responseMs: 400, now: NOW }).card;
    slow = schedule(slow, { correct: true, responseMs: 3000, now: NOW }).card;
  }

  assert.ok(
    fast.interval > slow.interval,
    `expected fast card's interval (${fast.interval}) to exceed slow card's (${slow.interval})`
  );
  assert.ok(fast.ease > slow.ease);
});

test("an incorrect answer resets a graduated card back into learning", () => {
  let card = createCard({ id: "1", front: "acqua", back: "water", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    card = schedule(card, { correct: true, responseMs: 500, now: NOW }).card;
  }
  // graduate further so it has a real interval to lose
  card = schedule(card, { correct: true, responseMs: 500, now: NOW }).card;
  card = schedule(card, { correct: true, responseMs: 500, now: NOW }).card;
  assert.ok(card.interval > 1);
  assert.equal(isLearning(card), false);

  const { card: afterMiss, sessionRequeue } = schedule(card, {
    correct: false,
    responseMs: 4000,
    now: NOW,
  });

  assert.equal(isLearning(afterMiss), true);
  assert.equal(afterMiss.repetitions, 0);
  assert.equal(afterMiss.interval, 0);
  assert.equal(afterMiss.due, NOW + LEARNING_STEPS_MS[0]);
  assert.ok(afterMiss.ease < card.ease);
  assert.equal(sessionRequeue, true);
});

test("a slow-but-correct answer still passes but gets requeued in-session", () => {
  const card = createCard({ id: "1", front: "casa", back: "house", now: NOW });
  const { card: after, quality, sessionRequeue } = schedule(card, {
    correct: true,
    responseMs: KNOWN_MS + 500, // at/past the "known" bar
    now: NOW,
  });
  assert.equal(quality, 3);
  assert.equal(sessionRequeue, true);
  assert.ok(after.learningStep !== null || after.repetitions >= 1);
});

test("a fast correct answer on a graduated card is not requeued in-session", () => {
  let card = createCard({ id: "1", front: "buono", back: "good", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    card = schedule(card, { correct: true, responseMs: 400, now: NOW }).card;
  }
  const { sessionRequeue, quality } = schedule(card, {
    correct: true,
    responseMs: 200,
    now: NOW,
  });
  assert.equal(quality, 5);
  assert.equal(sessionRequeue, false);
});

test("ease never drops below the configured minimum after repeated misses", () => {
  let card = createCard({ id: "1", front: "difficile", back: "difficult", now: NOW });
  for (let i = 0; i < 20; i++) {
    card = schedule(card, { correct: false, responseMs: 6000, now: NOW }).card;
  }
  assert.ok(card.ease >= 1.3);
});

test("due dates move forward in wall-clock time as reps accumulate", () => {
  let card = createCard({ id: "1", front: "presto", back: "soon", now: NOW });
  let now = NOW;
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    const result = schedule(card, { correct: true, responseMs: 500, now });
    card = result.card;
    now = card.due;
  }
  assert.equal(isLearning(card), false);
  const before = card.due;
  const result = schedule(card, { correct: true, responseMs: 300, now: card.due });
  assert.ok(result.card.due > before);
  assert.ok(result.card.due - before >= DAY_MS - 1000);
});
