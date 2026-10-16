# log-corpus

A small corpus of service logs under `logs/`, one file per service per day.

Every line has the shape:

```
<timestamp> <LEVEL> code=<CODE> svc=<service> msg=<text>
```

`LEVEL` is one of `INFO`, `WARN`, `ERROR`. Not every line carries a code (`INFO`
lines use `code=-`). `WARN` lines are not errors.
