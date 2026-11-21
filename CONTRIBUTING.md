# Contributing to Morf

Thanks for wanting to help. A few things keep Morf the way it is:

- **Everything stays on the computer.** No feature may send a file, or anything about a file, anywhere.
- **Originals are sacred.** Never overwrite, never leave half-written output, always let Stop work.
- **Quiet design.** Warm paper, black ink, large type, small mono labels, hairlines instead of boxes. Look at an existing screen before adding a new one.

## Getting started

```powershell
npm install
npm run app
```

`npm run dev` opens just the interface in a browser with a pretend engine, which is the fastest way
to work on screens.

## Before opening a pull request

```powershell
npx tsc -b
npm run test:engine
npm run smoke
```

The smoke test converts generated samples to every format and compression level; all of them must pass.
