import { useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { createInstallChoices, installChoiceScope } from "./pwa-choice.mjs";

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

// Handles service-worker registration, the Android install prompt, the iOS
// home-screen hint and the public site certificate download.
// Kept mounted while the website session loads or changes.
export default function PWAManager({ session }) {
  const [registerFailed, setRegisterFailed] = useState(false);
  useRegisterSW({
    onRegisterError(error) {
      console.debug("PWA 注册失败", error);
      setRegisterFailed(true);
    },
  });
  const [installEvent, setInstallEvent] = useState(null);
  const [installed, setInstalled] = useState(false);
  const choices = useRef(null);
  if (!choices.current) choices.current = createInstallChoices({
    getCookie: () => document.cookie,
    setCookie: value => { document.cookie = value; },
    readLegacy: () => readFlag(iosHintKey),
    removeLegacy: () => localStorage.removeItem(iosHintKey),
    secure: window.location.protocol === "https:",
  });
  const [choice, setChoice] = useState({ scope: null, decided: false });
  const [prompting, setPrompting] = useState(false);
  const [certificateDismissed, setCertificateDismissed] = useState(false);
  const [certificateUrl, setCertificateUrl] = useState(devCertificateUrl);

  useEffect(() => {
    const sync = () => setChoice(choices.current.sync(session));
    sync();
    const remaining = session?.loginSession?.expiresAt - Date.now();
    const expiryTimer = remaining > 0 ? setTimeout(sync, remaining + 1) : null;
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(expiryTimer);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [session]);
  const remember = (value, expectedScope) => setChoice(choices.current.choose(value, expectedScope));

  useEffect(() => {
    if (devCertificateUrl) return;
    let cancelled = false;
    // Nginx publishes the root certificate independently of the app and login.
    // Check its type so a SPA fallback cannot advertise HTML as a certificate.
    fetch("/yohaku.crt", { method: "HEAD", cache: "no-store" })
      .then((response) => {
        if (
          !cancelled && response.ok &&
          response.headers.get("content-type")?.split(";")[0] === "application/x-x509-ca-cert"
        )
          setCertificateUrl("/yohaku.crt");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      // Keep the native prompt until the user taps our button.
      event.preventDefault();
      setInstallEvent(event);
    };
    const onAppInstalled = () => {
      setInstallEvent(null);
      setInstalled(true);
      setChoice(choices.current.choose("accepted"));
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
    certificateUrl && (registerFailed || !("serviceWorker" in navigator));
  const certificateLink = certificateUrl ? <a className="pwa-certificate-link" href={certificateUrl}>网站证书</a> : null;

  if (standalone || installed) return certificateLink;
  if (!session) return certificateLink;
  if (certificateUntrusted && !certificateDismissed)
    return (
      <div className="pwa-banner" role="status">
        <span>
          {isIos
            ? "如安装受阻，请先用 Safari 下载网站证书，在「设置 → 已下载描述文件」安装，再到「通用 → 关于本机 → 证书信任设置」开启完全信任，最后刷新页面。"
            : "如安装受阻，请先下载网站证书，到「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」安装，最后刷新页面。"}
        </span>
        <div className="pwa-banner-actions">
          <a className="button primary small" href={certificateUrl}>
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
  const scope = installChoiceScope(session);
  if (!scope || choice.scope !== scope.id || choice.decided) return certificateLink;
  if (installEvent)
    return (
      <div className="pwa-banner" role="status">
        <span>安装「余白」到主屏幕，像应用一样使用。</span>
        <div className="pwa-banner-actions">
          <button
            className="button primary small"
            disabled={prompting}
            onClick={async () => {
              if (prompting) return;
              const requestedScope = scope.id;
              setPrompting(true);
              try {
                await installEvent.prompt();
                const { outcome } = await installEvent.userChoice;
                if (outcome === "accepted" || outcome === "dismissed") remember(outcome, requestedScope);
                if (outcome === "accepted") setInstalled(true);
                setInstallEvent(null);
              } catch {
                setInstallEvent(null);
              } finally { setPrompting(false); }
            }}
          >
            安装
          </button>
          <button className="button subtle small" disabled={prompting} onClick={() => remember("later")}>
            暂不
          </button>
        </div>
      </div>
    );
  if (isIos)
    return (
      <div className="pwa-banner" role="status">
        <span>在 Safari 中点「分享 → 添加到主屏幕」，像应用一样使用余白。</span>
        <div className="pwa-banner-actions">
          {certificateUrl && (
            <a className="button subtle small" href={certificateUrl}>
              网站证书
            </a>
          )}
          <button
            className="button subtle small"
            onClick={() => {
              remember("ios");
            }}
          >
            知道了
          </button>
        </div>
      </div>
    );
  return certificateLink;
}
