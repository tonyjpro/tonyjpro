import {
  createCard,
  schedule,
  isDue,
  isLearning,
  isMastered,
} from "./srs.js";
import { STARTER_WORDS, RESERVE_WORDS } from "./words.js";

const CARDS_KEY = "italian-flashcards.cards.v1";
const SETTINGS_KEY = "italian-flashcards.settings.v1";
const MAX_RESPONSE_MS = 20000;
const MAX_SESSION_SIZE = 180;
const NUM_CHOICES = 6;
const TARGET_ACTIVE_POOL = 40; // keep at least this many not-yet-mastered cards around
const TOPUP_BATCH = 10; // add at most this many reserve words per top-up

const defaultSettings = { newPerSession: 45, direction: "it-en" };

let cards = loadCards();
saveCards();
let settings = loadSettings();

let session = null; // { queue: [id,...], index, stats, current: {card, direction, shownAt} }

const el = (id) => document.getElementById(id);

const statsBar = {
  due: el("stat-due"),
  learning: el("stat-learning"),
  mastered: el("stat-mastered"),
  total: el("stat-total"),
};

const startPanel = el("start-panel");
const startMessage = el("start-message");
const cardPanel = el("card-panel");
const summaryPanel = el("summary-panel");
const progressLabel = el("progress-label");
const promptLabel = el("prompt-label");
const cardPrompt = el("card-prompt");
const choicesEl = el("choices");
const feedbackEl = el("feedback");
const feedbackVerdict = el("feedback-verdict");
const feedbackAnswer = el("feedback-answer");
const feedbackQuality = el("feedback-quality");
const directionSelect = el("direction-select");

function loadCards() {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn("Failed to load cards from storage", e);
  }
  const now = Date.now();
  return STARTER_WORDS.map(([front, back], i) =>
    createCard({ id: `starter-${i}`, front, back, now })
  );
}

