import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

const iosHintKey = "yohaku.pwa.iosHintDismissed";

function readFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private browsing may refuse storage; the hint then returns next visit.
  }
}

// Handles service-worker registration, the Android install prompt and the iOS
// home-screen hint.
// Rendered once above the app, so the banners float over every screen.
export default function PWAManager() {
  useRegisterSW({
    onRegisterError(error) {
      console.debug("PWA 注册失败", error);
    },
  });
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [installDeferred, setInstallDeferred] = useState(false);
  const [iosHintDismissed, setIosHintDismissed] = useState(() => readFlag(iosHintKey));

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      // Keep the native prompt until the user taps our button.
      event.preventDefault();
      setInstallEvent(event);
    };
    const onAppInstalled = () => {
      setInstallEvent(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (standalone || installed) return null;
  if (installEvent && !installDeferred)
    return (
      <div className="pwa-banner" role="status">
        <span>安装「余白」到主屏幕，像应用一样使用。</span>
        <div className="pwa-banner-actions">
          <button
            className="button primary small"
            onClick={async () => {
              installEvent.prompt();
              const { outcome } = await installEvent.userChoice;
              if (outcome === "accepted") setInstalled(true);
              setInstallEvent(null);
            }}
          >
            安装
          </button>
          <button className="button subtle small" onClick={() => setInstallDeferred(true)}>
            暂不
          </button>
        </div>
      </div>
    );
  if (isIos && !iosHintDismissed)
    return (
      <div className="pwa-banner" role="status">
        <span>在 Safari 中点「分享 → 添加到主屏幕」，像应用一样使用余白。</span>
        <div className="pwa-banner-actions">
          <button
            className="button subtle small"
            onClick={() => {
              writeFlag(iosHintKey);
              setIosHintDismissed(true);
            }}
          >
            知道了
          </button>
        </div>
      </div>
    );
  return null;
}
