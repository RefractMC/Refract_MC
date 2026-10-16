"""Offline regressions for tagged release notes and Discord descriptions."""

import importlib.util
import json
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release", SCRIPTS / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
TAG = "v12.34.56"
URL = f"https://github.com/RefractMC/Refract_MC/releases/tag/{TAG}"


class ReleaseNotesTests(unittest.TestCase):
    def test_exact_section_preserves_markdown_and_skips_unreleased(self):
        section = "### Added\n\n* Keep **formatting**, `code`, and [links](https://example.com)."
        changelog = f"# Changelog\n\n## Unreleased\nFuture work\n\n## 12.34.56\n\n{section}\n\n## 12.34.55\nOld work\n"
        self.assertEqual(release.release_notes(TAG, changelog), f"## Refract 12.34.56\n\n{section}\n")

    def test_final_section_and_crlf(self):
        self.assertEqual(
            release.release_notes(TAG, "## 12.34.56\r\n\r\n* Last section\r\n"),
            "## Refract 12.34.56\n\n* Last section\n",
        )

    def test_version_is_literal_and_does_not_match_prefixes(self):
        changelog = "## 12x34x56\nWrong\n## 12.34.560\nWrong\n## 12.34.56\nCorrect\n## 12.34.57\nLater\n"
        self.assertEqual(release.release_notes(TAG, changelog), "## Refract 12.34.56\n\nCorrect\n")

    def test_missing_empty_and_duplicate_versions_fail(self):
        fixtures = [
            "## Unreleased\nFuture work\n## 12.34.55\nOld work\n",
            "## 12.34.56\n\n## 12.34.55\nOld work\n",
            "## 12.34.56\n  \n\t\n",
            "## 12.34.56\nFirst\n## 12.34.56\nSecond\n",
        ]
        for changelog in fixtures:
            with self.subTest(changelog=changelog), self.assertRaises(ValueError):
                release.release_notes(TAG, changelog)

    def test_canonical_stable_tags(self):
        for tag, version in [("v0.0.0", "0.0.0"), (TAG, "12.34.56")]:
            with self.subTest(tag=tag):
                self.assertEqual(release.parse_tag(tag), version)
        invalid = [
            "", "12.34.56", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2",
            "v1.2.3.4", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3\n",
            "v١.2.3", "v1.2.3$(echo bad)", " v1.2.3",
        ]
        for tag in invalid:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.parse_tag(tag)


class DiscordPayloadTests(unittest.TestCase):
    def payload(self, text, url=None):
        return release.discord_payload(TAG, f"## 12.34.56\n\n{text}\n", url)

    def test_short_unicode_notes_and_default_release_url(self):
        text = '* English, українська, 简体中文, and emoji 😀\n* "Quotes" and \\slashes'
        payload = self.payload(text)
        embed = payload["embeds"][0]
        self.assertEqual(embed["description"], text)
        self.assertEqual(embed["title"], "Refract 12.34.56 released")
        self.assertEqual(embed["url"], URL)
        self.assertEqual(json.loads(json.dumps(payload, ensure_ascii=False)), payload)

    def test_explicit_url(self):
        url = URL + "?expanded=true"
        self.assertEqual(self.payload("Notes", url)["embeds"][0]["url"], url)
        self.assertEqual(self.payload("Notes", "")["embeds"][0]["url"], URL)

    def test_description_at_limit_is_not_truncated(self):
        for text in ["a" * 3900, "😀" * 1950]:
            with self.subTest(prefix=text[:10]):
                self.assertEqual(self.payload(text)["embeds"][0]["description"], text)

    def test_huge_and_multibyte_notes_have_safe_limit_and_full_link(self):
        for text in ["a" * 5_000_000, "a" * 3899 + "😀" * 100, "界" * 5000, "😀" * 5000]:
            with self.subTest(prefix=text[:10]):
                description = self.payload(text)["embeds"][0]["description"]
                self.assertLessEqual(len(description.encode("utf-16-le")) // 2, 3900)
                self.assertIn("…", description)
                self.assertIn(URL, description)
                self.assertEqual(description.encode("utf-8").decode("utf-8"), description)

    def test_invalid_section_cannot_produce_announcement(self):
        with self.assertRaises(ValueError):
            release.discord_payload(TAG, "## Unreleased\nFuture work\n", URL)


if __name__ == "__main__":
    unittest.main()
