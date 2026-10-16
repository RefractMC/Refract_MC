cask "refract" do
  version "1.5.0"

  name "Refract"
  desc "Fast, open-source Minecraft launcher"
  homepage "https://refractmc.net"

  on_arm do
    url "https://github.com/RefractMC/Refract_MC/releases/download/v#{version}/Refract-macOS-arm64.dmg",
        verified: "github.com/RefractMC/Refract_MC/"
    sha256 "f1f75c59498432961275e203c852d2e0aa81b6a682b4af0d195dedd9ab0e7321"
  end

  on_intel do
    url "https://github.com/RefractMC/Refract_MC/releases/download/v#{version}/Refract-macOS-x64.dmg",
        verified: "github.com/RefractMC/Refract_MC/"
    sha256 "af4d875b37619eb21bf0dbcfa36dbc325311f1ddde1bf3b6f8047bd327b2d178"
  end

  app "Refract.app"

  zap trash: [
    "~/Library/Application Support/com.refract",
    "~/Library/Preferences/com.refract.plist",
    "~/Library/Saved Application State/com.refract.savedState",
  ]
end
