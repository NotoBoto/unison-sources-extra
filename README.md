# unison-sources-extra

Additional book-source plugins for Unison (ranobelib, later Author.Today, Royal Road, AO3).
Same contract, `core` and build as `unison-sources`, which is the `base/` submodule.
Sites' content belongs to its rights holders; plugins are for personal use only.

```
git submodule update --init
npm ci --prefix base
UNISON_PROJECT=$PWD node base/tests/golden.mjs
UNISON_PROJECT=$PWD node base/scripts/record.mjs ranobelib <case> '<calls JSON>'
UNISON_PROJECT=$PWD node base/scripts/build.mjs --repo unison-sources-extra --name "Unison: источники (дополнительные)"
```
