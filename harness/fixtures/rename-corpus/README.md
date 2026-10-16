# rename-corpus

A small package under `pkg/`. `check.mjs` exercises the whole import graph.

Run it with `bun check.mjs`.

Note: the identifier `legacyRate` is defined in `pkg/core.mjs` and used by
every `pkg/nodeNN.mjs` and by `pkg/index.mjs`. Free-text prose in `pkg/notes.mjs`
is unrelated and must not change.
