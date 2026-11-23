# Refract Translations

All launcher UI strings live here as JSON files, one per language.

## Adding a new language

1. **Fork** the repository on GitHub.
2. **Create** `locales/<tag>.json`, named by the [BCP 47 language tag](https://en.wikipedia.org/wiki/IETF_language_tag) for your language in its canonical form (e.g. `fr.json` for French, `pt-BR.json` for Brazilian Portuguese, `zh-CN.json` for Simplified Chinese).
3. **Translate** the strings you want, keeping the JSON keys and nesting from `en.json`. A key you leave out is shown in English, so the file can start small and grow.
4. Open a **Pull Request** with the title `i18n: add [language name] translation`.

No code changes are needed. The app finds every JSON file in `locales`, lists it in **Settings → Language**, and shows how much of it is translated in **Translation status**.

## Translating the README

1. **Copy** the root `README.md` to `docs/README.<lang>.md`, using the [BCP 47 language tag](https://en.wikipedia.org/wiki/IETF_language_tag) for your language (e.g. `docs/README.zh-CN.md`).
2. **Translate** the content. Keep links, badges, code blocks, and brand names intact. Prefix repo-relative paths with `../` — the file lives one level deeper (e.g. `LICENSE` → `../LICENSE`). Absolute URLs are unchanged.
3. **Add a language link** to the root `README.md`, right below the tagline. Precede the link(s) with a single `🌐` glyph marking the language switcher. Use each language's [endonym](https://en.wikipedia.org/wiki/Endonym_and_exonym) (its name in that language) as the link text, separated by `|` — e.g. `简体中文` for Simplified Chinese, `Українська` for Ukrainian. If a language link is already present, append the new link into the same `<p>` block rather than adding another one:
   ```html
   <p align="center">
     🌐 <a href="docs/README.zh-CN.md">简体中文</a> | <a href="docs/README.uk.md">Українська</a>
   </p>
   ```
4. **Add a link back** to the root `README.md` in the translated file, placed in the same position as the language link in the root `README.md` (right below the tagline). Only link back to `English` — do not cross-link to sibling translations:
   ```html
   <p align="center">
     🌐 <a href="../README.md">English</a>
   </p>
   ```

## String format

### Plain strings
Just translate the text:
```json
"play": "PLAY"
```

### Parameterised strings — `{{param}}`
Strings containing `{{name}}` are templates. The `{{param}}` placeholder is replaced at runtime. Keep the placeholder in your translation, but you can move it to wherever it belongs grammatically:

```json
"licenseBody": "Your Microsoft account doesn't have a Java Edition license. Purchase Minecraft to play {{name}}."
```
→ French example:
```json
"licenseBody": "Votre compte Microsoft n'a pas de licence Java Edition. Achetez Minecraft pour jouer à {{name}}."
```

### `dayAbbr` - nested object
One-letter (or shortest) weekday names for the playtime chart, one key per day:
```json
"dayAbbr": { "sun": "S", "mon": "M", "tue": "T", "wed": "W", "thu": "T", "fri": "F", "sat": "S" }
```

### `javaVersionLabel` — nested object
This entry has four keys for different Java version ranges. Translate each label:
```json
"javaVersionLabel": {
  "v21plus": "Recommended for MC 1.20.5+",
  "v17to20": "Suitable for MC 1.18–1.20.4",
  "v16":     "Suitable for MC 1.17",
  "legacy":  "Suitable for MC ≤1.16.5"
}
```

### `ramGb` / `ramMb`
Memory labels used in instance forms. `{{gb}}` and `{{mb}}` are the numeric values. Usually these don't need translation unless your language uses different unit abbreviations.

## Translation markers

Refract reads locale files with [lexmit](https://github.com/ShulhaOleh/lexmit), which can mark a translated string with a prefix:

| Value | Meaning | What the app shows |
| --- | --- | --- |
| `"Відкрити"` | Translated | The translation |
| `"? Відкрити"` | Translated, but the English text changed since. Check it still fits, then remove `? ` | The translation |
| `"! Open"` | Not translated yet, English copied as a placeholder. Replace it with your translation | English |

A translation whose `{{param}}` placeholders differ from English is also shown in English, so a broken placeholder never reaches the interface.

## Tips

- Run `pnpm check:contracts` after editing to catch JSON syntax errors, wrong value types and placeholders that do not match English.
- You can preview your translation by selecting it in **Settings → Language** while the dev build is running.
- If a string is hard to translate or has no natural equivalent, leave the key out rather than copying the English text. A missing key falls back to English and still counts as untranslated, while copied English counts as translated.
- For strings that differ by plural count (`{{n}} installations`), both a `javaDetected` and `javaDetectedSingle` key exist. Translate both.
