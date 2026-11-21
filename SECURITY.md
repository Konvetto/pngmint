# Security

The library parses nothing: it takes raw RGBA bytes you already decoded and writes a PNG. Its
attack surface is bounded input validation (sizes, option ranges) and memory use on large images.

If you find a problem, write to hello@konvetto.com. Please do not open a public issue for a
vulnerability before a fix is out. You will get an answer within a week and a fix, when the
report holds, in the next release.

Supported: the latest minor version.
