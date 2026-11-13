# unison-sources-extra

Дополнительные источники книг для [Unison](https://github.com/NotoBoto/unison): **RanobeLib** и **Author.Today**.
Подключение в приложении: «Обзор» → «Расширения» → «Добавить репозиторий» →
`https://notoboto.github.io/unison-sources-extra/`. Встроенные источники — в [unison-sources](https://github.com/NotoBoto/unison-sources).

Additional book-source plugins for Unison (RanobeLib, Author.Today; later Royal Road, AO3).
Same contract, `core` and build as `unison-sources`, which is the `base/` submodule.
Sites' content belongs to its rights holders; plugins are for personal use only.

```
git submodule update --init
npm ci --prefix base
UNISON_PROJECT=$PWD node base/tests/golden.mjs
UNISON_PROJECT=$PWD node base/scripts/record.mjs ranobelib <case> '<calls JSON>'
UNISON_PROJECT=$PWD node base/scripts/build.mjs --repo unison-sources-extra --name "Unison: источники (дополнительные)"
```
