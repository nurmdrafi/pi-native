# li-comment

Commenting is the highest-leverage thing on LinkedIn and the easiest to do
badly. A comment on a post with 400 reactions gets seen by more people than
most of your own posts. A generic one gets seen by nobody and costs you
credibility with the author.

## Input

The user pastes the post text (and the author's name and role if they have
it). If they paste a screenshot, read it. If they give you a URL you cannot
open, ask them to paste the text - do not guess what the post said, and do not
use browser automation to scrape the feed.

## The nine comment types

Pick by what the post actually is. Never default to type 1.

| # | type | when | shape |
| --- | --- | --- | --- |
| 1 | **Add a datum** | post makes a claim you can support with a number | "We saw the same thing: 40% of our..." |
| 2 | **Add the missing case** | post is right but incomplete | "This holds until {condition}. Then..." |
| 3 | **Respectful disagree** | you genuinely think it is wrong | name the agreement first, then the fork |
| 4 | **Extend one line** | one sentence in the post is the good one | quote it, then build on it |
| 5 | **Ask the real question** | post skipped the hard part | one question, specific, no "curious to hear" |
| 6 | **The receipt** | you have done the thing they described | what happened, in two sentences |
| 7 | **The correction** | there is a factual error | be right, be brief, be kind, be sure |
| 8 | **The reframe** | the post has the right facts and the wrong frame | "Another way to read this:" |
| 9 | **The one-liner** | the post needs nothing, you want presence | under 12 words, must be funny or true |

## Rules

- **3 to 5 sentences, 200-320 characters.** Longer reads as a hijack. Shorter reads as filler. See House format below.
- **Never open with "Great post"**, "Love this", "So true", "Couldn't agree
  more", "This resonates", or the author's first name followed by an
  exclamation mark. All six are invisible.
- **No emoji openers.** No 🔥 or 👏 as a first character.
- **Never restate the post.** The author knows what they wrote and so does
  everyone reading.
- **One idea.** A comment with two points reads as a blog attempt.
- **Say the specific thing.** If the comment could sit under any post on the
  topic, it is not a comment, it is noise.
- **Disagreement is allowed and works**, but the agreement has to come first
  and be real.

## House format (user directive, 2026-10-25)

Every comment ships in this shape. It overrides any earlier option style.

1. **Type.** Default to 4 (extend one line) or 5 (real question) - neither needs the user's own data. Type 1 (datum) or 6 (receipt) at most once a week: check `~/.pi/agent/linkedin/log.md` first.
2. **Length.** 200-320 characters, 3-5 sentences, sentence lengths visibly uneven: one short sentence, one long one.
3. **Plain words only.** No figure of speech that needs decoding. If a reader whose first language is not English could not parse it in one pass, rewrite it. Banned: puns on idioms, jokes that need setup ("the week the weather ate").
4. **No own metrics or project names** when the type 1/6 quota is closed, and never a number from an unrelated domain (fiber kilometres under an aerial-imagery post). The comment serves the author's post, not the user's proof list.
5. **Anchor on one line of the post**, quoted short, then build past it.
6. **Detector.** Run `scripts/detect.py`. A short plain comment often scores REVIEW on specificity because it carries no number - ship the readable one, say the score, never stuff a number in to lift it.

### Output block - always this, nothing added

```
POST: <author> - <what the post actually is, one line>

COMMENT
<3-5 sentences>

WHAT IT SAYS
<one or two plain lines decoding every metaphor or claim in the comment>

SHORTER
<one-line version, same type>
```

Then append the log row: `date | comment | <type> | target | link`.

Hard requirements, no exceptions:

- **SHORTER is never skipped.** Every comment ships with a shorter version, same type, 8-15 words, plain enough to stand alone if the long one is dropped. Batch mode includes it per post.
- **WHAT IT SAYS is never skipped.** It is the reader's check that the long version is understandable; if the gloss needs a metaphor explained, the metaphor goes, not the gloss.
- **One comment, not a menu.** No "option A / option B", no type labels inside the comment text.
- Both versions must already have a detect score attached when they are shown.

<!-- replaced 2026-10-25: the old "two options of different types" output. User asked for one fixed pattern: one comment, a plain-English gloss, one shorter alternate. -->

## Batch mode

If the user wants an engagement round, ask for the 5-10 posts as pasted text
in one message, return one comment each plus its SHORTER line, and keep a running
note of who they have already commented on this week in
`~/.pi/agent/linkedin/log.md`. Commenting on the same three people every day is
visible and it looks like what it is.

## Never

Do not auto-post. Do not use a browser tool to publish comments on the user's
behalf. Automated posting and scraping both violate LinkedIn's User Agreement
and put the account at risk. This skill writes the comment. The user posts it.
