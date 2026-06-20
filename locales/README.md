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
