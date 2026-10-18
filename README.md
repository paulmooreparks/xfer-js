# xferlang

xferlang is the JavaScript and TypeScript implementation of XferLang, a data format with the data model of JSON, no escape sequences anywhere in its grammar, and no meaning in line breaks or indentation. The specification and its conformance suite live in the [xferlang](https://github.com/paulmooreparks/xferlang) repository, which this repository includes as the `suite` submodule.

This repository is a scaffold. The parser, the canonical writer, the JSON mapping and the command line tool are not written yet, and [DESIGN.md](DESIGN.md) describes how they will be built. Nothing here is ready to use, and the package is marked private until the first release.

## Development

Clone with submodules, then install and check:

```sh
git clone --recurse-submodules https://github.com/paulmooreparks/xfer-js
cd xfer-js
npm ci
npm run check
npm run build
```

Building and testing need Node 22 or later, because the build and test tools require it. The runtime floor of the published package is a separate question, recorded as a pending decision in DESIGN.md section 16.

## Licence

MIT.
