import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCard,
  schedule,
  computeQuality,
  isLearning,
  DAY_MS,
  LEARNING_STEPS_MS,
} from "./srs.js";

const NOW = 1_700_000_000_000;

test("computeQuality: correct is 4, incorrect is 0", () => {
  assert.equal(computeQuality(true), 4);
  assert.equal(computeQuality(false), 0);
});

test("response time has no effect on grading or scheduling", () => {
  const fast = createCard({ id: "fast", front: "sì", back: "yes", now: NOW });
  const slow = createCard({ id: "slow", front: "sì", back: "yes", now: NOW });
  const fastResult = schedule(fast, { correct: true, responseMs: 50, now: NOW });
  const slowResult = schedule(slow, { correct: true, responseMs: 15000, now: NOW });
  assert.equal(fastResult.quality, slowResult.quality);
  assert.equal(fastResult.card.interval, slowResult.card.interval);
  assert.equal(fastResult.card.ease, slowResult.card.ease);
  assert.equal(fastResult.sessionRequeue, slowResult.sessionRequeue);
});

test("a new card starts in the learning queue and is due immediately", () => {
  const card = createCard({ id: "1", front: "ciao", back: "hi", now: NOW });
  assert.equal(isLearning(card), true);
  assert.equal(card.due, NOW);
  assert.equal(card.repetitions, 0);
});

test("a fresh card is requeued in-session until it clears every learning step", () => {
  let card = createCard({ id: "1", front: "gatto", back: "cat", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length - 1; i++) {
    const result = schedule(card, { correct: true, responseMs: 100, now: NOW });
    card = result.card;
    assert.equal(result.sessionRequeue, true, `step ${i} should still be requeued in-session`);
    assert.equal(isLearning(card), true);
  }
  const final = schedule(card, { correct: true, responseMs: 100, now: NOW });
  assert.equal(isLearning(final.card), false);
  assert.equal(final.sessionRequeue, false);
});

test("an incorrect answer resets a graduated card back into learning and requeues it", () => {
  let card = createCard({ id: "1", front: "acqua", back: "water", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    card = schedule(card, { correct: true, responseMs: 100, now: NOW }).card;
  }
  // graduate further so it has a real interval to lose
  card = schedule(card, { correct: true, responseMs: 100, now: NOW }).card;
  card = schedule(card, { correct: true, responseMs: 100, now: NOW }).card;
  assert.ok(card.interval > 1);
  assert.equal(isLearning(card), false);

  const { card: afterMiss, sessionRequeue } = schedule(card, {
    correct: false,
    responseMs: 100,
    now: NOW,
  });

  assert.equal(isLearning(afterMiss), true);
  assert.equal(afterMiss.repetitions, 0);
  assert.equal(afterMiss.interval, 0);
  assert.equal(afterMiss.due, NOW + LEARNING_STEPS_MS[0]);
  assert.ok(afterMiss.ease < card.ease);
  assert.equal(sessionRequeue, true);
});

test("after a miss, a card needs the full learning-step sequence again before it drops off", () => {
  let card = createCard({ id: "1", front: "casa", back: "house", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    card = schedule(card, { correct: true, responseMs: 100, now: NOW }).card;
  }
  assert.equal(isLearning(card), false); // graduated to review

  card = schedule(card, { correct: false, responseMs: 100, now: NOW }).card; // miss
  assert.equal(isLearning(card), true);
  assert.equal(card.learningStep, 0);

  for (let i = 0; i < LEARNING_STEPS_MS.length - 1; i++) {
    const result = schedule(card, { correct: true, responseMs: 100, now: NOW });
    card = result.card;
    assert.equal(result.sessionRequeue, true);
  }
  const final = schedule(card, { correct: true, responseMs: 100, now: NOW });
  assert.equal(final.sessionRequeue, false);
  assert.equal(isLearning(final.card), false);
});

test("a correct answer on an already-graduated card is not requeued in-session", () => {
  let card = createCard({ id: "1", front: "buono", back: "good", now: NOW });
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    card = schedule(card, { correct: true, responseMs: 100, now: NOW }).card;
  }
  assert.equal(isLearning(card), false);
  const { sessionRequeue } = schedule(card, { correct: true, responseMs: 100, now: NOW });
  assert.equal(sessionRequeue, false);
});

test("ease never drops below the configured minimum after repeated misses", () => {
  let card = createCard({ id: "1", front: "difficile", back: "difficult", now: NOW });
  for (let i = 0; i < 20; i++) {
    card = schedule(card, { correct: false, responseMs: 100, now: NOW }).card;
  }
  assert.ok(card.ease >= 1.3);
});

test("due dates move forward in wall-clock time as reps accumulate", () => {
  let card = createCard({ id: "1", front: "presto", back: "soon", now: NOW });
  let now = NOW;
  for (let i = 0; i < LEARNING_STEPS_MS.length; i++) {
    const result = schedule(card, { correct: true, responseMs: 100, now });
    card = result.card;
    now = card.due;
  }
  assert.equal(isLearning(card), false);
  const before = card.due;
  const result = schedule(card, { correct: true, responseMs: 100, now: card.due });
  assert.ok(result.card.due > before);
  assert.ok(result.card.due - before >= DAY_MS - 1000);
});
