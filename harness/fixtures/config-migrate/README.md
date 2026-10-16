# config-migrate

`config.json` is still in the flat *v1* shape. The v2 loader expects grouped
sections (`logging`, `network`, …).

The v2 shape is documented in `config.schema.md`.

Migrate `config.json` in place. Do not change the values, only the shape.
