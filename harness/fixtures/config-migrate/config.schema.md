# config v2 shape

```jsonc
{
  "logging": { "level": "<string>" },                  // was: logLevel
  "network": { "retries": <int>, "timeoutMs": <int> }, // was: retries, timeoutMs
  "features": ["<string>", ...]                        // unchanged
}
```

All three top-level keys are required; no other keys are allowed.
