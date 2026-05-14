# Category Classifier Test Battery

Ground-truth examples for verifying changes to the task-classifier prompt (index.html ~2953-2990).
Format: task | correct_category | notes

## Mis-tags found 5/14/26 (classifier put these in Manual)

File IRA 2024 tax return | AI Assist | file read as physical action
Finish reviewing the acquisition accounting narrative | AI Assist | reviewing verb misread
Finish reviewing tax narrative | AI Assist | reviewing verb misread; corrected live 5/14
When updating narratives in Workiva verify risks match the RCM | AI Assist | verify verb misread
Review if digest email is sent to partner after account linking | AI Assist | resolved 5/14 - analytical work, AI-assistable
Review Protiviti SOD report and verify no control gaps missed | AI Assist | review/verify misread
Refactor STWRD app to modular architecture | AI Assist | resolved 5/14 - will be worked with Claude + Claude Code
Note bug in STWRD copy-message button including header formatting | AI Assist | note-a-bug misread

## Known-correct Manual (regression guard - must NOT move)

Clear out garage to make room for Peloton | Manual | physical
Schedule meeting with GRC and HR teams | Manual | in-person coordination
Schedule lease narrative update meeting with Caliber team | Manual | in-person coordination

## Known-correct AI Complete (regression guard - must NOT move)

Draft a text to Denise about rescheduling PTO | AI Complete | AI produces the text
Write a thank-you note to aunt Sarah | AI Complete | AI drafts user sends

## Diagnosis (5/14/26)

All 8 mis-tagged tasks resolved to AI Assist - not one was genuinely Manual.
The classifier is not confusing three categories; it specifically fails to
recognize AI-Assist-class work and dumps it in Manual. Pattern: analytical
verbs (review, verify, note, refactor, file) get read as physical/Manual.
The AI Assist intent-word list in the prompt omits these.
Likely fix: add review/verify/analyze/note-style verbs to the AI Assist
intent words. Tune against this battery, verify before/after, do not ship blind.

## Open questions before tuning

- Bucket system has a blind spot for project-scale dev work (e.g. the refactor).
  Resolved as AI Assist for now since AI is the tool being used, but worth
  watching whether dev projects need their own handling someday.
- Battery needs more borderline examples over time.