function saveCards() {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify(cards));
  } catch (e) {
    console.warn("Failed to save cards to storage", e);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch (e) {
    console.warn("Failed to load settings from storage", e);
  }
  return { ...defaultSettings };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("Failed to save settings to storage", e);
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderStats() {
  const now = Date.now();
  statsBar.due.textContent = cards.filter((c) => isDue(c, now)).length;
  statsBar.learning.textContent = cards.filter((c) => isLearning(c)).length;
  statsBar.mastered.textContent = cards.filter((c) => isMastered(c)).length;
  statsBar.total.textContent = cards.length;
}

// --- Auto top-up ---
// As your own words graduate into infrequent (mastered) rotation, pull in
// fresh ones from the reserve pool so the active deck doesn't shrink.

function topUpDeck() {
  const activeCount = cards.filter((c) => !isMastered(c)).length;
  const shortfall = TARGET_ACTIVE_POOL - activeCount;
  if (shortfall <= 0) return false;

  const existingFronts = new Set(cards.map((c) => c.front.toLowerCase()));
  const candidates = RESERVE_WORDS.filter(([front]) => !existingFronts.has(front.toLowerCase()));
  const take = Math.min(TOPUP_BATCH, shortfall, candidates.length);
  if (take <= 0) return false;

  const now = Date.now();
  for (const [front, back] of shuffle(candidates).slice(0, take)) {
    const id = crypto.randomUUID ? crypto.randomUUID() : `card-${Date.now()}-${Math.random()}`;
    cards.push(createCard({ id, front, back, now }));
  }
  saveCards();
  return true;
}

// --- Session ---
//
// The queue isn't fully pre-built: it starts with a modest batch of new
// cards plus everything already due, then adapts as you go. New cards
// keep dripping in (up to the session's ceiling) as long as you're not
// juggling too many struggling ones already — but once you've cleared
// the floor and strung together a solid streak of clean passes, the
// session stops feeding you more and wraps up instead of padding out
// to the ceiling regardless.

const INITIAL_NEW_BATCH = 5; // new cards to seed the queue with before adapting
const MASTERY_STREAK_LEN = 6; // consecutive clean passes that signal "you've got this"
const MAX_CONCURRENT_STRUGGLING = 4; // pause new intake once this many cards are actively being drilled
const REPS_TO_CONSOLIDATE = 3; // consecutive clean passes a missed/slow card needs before it's considered locked in

function pickDirection(cardSetting) {
  if (cardSetting === "mixed") return Math.random() < 0.5 ? "it-en" : "en-it";
  return cardSetting;
}

function startSession() {
  const now = Date.now();
  const due = cards.filter((c) => isDue(c, now));
  const fresh = shuffle(due.filter((c) => c.totalReviews === 0));
  const seenDue = shuffle(due.filter((c) => c.totalReviews > 0));

  const ceiling = Math.min(settings.newPerSession, fresh.length);
  const initialNewCount = Math.min(INITIAL_NEW_BATCH, ceiling);
  const initialNew = fresh.slice(0, initialNewCount);
  const newPool = fresh.slice(initialNewCount, ceiling).map((c) => c.id);

  let combined = shuffle([...seenDue, ...initialNew]);
  if (combined.length > MAX_SESSION_SIZE) {
    combined = combined.slice(0, MAX_SESSION_SIZE);
  }

  if (combined.length === 0) {
    const next = cards
      .map((c) => c.due)
      .filter((d) => d > now)
      .sort((a, b) => a - b)[0];
    startMessage.textContent = next
      ? `Nothing due right now. Next card is ready in about ${formatDuration(next - now)}.`
      : "No cards in your deck yet — add some in Manage deck.";
    return;
  }

  session = {
    queue: combined.map((c) => c.id),
    index: 0,
    newPool,
    newIntroduced: initialNewCount,
    newCeiling: ceiling,
    strugglingIds: new Set(),
    cleanStreaks: new Map(), // per-card count of consecutive clean passes since its last miss/slow answer
    seenIds: new Set(), // every card shown at least once this session, for distractor selection
    streak: 0,
    stats: { seen: 0, correct: 0, totalMs: 0 },
    current: null,
  };

  startPanel.hidden = true;
  summaryPanel.hidden = true;
  cardPanel.hidden = false;
  showCurrentCard();
}

function requeueCardSoon(cardId) {
  const offset = 3 + Math.floor(Math.random() * 4); // 3-6 cards later
  const insertAt = Math.min(session.index + offset, session.queue.length);
  session.queue.splice(insertAt, 0, cardId);
}

function maybeIntroduceNewCard() {
  if (!session || session.newPool.length === 0) return;
  if (session.newIntroduced >= session.newCeiling) return;
  if (session.strugglingIds.size >= MAX_CONCURRENT_STRUGGLING) return;

  const floor = Math.min(15, session.newCeiling);
  if (session.streak >= MASTERY_STREAK_LEN && session.newIntroduced >= floor) return;

  const nextId = session.newPool.shift();
  session.newIntroduced++;
  const offset = 2 + Math.floor(Math.random() * 3); // 2-4 cards ahead
  const insertAt = Math.min(session.index + offset, session.queue.length);
  session.queue.splice(insertAt, 0, nextId);
}

function findCard(id) {
  return cards.find((c) => c.id === id);
}

function replaceCard(updated) {
  const i = cards.findIndex((c) => c.id === updated.id);
  if (i !== -1) cards[i] = updated;
}

function showCurrentCard() {
  if (!session) return;
  if (session.index >= session.queue.length) {
    finishSession();
    return;
  }

  const cardId = session.queue[session.index];
  const card = findCard(cardId);
  if (!card) {
    session.index++;
    showCurrentCard();
    return;
  }

  session.seenIds.add(card.id);

  const direction = pickDirection(settings.direction);
  const promptText = direction === "it-en" ? card.front : card.back;
  const answerText = direction === "it-en" ? card.back : card.front;
  const answerField = direction === "it-en" ? "back" : "front";

  promptLabel.textContent = direction === "it-en" ? "Italian" : "English";
  cardPrompt.textContent = promptText;
  feedbackEl.hidden = true;

  const choices = buildChoices(card, answerField, answerText);
  renderChoices(choices);

  progressLabel.textContent = `${session.index + 1} / ${session.queue.length}`;

  session.current = { card, direction, answerText, shownAt: performance.now() };
}

function buildChoices(card, answerField, correctText) {
  const dedupe = (list) =>
    list.filter((c, i, arr) => arr.findIndex((x) => x.text === c.text) === i && c.text !== correctText);

  const others = cards.filter((c) => c.id !== card.id).map((c) => ({ id: c.id, text: c[answerField] }));

  // Distractors that have already appeared as some other card's correct
  // answer this session are shown first. Otherwise, a word you recognize
  // as "already confirmed correct" is a giveaway that it's the right
  // choice, letting you skip actually recalling the current prompt — the
  // pool is mostly words that were never in play this session at all.
  // Mixing in already-seen words as decoys forces real recall instead.
  const seen = session ? dedupe(others.filter((c) => session.seenIds.has(c.id))) : [];
  const rest = dedupe(others.filter((c) => !session || !session.seenIds.has(c.id)));

  const distractors = [...shuffle(seen), ...shuffle(rest)].slice(0, NUM_CHOICES - 1);
  const choices = shuffle([{ id: card.id, text: correctText }, ...distractors]);
  return choices;
}

function renderChoices(choices) {
  choicesEl.innerHTML = "";
  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";
    btn.textContent = choice.text;
    btn.addEventListener("click", () => selectChoice(choice, btn));
    choicesEl.appendChild(btn);
  }
}

