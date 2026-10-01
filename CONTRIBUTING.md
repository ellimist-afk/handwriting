# contributing

i don't merge pull requests, but i will review them. if you've found a fix, post it in an issue instead and i'll put it in myself if it's good. this keeps the code clean.

## how to help

- bugs: use the bug report form. include device, pen and a pen trace
- ideas and questions: Discussions
- untested tablet or pen? tell me what works and what doesn't
- security: see `SECURITY.md`, not a public issue

## code in issues

file and line, a snippet, a console error, or a small fix for one bug (say what you tested it on).

by posting code you agree i can use it in Handwriting under the project's license. i usually credit people but don't have to.

## AI / LLM policy

AI is fine, slop isn't.

1. only report bugs you've seen on your own device
2. device, pen, versions and steps come from you, not AI
3. test AI fixes on your device and understand them before posting
4. label AI theories as guesses
5. say if AI helped
6. no bots
7. security reports need a real repro

## building

Node 20 or newer, clean checkout:

```
npm ci
npx tsc -noEmit
npm test
npm run test:render
npm run build
```

the license (CC BY-NC-ND 4.0) doesn't allow sharing modified versions.
