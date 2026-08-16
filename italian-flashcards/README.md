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

Every answer is graded 0–5 (SM-2 style "quality") against a flat response
time bar, not a per-card average. Every card uses the same 6-choice format,
so the "read the options" overhead is roughly constant from card to card —
a fixed cutoff is a fairer "do you actually know this" signal than
comparing against your own past pace on that specific word:

| Your answer | Quality | Effect |
|---|---|---|
| Correct, under 2 seconds | 5 | Interval grows the most; card graduates fastest |
| Correct, under 3 seconds | 4 | Normal interval growth |
| Correct, but 3 seconds or slower | 3 | Counts as "you don't really know this yet" — barely grows the interval, and the card keeps circulating |
| Incorrect (or "I don't know") | 0 | Resets to the learning queue, interval drops to 0, ease is penalized |

Anything scoring below quality 4 — a miss, or a correct answer that took 3
seconds or longer — doesn't just get shown again once. With six choices on
screen, a single lucky guess after a miss is a real possibility, so a card
that's ever scored below 4 has to be answered cleanly (under 3 seconds)
**three times in a row** before it's treated as consolidated and stops
circulating. Any wobble — a miss, or another slow answer — resets that
count. That's the "if I don't know it fast enough, keep drilling it until
I really do" behavior.

The scheduler itself lives in `srs.js` and has no UI dependencies —
`srs.test.mjs` covers it directly with `node --test`.

## Answering

Cards are multiple choice: the correct translation plus distractors pulled
from the rest of your deck, tap/click to answer. Response time is measured
from when the card appears to when you tap a choice.

## Session length

A session doesn't pre-load a fixed number of cards. It starts with a
modest batch (10 new cards, plus anything already due), then adapts as
you go:

- New cards keep dripping in — up to a ceiling (45 by default, see
  "New cards per session" below) — as long as you're not already
  juggling several struggling ones.
- Once 4 cards are actively being drilled at the same time, new intake
  pauses so you're not piling on more unfamiliar material mid-struggle.
- Once you've cleared a floor of 15 new cards and strung together 6
  clean passes in a row, the session stops feeding you more and wraps
  up as soon as the queue drains — instead of padding out to the
  ceiling regardless of how well it's going.

In practice: a session where everything's easy ends quickly; a session
where several words are giving you trouble runs longer, with those
words cycling back repeatedly until they stick, exactly the "harder
ones stay in circulation, easy ones drop off" behavior the interval
scheduling is built around — just visible within a single session, not
only across days.

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
