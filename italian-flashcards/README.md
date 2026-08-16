# Italian Flashcards

A spaced-repetition flashcard app for learning Italian vocabulary. Answer a
word correctly and it drops into infrequent rotation; miss it, or tap "I
don't know", and it comes back around until it's solid. Grading is
correctness-only right now — no timer, no pressure (see "Ideas for later"
for why, and where that's headed).

Runs entirely in the browser — no build step, no account, no server-side
storage. Your progress lives in `localStorage`.

## Running it

```bash
node server.js
# or: npm start
```

Then open http://localhost:8080. (ES modules need to be served over
`http://`, not opened directly as a `file://` URL, which is why there's a
tiny built-in static server — no dependencies required beyond Node.)

## How the scheduling works

Each card moves through two tiers, similar to Anki:

- **Learning** — a new or recently-missed card. It has to be answered
  correctly through *every* learning step before it graduates, and each of
  those passes is also interleaved back into the queue within the *same
  session* — so a word sticks around for a couple of exposures rather than
  vanishing the instant you get it right once.
- **Review** — a graduated card on a growing interval, in days. Each
  correct review multiplies the interval by an ease factor. Since grading
  is correctness-only (see below), that growth is the plain, gradual SM-2
  progression — there's no "fast track" for a snappy answer, so known
  words fade out of rotation gradually rather than jumping straight to a
  long interval.

Grading is binary: correct (a solid pass) or incorrect/"I don't know" (a
miss — full reset, and the card recycles). Response time isn't measured
against the grade at all — see "Ideas for later" for why, and where a
time-based signal is headed next.

### A miss gets more reinforcement than a fresh word does

A brand-new card and a recently-missed card aren't treated the same:

- A **new** card just needs to clear 2 learning steps to graduate, and
  gets interleaved back into the queue at a normal pace (~3-6 cards later
  each time) — kept short on purpose so a session doesn't front-load too
  much repetition for words you're only meeting for the first time.
- A card that's just been **missed** — via a wrong pick or "I don't
  know", it doesn't matter which — switches onto a longer 3-step recovery
  track instead, *and* gets reinserted much closer together (~2-3 cards
  later each time). In practice that means a missed word shows up roughly
  3 times within the next 6-7 cards: real reinforcement, not just one
  lucky guess on a 6-way multiple choice getting it waved through. Missing
  it again at any point during recovery resets the count back to the
  start. Only once it's cleared all 3 recovery passes does it hand off to
  the normal, gradually-widening review schedule.

The scheduler itself lives in `srs.js` and has no UI dependencies —
`srs.test.mjs` covers it directly with `node --test`.

## Answering

Cards are multiple choice: the correct translation plus distractors pulled
from the rest of your deck, tap/click to answer. If you genuinely don't
know it, tap **I don't know** rather than guessing — that's what actually
tells the scheduler to recycle the card; grading isn't timed, so there's
no cost to taking a moment to think.

Distractors are drawn from words that have already turned up as a correct
answer earlier in the session, whenever there are enough of them, instead
of uniformly from the whole deck. Otherwise a word you recognize as
"already confirmed correct" is a giveaway all by itself — most of the deck
was never even in play this session, so a vaguely-familiar option stands
out without you needing to actually know the current word. Once a session
gets going, every choice on screen — including the right one — is a word
you've already seen be correct at least once, so familiarity alone stops
being a shortcut.

## Session length

A session doesn't pre-load a fixed number of cards. It starts with a small
batch (5 new cards, plus anything already due) and adapts as you go, on
purpose kept fairly small so recognition stays fast:

- New cards keep dripping in — up to a ceiling (20 by default, see "New
  cards per session" below) — as long as you're not already juggling
  several struggling ones.
- Once 3 cards are actively being drilled at the same time, new intake
  pauses so you're not piling on more unfamiliar material mid-struggle.
- Once you've cleared a floor of 10 new cards and strung together 5
  correct answers in a row, the session stops feeding you more and wraps
  up as soon as the queue drains — instead of padding out to the ceiling
  regardless of how well it's going.

In practice: a session where everything's easy ends quickly (though every
word still gets its required couple of passes — see "How the scheduling
works"); a session where several words are giving you trouble runs longer,
with those words cycling back repeatedly until they stick.

## Direction

Use the direction selector to choose:
- **Italian → English**
- **English → Italian**
- **Mixed** — each card randomly picks a direction when it's shown

## Managing your deck

Open **Manage deck** to:
- Add individual cards
- Delete cards
- Export your whole deck (including progress) as JSON
- Import a JSON file of `{ front, back }` pairs — matching Italian words
  keep their existing progress, new ones are added fresh
- Reset all progress (keeps your card list, restarts scheduling)
- Set the ceiling on new cards per session (see "Session length" above)

### Auto top-up

As your words graduate into infrequent ("mastered") rotation, the app
automatically pulls fresh words from a larger reserve list (`words.js`,
`RESERVE_WORDS`) to keep at least ~25 active (not-yet-mastered) cards in
your deck. You don't need to keep adding words yourself — bring your own
starter list via Import (or by editing `words.js`) and the deck keeps
itself topped up from there.

## Files

- `srs.js` — the scheduler (pure functions, no DOM)
- `srs.test.mjs` — unit tests (`node --test`)
- `words.js` — starter deck + reserve word pool
- `app.js` — session logic, deck management, persistence
- `index.html` / `style.css` — UI
- `server.js` — zero-dependency static file server

## Ideas for later (not built yet)

Response time used to factor into grading (v1 had a flat time bar, and
before that a per-card adaptive average). Both were dropped: even a word
you know cold takes a beat to spot among 6 choices, and knowing a slow
answer would silently count against you turned answering into something
stressful, working against the whole point of the app. Right now grading
is correctness-only, and **I don't know** is the explicit, honest way to
tell the scheduler a card needs recycling.

The plan is to bring time back deliberately, in v2, alongside real scoring
rather than as a silent grading input:

- **Timed lifeline / decaying-score answering**, inspired by a trivia game:
  after ~2-3 seconds with no answer, grey out 2 of the wrong choices as a
  "you should know this by now" hint; after another 1-2 seconds, grey out
  2 more. Pair it with a points system where faster answers score higher
  and each hint reveal cuts the max possible score.
- This is a scoring/UX layer on top of answering — separate from the SRS
  scheduling itself — but it'll raise the same question again: should an
  answer given after a hint appeared also grade as a weaker SM-2 pass?
  Worth deciding deliberately next time, with the stress problem in mind
  rather than retrofitting it the way v1 did.
