# Homebrew formula template for agora-hub.
# After `npm publish`, update `url` and `sha256` to the registry tarball.
class AgoraHub < Formula
  desc "Local AI agent hub — knowledge bases, skills/MCP management, shared memory, token usage analytics"
  homepage "https://github.com/your-org/agora"
  url "https://registry.npmjs.org/agora-hub/-/agora-hub-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", "-g", "--prefix=#{prefix}", "--cache=#{buildpath}/.npm-cache", "."
    bin.install_symlink prefix/"lib/node_modules/agora-hub/bin/agora.js" => "agora"
  end

  def caveats
    <<~EOS
      Start the hub with:
        agora
      Then open http://127.0.0.1:7878

      Data lives in ~/.agora (override with AGORA_HOME).
      Self-check anytime with: agora doctor
    EOS
  end

  test do
    assert_match "Agent", shell_output("#{bin}/agora doctor")
  end
end
