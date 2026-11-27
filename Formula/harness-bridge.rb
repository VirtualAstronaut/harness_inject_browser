# Built from source on the user's Mac, so macOS never quarantines the programs
# and no Apple Developer ID or notarisation is needed.
# The release workflow (.github/workflows/release.yml) updates url and sha256 on each v* tag.
class HarnessBridge < Formula
  desc "Lets Gemini, ChatGPT and Claude web chats run sandboxed commands on your Mac"
  homepage "https://github.com/VirtualAstronaut/harness_inject_browser"
  url "https://github.com/VirtualAstronaut/harness_inject_browser/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "84537921cc6716dda83dedb1fc3c5b73583af2448f839f3086c295c11fb367ef"
  head "https://github.com/VirtualAstronaut/harness_inject_browser.git", branch: "main"

  depends_on "rust" => :build
  depends_on :macos

  def install
    system "cargo", "install", *std_cargo_args(path: "app")
    # Chrome starts bridge-host itself; keep it off PATH.
    libexec.install bin/"bridge-host"
    pkgshare.install "extension", "prompts"
  end

  def caveats
    <<~EOS
      Finish setting up (once per user):

        1. Register the browser connection:
             harness-bridge setup

        2. Open chrome://extensions, turn on Developer mode, click
           Load unpacked and choose:
             #{opt_pkgshare}/extension

        3. Start a session in your project folder:
             cd ~/projects/my-app && harness-bridge .
    EOS
  end

  test do
    assert_match "usage: harness-bridge", shell_output("#{bin}/harness-bridge --help")
    assert_path_exists libexec/"bridge-host"
    assert_path_exists pkgshare/"extension/manifest.json"

    # setup writes a manifest that points at the upgrade-proof opt path.
    (testpath/"Library/Application Support/Google/Chrome").mkpath
    with_env(HOME: testpath.to_s) { system bin/"harness-bridge", "setup" }
    manifest = testpath/"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.harness.bridge.json"
    assert_match "#{opt_libexec}/bridge-host", manifest.read
  end
end