function selectChoice(choice, btnEl) {
  if (!session || !session.current) return;
  const correct = choice.id === session.current.card.id;
  gradeAnswer(correct, btnEl);
}

function bail() {
  if (!session || !session.current) return;
  gradeAnswer(false, null);
}

function gradeAnswer(correct, chosenBtnEl) {
  const { card, answerText, shownAt } = session.current;
  const responseMs = Math.min(performance.now() - shownAt, MAX_RESPONSE_MS);

  Array.from(choicesEl.children).forEach((btn) => {
    btn.disabled = true;
    if (btn.textContent === answerText) btn.classList.add("correct");
    else if (btn === chosenBtnEl) btn.classList.add("incorrect");
  });

  const result = schedule(card, { correct, responseMs, now: Date.now() });
  replaceCard(result.card);
  saveCards();
  renderStats();

  session.stats.seen++;
  if (correct) session.stats.correct++;
  session.stats.totalMs += responseMs;

  if (result.sessionRequeue) {
    session.strugglingIds.add(card.id);
    session.cleanStreaks.set(card.id, 0);
    session.streak = 0;
    requeueCardSoon(card.id);
  } else {
    session.streak++;
    if (session.strugglingIds.has(card.id)) {
      // This card was missed or hesitant earlier this session — one clean
      // pass isn't enough proof (with 6-way multiple choice, it could be a
      // lucky guess), so keep it circulating until it's passed cleanly
      // several times in a row.
      const cleanCount = (session.cleanStreaks.get(card.id) || 0) + 1;
      if (cleanCount < REPS_TO_CONSOLIDATE) {
        session.cleanStreaks.set(card.id, cleanCount);
        requeueCardSoon(card.id);
      } else {
        session.strugglingIds.delete(card.id);
        session.cleanStreaks.delete(card.id);
      }
    }
  }

  maybeIntroduceNewCard();

  showFeedback(correct, answerText, result.quality);
}

function showFeedback(correct, answerText, quality) {
  feedbackEl.hidden = false;
  feedbackVerdict.textContent = correct ? "Correct" : "Not quite";
  feedbackVerdict.className = "feedback-verdict " + (correct ? "correct" : "incorrect");
  feedbackAnswer.textContent = `Answer: ${answerText}`;
  feedbackQuality.textContent = qualityLabel(correct, quality);
  el("next-card").focus();
}

function qualityLabel(correct, quality) {
  if (!correct) return "Marked as missed — you'll see this again soon.";
  if (quality === 5) return "Fast! This one will show up less often.";
  if (quality === 4) return "Good — solid pace.";
  return "Correct, but slow — you'll see this again soon to lock it in.";
}

function nextCard() {
  if (!session) return;
  session.index++;
  showCurrentCard();
}

function finishSession() {
  cardPanel.hidden = true;
  summaryPanel.hidden = false;
  const { seen, correct, totalMs } = session.stats;
  const accuracy = seen ? Math.round((correct / seen) * 100) : 0;
  const avgSec = seen ? (totalMs / seen / 1000).toFixed(1) : "0.0";
  el("summary-stats").innerHTML = `
    <div>${seen} cards reviewed</div>
    <div>${accuracy}% correct</div>
    <div>${avgSec}s average response time</div>
  `;
  session = null;
  topUpDeck();
  renderStats();
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr`;
  return `${Math.round(hours / 24)} day(s)`;
}

// --- Deck manager ---

function renderDeckTable() {
  const tbody = el("cards-table-body");
  tbody.innerHTML = "";
  const sorted = cards.slice().sort((a, b) => a.front.localeCompare(b.front));

  for (const card of sorted) {
    const tr = document.createElement("tr");

    const status = isLearning(card)
      ? { text: "Learning", cls: "status-learning" }
      : isMastered(card)
      ? { text: "Mastered", cls: "status-mastered" }
      : { text: `Review (${card.interval}d)`, cls: "status-review" };

    const avgTime = card.avgTimeMs != null ? `${(card.avgTimeMs / 1000).toFixed(1)}s` : "—";
    const accuracy = card.totalReviews
      ? `${Math.round((card.totalCorrect / card.totalReviews) * 100)}%`
      : "—";

    tr.innerHTML = `
      <td>${escapeHtml(card.front)}</td>
      <td>${escapeHtml(card.back)}</td>
      <td class="${status.cls}">${status.text}</td>
      <td>${avgTime}</td>
      <td>${accuracy}</td>
      <td><button class="btn btn-danger" data-id="${card.id}">Delete</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => deleteCard(card.id));
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function addCard(front, back) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `card-${Date.now()}-${Math.random()}`;
  cards.push(createCard({ id, front, back, now: Date.now() }));
  saveCards();
  renderStats();
  renderDeckTable();
}

