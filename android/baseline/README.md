# Original comparison baseline

`Gemini-original.html` is a byte-for-byte copy of the user's original uploaded
`Velocity_ Pro Network Speed Test.html`, retained for the requested Android
comparison. SHA-256:

```
6081a7427a3816a9d2ed655394e0249ba12fa3adbfe0e338488a44a51b85f976
```

It is a regression fixture, not the current deliverable. No credentials or
private user data were found in its contents. Its original external CDN links,
measurement code, settings and result handling are unchanged.

The Android comparison captures actual native browser network events alongside
its displayed result. This distinction matters because the original source
inserts random latency samples after request failures and increments upload
bytes after failed uploads. A visible COMPLETE state alone therefore does not
establish that those displayed measurements were successfully transferred.
