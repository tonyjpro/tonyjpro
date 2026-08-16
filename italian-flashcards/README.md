# Italian Flashcards

A spaced-repetition flashcard app for learning Italian vocabulary, where
**how fast you answer** matters as much as whether you got it right. Answer
a word quickly and correctly and it drops into infrequent rotation; answer
slowly, or miss it, and it comes back around soon until it's solid.

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

- **Learning** — a new or recently-missed card. It's shown again within
  minutes (1 min, then 10 min), and interleaved a few cards later within
  the *same session* so it stays in frequent rotation until you're solid
  on it.
- **Review** — a graduated card on a growing interval, in days. Each
  correct review multiplies the interval by an ease factor, so the better
  you know a word, the longer until it resurfaces.

### Where response time comes in

Every card tracks a rolling average of *your own* correct-answer times for
that specific word. Each new answer is graded 0–5 (SM-2 style "quality"),
based on speed relative to that personal baseline, not a fixed clock:

| Your answer | Quality | Effect |
|---|---|---|
| Correct, well under your average time | 5 | Interval grows the most; card graduates fastest |
| Correct, around your average time | 4 | Normal interval growth |
| Correct, but noticeably slower than usual | 3 | Passes, but interval barely grows and the card is drilled again later in this same session |
| Incorrect (or "I don't know") | 0 | Resets to the learning queue, interval drops to 0, ease is penalized |

That's the "if I don't know it as quickly, drill it more" behavior: speed
is only ever compared against how *you* answer that word once you know it,
so a naturally longer word isn't penalized against a short one — only
against your own past performance on it.

The scheduler itself lives in `srs.js` and has no UI dependencies —
`srs.test.mjs` covers it directly with `node --test`.

## Answering

Cards are multiple choice: the correct translation plus distractors pulled
from the rest of your deck, tap/click to answer. Response time is measured
from when the card appears to when you tap a choice.

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
- Set how many brand-new cards can enter a single session

### Auto top-up

As your words graduate into infrequent ("mastered") rotation, the app
automatically pulls fresh words from a larger reserve list (`words.js`,
`RESERVE_WORDS`) to keep at least ~40 active (not-yet-mastered) cards in
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

- **Timed lifeline / decaying-score answering**, inspired by a trivia game:
  after ~2-3 seconds with no answer, grey out 2 of the wrong choices as a
  "you should know this by now" hint; after another 1-2 seconds, grey out
  2 more. Pair it with a points system where faster answers score higher
  and each hint reveal cuts the max possible score. This is a scoring/UX
  layer on top of answering — separate from the SRS scheduling itself, so
  it needs a decision on whether an answer given after a hint appeared
  should also grade as a lower SM-2 quality (probably yes, since needing
  the hint is itself a sign you didn't know it fast).