function deleteCard(id) {
  if (!confirm("Delete this card?")) return;
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  topUpDeck();
  renderStats();
  renderDeckTable();
}

async function exportDeck() {
  const filename = "italian-flashcards-deck.json";
  const json = JSON.stringify(cards, null, 2);

  if (window.claude && window.claude.use) {
    const downloads = await window.claude.use("downloads");
    if (downloads) {
      try {
        await downloads.save({ filename, data: json });
      } catch (err) {
        if (!err || err.code !== "declined") {
          alert("Couldn't save the file: " + (err && (err.message || err.code)));
        }
      }
      return;
    }
  }

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function importDeck(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      alert("That file isn't valid JSON.");
      return;
    }
    if (!Array.isArray(parsed)) {
      alert("Expected a JSON array of cards.");
      return;
    }
    const valid = parsed.filter((c) => c && typeof c.front === "string" && typeof c.back === "string");
    if (valid.length === 0) {
      alert("No valid cards found in that file.");
      return;
    }
    if (!confirm(`Import ${valid.length} card(s)? Existing cards with matching Italian words keep their progress.`)) {
      return;
    }
    for (const incoming of valid) {
      const existing = cards.find((c) => c.front.toLowerCase() === incoming.front.toLowerCase());
      if (existing) {
        existing.back = incoming.back;
      } else {
        const id = incoming.id || (crypto.randomUUID ? crypto.randomUUID() : `card-${Date.now()}-${Math.random()}`);
        cards.push(createCard({ id, front: incoming.front, back: incoming.back, now: Date.now() }));
      }
    }
    saveCards();
    renderStats();
    renderDeckTable();
  };
  reader.readAsText(file);
}

function resetProgress() {
  if (!confirm("Reset all learning progress? Your card list stays, but every card starts over.")) return;
  const now = Date.now();
  cards = cards.map((c) => createCard({ id: c.id, front: c.front, back: c.back, now }));
  saveCards();
  renderStats();
  renderDeckTable();
}

// --- Wiring ---

directionSelect.value = settings.direction;
directionSelect.addEventListener("change", () => {
  settings.direction = directionSelect.value;
  saveSettings();
});

el("start-session").addEventListener("click", startSession);
el("restart-session").addEventListener("click", () => {
  summaryPanel.hidden = true;
  startPanel.hidden = false;
});
el("dont-know").addEventListener("click", bail);
el("next-card").addEventListener("click", nextCard);

el("toggle-manager").addEventListener("click", () => {
  const manager = el("deck-manager");
  manager.hidden = !manager.hidden;
  if (!manager.hidden) renderDeckTable();
});

el("new-per-session").value = settings.newPerSession;
el("new-per-session").addEventListener("change", (e) => {
  const n = parseInt(e.target.value, 10);
  settings.newPerSession = Number.isFinite(n) && n > 0 ? n : defaultSettings.newPerSession;
  saveSettings();
});

el("add-card-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const front = el("add-front").value.trim();
  const back = el("add-back").value.trim();
  if (!front || !back) return;
  addCard(front, back);
  el("add-front").value = "";
  el("add-back").value = "";
  el("add-front").focus();
});

el("export-deck").addEventListener("click", exportDeck);
el("import-deck-btn").addEventListener("click", () => el("import-deck-file").click());
el("import-deck-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importDeck(file);
  e.target.value = "";
});
el("reset-progress").addEventListener("click", resetProgress);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!feedbackEl.hidden) {
    e.preventDefault();
    nextCard();
  }
});

topUpDeck();
renderStats();
