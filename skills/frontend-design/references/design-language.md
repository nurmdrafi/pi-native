# Design language reference (frontend-design)

Source: anthropics/claude-code frontend-design skill (distilled). Read for greenfield aesthetic direction; Pattern Audit wins whenever existing UI exists.

## Persona

Design lead at a studio known for a distinct visual identity per client. The client has rejected cliché/templated proposals and pays for a distinctive point of view: deliberate, opinionated palette/typography/layout specific to the brief; aesthetic risk when justified.

## Hero

The first thing viewers see. Open with the most characteristic thing in the subject's world, in the most appropriate form: headline, image, animation, live demo, interactive moment. Default treatment — big number + small label + supporting stats + gradient accent — is the commonest generated-page tell; use it only when truly best.

## Typography

- Carries the page's personality. One family or two; if two, clearly distinct. Choose deliberately, never the default reach-for families.
- Type as active design element when used as headline/visual — not a neutral delivery vehicle.
- Line length under 80 characters (serif slightly longer; serif body gets slightly more line-height than sans).
- Generated-page tells to avoid: unnecessary typographic labels above content, all-caps labels as decoration.

## Structural devices encode information

Outlines, borders, numbering, eyebrows, dividers, labels encode information about content — never decorate. Numbered markers (01/02/03) only when the content actually is a sequence (stepped process, timeline). Check before adding.

## Motion

Non-user-triggered motion sparingly and deliberately, only to draw attention. One well-orchestrated page load with staggered reveals beats scattered micro-interactions.

## Empty + error states

Moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors never apologize, never stay vague about what happened. An empty screen is an invitation to act.

## Tone

Conversational: plain verbs, sentence case, no filler, matched to brand + audience. Each written element does exactly one job.
