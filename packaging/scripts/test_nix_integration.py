"""Opt-in evaluation of the production helper using a real Nix store."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "update_packages", Path(__file__).with_name("update-packages.py")
)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


@unittest.skipUnless(os.environ.get("REFRACT_NIX_INTEGRATION") == "1", "requires opt-in and Nix")
class NixIntegrationTests(unittest.TestCase):
    def test_production_helper_evaluates_real_dependency_derivation(self):
        with tempfile.TemporaryDirectory(prefix="refract-nix-evaluation-") as temporary:
            source = Path(temporary)
            (source / "package.json").write_text('{"name":"refract-nix-fixture"}\n', encoding="utf-8")
            (source / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
            store_path = update.run_nix(["store", "add-path", str(source)]).stdout.strip()
            derivation = update.dependency_derivation(store_path, "0.0.0")
        self.assertRegex(derivation, r"^/nix/store/[0-9a-z]{32}-refract-pnpm-deps\.drv$")


if __name__ == "__main__":
    unittest.main()
