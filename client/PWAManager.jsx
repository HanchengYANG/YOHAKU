import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

// Path of the developer certificate download, set by vite.config.mjs only when
// the dev server runs over HTTPS; empty in production builds.
const devCertificateUrl =
  typeof __YOHAKU_DEV_CERT__ !== "undefined" ? __YOHAKU_DEV_CERT__ : "";
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

// Handles service-worker registration, the Android install prompt, the iOS
// home-screen hint and, during HTTPS development, the certificate download.
// Rendered once above the app, so the banners float over every screen.
export default function PWAManager() {
  const [registerFailed, setRegisterFailed] = useState(false);
  useRegisterSW({
    onRegisterError(error) {
      console.debug("PWA 注册失败", error);
      setRegisterFailed(true);
    },
  });
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [installDeferred, setInstallDeferred] = useState(false);
  const [iosHintDismissed, setIosHintDismissed] = useState(() => readFlag(iosHintKey));
  const [certificateDismissed, setCertificateDismissed] = useState(false);

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
  // An untrusted certificate stops the service worker from registering.
  const certificateUntrusted =
    devCertificateUrl && (registerFailed || !("serviceWorker" in navigator));

  if (standalone || installed) return null;
  if (certificateUntrusted && !certificateDismissed)
    return (
      <div className="pwa-banner" role="status">
        <span>
          {isIos
            ? "手机尚未信任开发证书，暂时无法安装。下载后到「设置」安装描述文件，再在「通用 → 关于本机 → 证书信任设置」中开启。"
            : "设备尚未信任开发证书，暂时无法安装。下载后到「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」安装。"}
        </span>
        <div className="pwa-banner-actions">
          <a className="button primary small" href={devCertificateUrl}>
            下载证书
          </a>
          <button
            className="button subtle small"
            onClick={() => setCertificateDismissed(true)}
          >
            知道了
          </button>
        </div>
      </div>
    );
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
          {devCertificateUrl && (
            <a className="button subtle small" href={devCertificateUrl}>
              开发证书
            </a>
          )}
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
