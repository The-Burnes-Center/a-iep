# Fonts

Self-hosted copies of three Google Fonts families, so the browser no longer
asks fonts.googleapis.com or fonts.gstatic.com for them. All the `@font-face`
rules live in `src/styles/fonts.css`, which points at `/fonts/…` in this folder.

The files are served as they are, not hashed by Vite. Vite 4 leaves font
`url()`s in CSS as unresolved `__VITE_ASSET__` placeholders, the same bug that
`index.html` documents for the icon font, so a hashed copy would not load. The
folder therefore follows the `public/vendor` pattern. It falls under the
one-day stable-files cache policy in `lib/user-interface/index.ts`.

| Family | Weights | Files | Used for |
|---|---|---|---|
| Fjalla One | 400 | `fjalla-one-*.woff2` (latin, latin-ext, vietnamese, cyrillic-ext) | English display headings |
| Cairo | 600, 700 | `cairo-*.woff2` (arabic, latin, latin-ext) | Arabic headings |
| Noto Naskh Arabic | 400, 500, 700 | `noto-naskh-arabic-*.woff2` (arabic, latin, latin-ext, math, symbols) | Arabic body text |

The subsets and weights match what the Google Fonts CSS API served for the
same requests before self-hosting. The WOFF2 files are unchanged from that
API. Each `@font-face` keeps Google's `unicode-range`, so a browser downloads a
file only when a character in its range is on screen. The Arabic families are
only used under `:lang(ar)` (`src/styles/rtl.css`), so an English visitor
downloads none of their files. Their rules cost a few KB of CSS in the main
stylesheet and no extra request.

Typekit (`use.typekit.net`, Adobe Fonts) is a separate licence that does not
allow self-hosting, so it stays linked from `index.html`.

## Licence

All three families are licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org). The copyright notices required by the licence
are below, followed by the full licence text.

Copyright 2012 The Fjalla One Project Authors (https://github.com/SorkinType/FjallaOne)
Copyright 2009 The Cairo Project Authors (https://github.com/Gue3bara/Cairo)
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)

---

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
