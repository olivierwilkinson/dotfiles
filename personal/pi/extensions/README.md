# Local Pi extensions

`lmtools-code.ts` is the tracked deployment source for
`~/.pi/agent/extensions/lmtools-code.ts`. `personal/install.sh` symlinks that
individual file, following the tracked Pi agent/config pattern without replacing
the extensions directory or its other contents. Reload Pi to pick up changes.

The initial import preserves the final live area-local version byte for byte
(110558 bytes, SHA-256
`5861dd9df046cacc99d37d4fcb7bb77d4bec47bf348559bfc285fb1e97beac13`).
Existing `.bak` files remain untouched in the live directory.

Development source and fixture checks also exist in the lmtools repository at
`tools/code/pi/lmtools-code.ts` and `tools/code/tests/area-local-extension.test.mjs`.
Keep deliberate updates aligned. The original source-header comment remains
unchanged to preserve the imported bytes.
