# Historical and third-party licenses

The MizTrace personal-use/commercial license applies only to material the
licensor is entitled to license under it. It does not replace other licenses.

## MizTrace copies and code previously released under MIT

MizTrace v0.5.0 and earlier MIT-licensed copies were distributed with:

Copyright (c) 2026 MIZHOUCL

The complete original notice and permission text are preserved in `LICENSE-MIT`.
Existing MIT permissions for those copies and independently licensed portions
remain in effect, including commercial use permitted by MIT.

## Vue

The vendored `web/vendor/vue.global.prod.js` identifies Vue v3.4.27,
Copyright (c) 2018-present Yuxi (Evan) You and Vue contributors, under MIT.
Its copyright and license header is retained. The MIT text below applies to Vue
with that copyright notice.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Desktop runtime and dependencies

Electron and Chromium retain the license files supplied with their runtime,
including `LICENSE` and `LICENSES.chromium.html` in the Windows distribution.
These files must not be replaced with MizTrace's license. The bundled Node
runtime retains its full notice at `resources/runtime/NODE-LICENSE`
(`Contents/Resources/runtime/NODE-LICENSE` on Mac). Dependencies retain their
own license files and notices. Build dependencies in `desktop/package-lock.json`
keep their original license metadata; changing MizTrace's metadata does not
relicense them.

## Redaction rules attribution

The comment in `src/ai/redact.js` credits the MIT-licensed
`brianruggieri/obsidian-daily-digest` project as a reference for redaction rules.
This attribution is retained; MizTrace's new commercial restrictions do not
replace any independently applicable MIT permissions for that material.
