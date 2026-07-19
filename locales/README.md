# Refract Translations

All launcher UI strings live here as JSON files, one per language.

## Adding a new language

1. **Fork** the repository on GitHub.
2. **Copy** `en.json` and name the copy after the [BCP 47 language tag](https://en.wikipedia.org/wiki/IETF_language_tag) for your language (e.g. `fr.json` for French, `de.json` for German, `zh-CN.json` for Simplified Chinese).
3. **Translate** every string value. Keep the JSON keys unchanged — only translate the values.
4. **Register** the locale in two places:

   **`apps/renderer/src/renderer/src/i18n/index.ts`** — import and register:
   ```ts
   import frJson from './locales/fr.json'
   // add to the locales/translations objects:
   translations.fr = build(frJson as unknown as Locale)
   ```

   **`apps/renderer/src/stores/language.ts`** — add the language code to the allowed list.

   **`apps/renderer/src/renderer/src/routes/settings/index.tsx`** — add a `SegmentButton` for the new language in the Language field.

5. Open a **Pull Request** with the title `i18n: add [language name] translation`.

## Translating the README

1. **Copy** the root `README.md` to `docs/README.<lang>.md`, using the [BCP 47 language tag](https://en.wikipedia.org/wiki/IETF_language_tag) for your language (e.g. `docs/README.zh-CN.md`).
2. **Translate** the content. Keep links, badges, code blocks, and brand names intact. Prefix repo-relative paths with `../` — the file lives one level deeper (e.g. `LICENSE` → `../LICENSE`). Absolute URLs are unchanged.
3. **Add a language link** to the root `README.md`, right below the tagline. Use the language's [endonym](https://en.wikipedia.org/wiki/Endonym_and_exonym) (its name in that language) as the link text, prefixed with a `🌐` glyph — e.g. `简体中文` for Simplified Chinese:
   ```html
   <p align="center">
     🌐 <a href="docs/README.zh-CN.md">简体中文</a>
   </p>
   ```
4. **Add a link back** to the root `README.md` at the top of the translated file:
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

## Tips

- Run `pnpm --filter @refract/renderer typecheck` after editing to catch JSON syntax errors.
- You can preview your translation by selecting it in **Settings → Language** while the dev build is running.
- If a string is hard to translate or has no natural equivalent, leave it as the English original — it's better than a broken translation.
- For strings that differ by plural count (`{{n}} installations`), both a `javaDetected` and `javaDetectedSingle` key exist. Translate both.
