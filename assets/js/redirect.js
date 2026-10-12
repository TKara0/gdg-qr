(function () {
  "use strict";

  var SLUG_RE = /^[a-z0-9-]{2,40}$/;
  var RESERVED = ["panel", "assets", "vendor", "index", "404", "links"];

  var config = window.QR_CONFIG || {};
  var basePath = String(config.basePath || "").replace(/\/+$/, "");

  var statusEl = document.getElementById("status");
  var retryBtn = document.getElementById("retry");

  function show(message, canRetry) {
    statusEl.textContent = message;
    retryBtn.hidden = !canRetry;
  }

  function getSlug() {
    var k = new URLSearchParams(location.search).get("k");
    if (k !== null) return k.trim().toLowerCase();

    var path = location.pathname;
    var lowerPath = path.toLowerCase();
    var lowerBase = basePath.toLowerCase();
    if (lowerBase && (lowerPath === lowerBase || lowerPath.indexOf(lowerBase + "/") === 0)) {
      path = path.slice(basePath.length);
    }
    path = path.replace(/^\/+/, "").replace(/\/+$/, "");
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      return "";
    }
    return path.toLowerCase();
  }

  // Yalnızca http(s) hedeflerini kabul et; javascript:, data: vb. asla açılmaz.
  function safeTarget(target) {
    if (typeof target !== "string") return null;
    var url;
    try {
      url = new URL(target);
    } catch (e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  }

  function run() {
    var slug = getSlug();
    if (!SLUG_RE.test(slug) || RESERVED.indexOf(slug) !== -1) {
      show("Bu QR bulunamadı", false);
      return;
    }

    show("Yönlendiriliyor…", false);

    fetch(basePath + "/links.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var links = data && data.links;
        var entry =
          links && Object.prototype.hasOwnProperty.call(links, slug)
            ? links[slug]
            : null;

        if (!entry) {
          show("Bu QR bulunamadı", false);
          return;
        }
        if (entry.active !== true) {
          show("Bu QR şu an devre dışı", false);
          return;
        }
        var target = safeTarget(entry.target);
        if (!target) {
          show("Bu QR bulunamadı", false);
          return;
        }
        location.replace(target);
      })
      .catch(function () {
        show("Bağlantı kurulamadı", true);
      });
  }

  retryBtn.addEventListener("click", run);
  run();
})();
