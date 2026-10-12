// Yönetim paneli. Bağımlılıklar: config.js, qr-render.js, image-utils.js,
// contrast.js, github-api.js
(function () {
  "use strict";

  var SLUG_RE = /^[a-z0-9-]{2,40}$/;
  // redirect.js'teki listeyle aynı tutulmalı.
  var RESERVED = ["panel", "assets", "vendor", "index", "404", "links"];
  var LINKS_PATH = "links.json";
  var LOGO_PATH_RE = /^assets\/logos\/[a-z0-9-]+\.(png|jpe?g|webp|svg)$/;
  var LOGO_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
  var TOKEN_KEY = "qrPanelToken";
  var PUBLISH_INTERVAL = 10000;
  var PUBLISH_TIMEOUT = 180000;
  var TR_CHARS = { "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u", "Ç": "c", "Ğ": "g", "İ": "i", "Ö": "o", "Ş": "s", "Ü": "u" };

  var cfg = window.QR_CONFIG || {};
  var owner = String(cfg.owner || "");
  var repo = String(cfg.repo || "");
  var branch = String(cfg.branch || "main");
  var basePath = String(cfg.basePath || "").replace(/\/+$/, "");
  var siteUrl = String(cfg.siteUrl || "").trim().replace(/\/+$/, "");
  // Kısa linklerin ve herkese açık links.json'un bulunduğu site kökü.
  var siteRoot = siteUrl || "https://" + owner.toLowerCase() + ".github.io" + basePath;

  var client = null;
  var data = null; // links.json içeriği
  var sha = null; // links.json'un okunduğu andaki blob sha'sı
  var logoCache = {}; // repo yolu → Promise<HTMLImageElement|null>
  var editor = null;
  var busy = false;
  var publishRun = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function userError(message) {
    return new Error(message);
  }

  function isoNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // Yayın takibi updatedAt'e baktığı için her kayıt öncekinden kesin büyük
  // bir zaman damgası almalı (aynı saniyede iki kayıt olabilir).
  function nextStamp(previous) {
    var now = isoNow();
    var prev = Date.parse(previous);
    if (!isNaN(prev) && Date.parse(now) <= prev) {
      return new Date(prev + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    return now;
  }

  function shortLink(slug) {
    return siteRoot + "/" + slug;
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
  }

  function normalizeHex(value, fallback) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || ""));
    if (!m) return fallback;
    var h = m[1].toLowerCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h;
  }

  function clampScale(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0.22;
    return Math.min(0.28, Math.max(0.1, n));
  }

  function safeHttpUrl(value) {
    try {
      var url = new URL(String(value));
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  // Şema yoksa https:// ekler; yalnızca http/https kabul edilir. Kullanıcının
  // yazdığı biçim saklanır (Türkçe karakterler %C3%A7 gibi kodlanmaz);
  // tarayıcı yönlendirirken kendisi kodlar.
  function normalizeTarget(raw) {
    var s = String(raw || "").trim();
    if (!s) return null;
    if (/^\/\//.test(s)) s = "https:" + s;
    // "ornek.com:8080" gibi port içeren adresler şema sayılmaz.
    else if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) s = "https://" + s;
    var url;
    try {
      url = new URL(s);
    } catch (e) {
      return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return s;
  }

  // Aramada büyük/küçük harf ve ı/i farkını yok say ("Instagram" → "instagram").
  function fold(text) {
    return String(text || "").toLocaleLowerCase("tr").replace(/ı/g, "i");
  }

  function slugify(text) {
    return String(text || "")
      .replace(/[çğıöşüÇĞİÖŞÜ]/g, function (c) { return TR_CHARS[c]; })
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");
  }

  function slugProblem(slug) {
    if (!slug) return "Slug gerekli.";
    if (!SLUG_RE.test(slug)) return "Slug 2–40 karakter olmalı; yalnızca küçük harf (a-z), rakam ve tire içerebilir.";
    if (RESERVED.indexOf(slug) !== -1) return "“" + slug + "” sistem tarafından ayrılmış; başka bir slug seç.";
    if (has(data.links, slug)) return "“" + slug + "” zaten kullanılıyor.";
    return null;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(userError("Görsel açılamadı.")); };
      img.src = src;
    });
  }

  // ---- Token saklama ----

  function readToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function storeToken(token, remember) {
    clearToken();
    try {
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    } catch (e) {
      // Depolama kapalıysa token yalnızca bu sayfa açıkken bellekte kalır.
    }
  }

  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* yok say */ }
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* yok say */ }
  }

  // ---- Görünümler ve durum mesajları ----

  function showView(name) {
    ["login", "list", "editor"].forEach(function (v) {
      $("view-" + v).hidden = v !== name;
    });
    $("topbar").hidden = name === "login";
    window.scrollTo(0, 0);
    // Tıklanan buton gizlenince klavye odağı kaybolmasın.
    $("view-" + name).querySelector("h1").focus({ preventScroll: true });
  }

  function setBanner(text, kind) {
    $("bannerText").textContent = text;
    $("banner").className = "banner" + (kind ? " " + kind : "");
    $("banner").hidden = !text;
  }

  function setBusy(value) {
    busy = value;
    ["saveBtn", "deactivateBtn", "deleteBtn", "deleteConfirmBtn", "backBtn", "logoutBtn", "newBtn"].forEach(function (id) {
      $(id).disabled = value;
    });
    if (!value) updateDeleteConfirm();
  }

  // Oturum sırasında token geçersizleşirse girişe dön.
  function handleError(err, target) {
    if (err && err.status === 401) {
      endSession("Oturum geçersiz: token iptal edilmiş ya da süresi dolmuş. Tekrar giriş yap.");
      return;
    }
    target.textContent = err && err.message ? err.message : "Beklenmeyen bir hata oluştu.";
  }

  // ---- links.json ----

  async function fetchLinks(c) {
    var file = await c.getFile(LINKS_PATH);
    if (!file) throw userError("Repoda " + LINKS_PATH + " bulunamadı (" + branch + " dalı).");
    var parsed;
    try {
      parsed = JSON.parse(GitHubAPI.base64ToUtf8(file.content));
    } catch (e) {
      throw userError(LINKS_PATH + " geçerli bir JSON değil.");
    }
    if (!parsed || typeof parsed.links !== "object" || parsed.links === null || Array.isArray(parsed.links)) {
      throw userError(LINKS_PATH + " beklenen biçimde değil (\"links\" nesnesi yok).");
    }
    return { sha: file.sha, content: file.content, data: parsed };
  }

  async function reloadLinks() {
    var file = await fetchLinks(client);
    data = file.data;
    sha = file.sha;
  }

  // mutate(links) değişikliği uygular. sha çakışmasında dosyayı yeniden okuyup
  // değişikliği bir kez daha uygular.
  async function commitLinks(mutate, message) {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await reloadLinks();
      var next = JSON.parse(JSON.stringify(data));
      mutate(next.links);
      var content = GitHubAPI.utf8ToBase64(JSON.stringify(next, null, 2) + "\n");
      try {
        var res = await client.putFile(LINKS_PATH, content, message, sha);
        data = next;
        sha = res.content.sha;
        return;
      } catch (e) {
        var conflict = e.status === 409 || e.status === 422;
        if (!conflict) throw e;
        if (attempt === 1) {
          throw userError("links.json bu arada başka bir yerden değiştirildi ve kayıt iki denemede de başarısız oldu. Sayfayı yenileyip tekrar dene.");
        }
      }
    }
  }

  function loadRepoLogo(path) {
    if (!LOGO_PATH_RE.test(path)) return Promise.reject(userError("Logo yolu geçersiz: " + path));
    if (!logoCache[path]) {
      var ext = path.split(".").pop();
      logoCache[path] = client.getFile(path).then(function (file) {
        if (!file) return null;
        return loadImage("data:" + LOGO_MIME[ext] + ";base64," + file.content);
      });
      logoCache[path].catch(function () { delete logoCache[path]; });
    }
    return logoCache[path];
  }

  // Ana kayıt başarılı olduktan sonra çağrılır; başarısız olursa repoda
  // kullanılmayan bir dosya kalır, sistem etkilenmez.
  function removeRepoFile(path, message) {
    delete logoCache[path];
    if (!LOGO_PATH_RE.test(path)) return;
    client.getFile(path)
      .then(function (file) { return file && client.deleteFile(path, file.sha, message); })
      .catch(function () { /* yok say */ });
  }

  // ---- Yayın takibi ----

  // expected: beklenen updatedAt; null ise kaydın yayından kalkması beklenir.
  function watchPublish(slug, expected) {
    var run = ++publishRun;
    var started = Date.now();
    setBanner("Yayına alınıyor (~1 dk)… " + slug, "");

    async function check() {
      if (run !== publishRun) return;
      var done = false;
      try {
        var publicBase = siteUrl || basePath;
        var res = await fetch(publicBase + "/" + LINKS_PATH + "?t=" + Date.now(), { cache: "no-store" });
        if (res.ok) {
          var pub = await res.json();
          var links = (pub && pub.links) || {};
          var entry = has(links, slug) ? links[slug] : null;
          done = expected === null ? !entry : !!entry && entry.updatedAt === expected;
        }
      } catch (e) {
        // Bir sonraki denemede tekrar bakılır.
      }
      if (run !== publishRun) return;
      if (done) {
        setBanner("Yayında: " + slug + (expected === null ? " kaldırıldı." : " güncel."), "ok");
      } else if (Date.now() - started >= PUBLISH_TIMEOUT) {
        setBanner("Değişiklik repoya kaydedildi ama 3 dakikada yayında görünmedi. GitHub Pages derlemesi gecikmiş olabilir; repodaki Actions sekmesine bak.", "warn");
      } else {
        setTimeout(check, PUBLISH_INTERVAL);
      }
    }
    setTimeout(check, PUBLISH_INTERVAL);
  }

  // ---- Giriş / çıkış ----

  async function validate(token, probeWrite) {
    var c = GitHubAPI.createClient(token, owner, repo, branch);
    var info;
    try {
      info = await c.getRepo();
    } catch (e) {
      if (e.status === 401) e.message = "Token geçersiz ya da süresi dolmuş.";
      else if (e.status === 404) {
        e.message = "“" + owner + "/" + repo + "” reposuna erişim yok. Token'da bu reponun seçili olduğundan ve config.js'teki owner/repo değerlerinin doğru olduğundan emin ol.";
      }
      if (e.status === 401 || e.status === 404) e.auth = true;
      throw e;
    }
    if (info && info.permissions && info.permissions.push === false) {
      var noPush = userError("Yetki yetersiz: GitHub hesabının bu repoya yazma yetkisi yok.");
      noPush.auth = true;
      throw noPush;
    }
    var file = await fetchLinks(c);
    if (probeWrite && !(await c.canWrite(LINKS_PATH, file.content))) {
      var noWrite = userError("Yetki yetersiz: token'ın “Contents” izni “Read and write” olmalı.");
      noWrite.auth = true;
      throw noWrite;
    }
    return { client: c, file: file };
  }

  function startSession(result) {
    client = result.client;
    data = result.file.data;
    sha = result.file.sha;
    $("repoName").textContent = owner + "/" + repo;
    $("loginStatus").textContent = "";
    $("loginError").textContent = "";
    renderList();
    showView("list");
  }

  function endSession(message) {
    clearToken();
    client = null;
    data = null;
    sha = null;
    logoCache = {};
    editor = null;
    publishRun++;
    setBanner("");
    setBusy(false);
    $("list").replaceChildren();
    $("searchInput").value = "";
    $("loginStatus").textContent = "";
    $("loginError").textContent = message || "";
    showView("login");
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    var token = $("tokenInput").value.trim();
    $("loginError").textContent = configProblem() || "";
    if (configProblem()) return;
    if (!token) {
      $("loginError").textContent = "Token'ı yapıştır.";
      return;
    }
    $("loginBtn").disabled = true;
    $("loginStatus").textContent = "Token doğrulanıyor…";
    try {
      var result = await validate(token, true);
      storeToken(token, $("rememberInput").checked);
      $("tokenInput").value = "";
      startSession(result);
    } catch (e) {
      $("loginStatus").textContent = "";
      $("loginError").textContent = e.message;
    } finally {
      $("loginBtn").disabled = false;
    }
  }

  // Yanlış ayarla basılan QR'lar ölü linke gider; bu yüzden panel hiç açılmaz.
  function configProblem() {
    if (!owner || !repo) return "config.js'te owner ve repo tanımlı değil.";
    if (siteUrl && !/^https?:\/\/[^/]+/i.test(siteUrl)) {
      return "config.js'teki siteUrl geçerli bir adres değil (ör. \"https://qr.ornek.com\").";
    }
    if (siteUrl && basePath) {
      return "config.js'te siteUrl doluyken basePath \"\" olmalı (özel alan adında site kökten sunulur).";
    }
    return null;
  }

  async function autoLogin() {
    $("repoHint").textContent = owner + "/" + repo;
    var problem = configProblem();
    if (problem) {
      $("loginError").textContent = problem;
      $("loginBtn").disabled = true;
      showView("login");
      return;
    }
    var token = readToken();
    if (!token) {
      showView("login");
      return;
    }
    showView("login");
    $("loginStatus").textContent = "Giriş yapılıyor…";
    try {
      startSession(await validate(token, false));
    } catch (e) {
      $("loginStatus").textContent = "";
      if (e.auth) clearToken();
      $("loginError").textContent = e.message;
    }
  }

  // ---- Liste ----

  function badge(active) {
    return el("span", "badge " + (active ? "on" : "off"), active ? "Aktif" : "Pasif");
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { /* yok say */ }
      ta.remove();
      if (ok) resolve();
      else reject(new Error("copy"));
    });
  }

  function bindCopy(button, getText) {
    button.addEventListener("click", function () {
      copyText(getText()).then(
        function () { flash(button, "Kopyalandı"); },
        function () { flash(button, "Kopyalanamadı"); }
      );
    });
  }

  function flash(button, text) {
    button.textContent = text;
    clearTimeout(button._flash);
    button._flash = setTimeout(function () { button.textContent = "Kopyala"; }, 1500);
  }

  function linkOrText(url) {
    var safe = safeHttpUrl(url);
    if (!safe) return document.createTextNode(String(url || "—"));
    var a = el("a", null, String(url));
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function renderThumb(host, slug, entry) {
    var style = entry.style || {};
    function draw(logo) {
      try {
        host.replaceChildren(renderQR({
          text: shortLink(slug),
          fg: normalizeHex(style.fg, "#000000"),
          bg: normalizeHex(style.bg, "#ffffff"),
          ecl: style.ecl,
          logo: logo,
          logoScale: clampScale(style.logoScale),
          size: 144
        }).canvas);
      } catch (e) {
        host.textContent = "";
      }
    }
    draw(null);
    if (entry.logo) {
      loadRepoLogo(entry.logo).then(function (img) { if (img) draw(img); }).catch(function () {});
    }
  }

  function buildCard(slug, entry) {
    var li = el("li", "qr-card");
    var link = shortLink(slug);

    var thumb = el("div", "thumb");
    thumb.title = "Düzenle";
    thumb.addEventListener("click", function () { openEditor(slug); });
    renderThumb(thumb, slug, entry);
    li.appendChild(thumb);

    var body = el("div", "card-body");
    var head = el("div", "card-head");
    head.appendChild(el("strong", null, String(entry.title || slug)));
    head.appendChild(badge(entry.active === true));
    body.appendChild(head);
    body.appendChild(el("div", "muted small", slug + " · " + formatDate(entry.updatedAt)));

    var linkRow = el("div", "link-row small");
    linkRow.appendChild(linkOrText(link));
    var copy = el("button", "secondary small", "Kopyala");
    copy.type = "button";
    bindCopy(copy, function () { return link; });
    linkRow.appendChild(copy);
    body.appendChild(linkRow);

    var target = el("div", "target small", "→ ");
    target.appendChild(linkOrText(entry.target));
    body.appendChild(target);
    li.appendChild(body);

    var edit = el("button", "secondary small", "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", function () { openEditor(slug); });
    li.appendChild(edit);
    return li;
  }

  function renderList() {
    var query = fold($("searchInput").value.trim());
    var links = data.links;
    var slugs = Object.keys(links).sort(function (a, b) {
      return String((links[b] || {}).updatedAt || "").localeCompare(String((links[a] || {}).updatedAt || ""));
    });
    var list = $("list");
    list.replaceChildren();
    var shown = 0;
    slugs.forEach(function (slug) {
      var entry = links[slug] || {};
      var haystack = fold([entry.title, slug, entry.target].join(" "));
      if (query && haystack.indexOf(query) === -1) return;
      list.appendChild(buildCard(slug, entry));
      shown++;
    });
    $("listEmpty").hidden = shown > 0;
    $("listEmpty").textContent = slugs.length
      ? "Aramaya uyan QR yok."
      : "Henüz QR yok. “Yeni QR” ile ilkini oluştur.";
  }

  // ---- Düzenleyici ----

  function setLogoInfo(text) {
    $("logoInfo").textContent = text;
  }

  function currentForm() {
    return {
      title: $("titleInput").value.trim(),
      slug: editor.slug || $("slugInput").value.trim(),
      target: $("targetInput").value,
      active: $("activeInput").checked,
      fg: normalizeHex($("fgInput").value, "#000000"),
      bg: normalizeHex($("bgInput").value, "#ffffff"),
      logoScale: clampScale($("logoScaleInput").value)
    };
  }

  function currentLogoImg() {
    return editor.logo.status === "removed" ? null : editor.logo.img;
  }

  function eclFor(hasLogo) {
    if (hasLogo) return "H";
    return ["L", "M", "Q", "H"].indexOf(editor.original.ecl) !== -1 ? editor.original.ecl : "M";
  }

  function qrOptions(form, size) {
    var logo = currentLogoImg();
    return {
      text: shortLink(form.slug),
      fg: form.fg,
      bg: form.bg,
      ecl: eclFor(!!logo),
      logo: logo,
      logoScale: form.logoScale,
      size: size
    };
  }

  function appearanceChanged(form) {
    var o = editor.original;
    return form.fg !== o.fg || form.bg !== o.bg ||
      Math.abs(form.logoScale - o.logoScale) > 1e-9 || editor.logo.status !== "keep";
  }

  function openEditor(slug) {
    var entry = slug ? data.links[slug] : null;
    var style = (entry && entry.style) || {};
    var current = {
      slug: slug || null,
      original: {
        fg: normalizeHex(style.fg, "#000000"),
        bg: normalizeHex(style.bg, "#ffffff"),
        logoScale: clampScale(style.logoScale == null ? 0.22 : style.logoScale),
        ecl: style.ecl,
        logo: (entry && entry.logo) || null
      },
      logo: { status: "keep", img: null, dataURL: null, loading: false },
      slugTouched: !!slug
    };
    editor = current;

    $("editorTitle").textContent = slug ? "QR düzenle" : "Yeni QR";
    $("titleInput").value = entry ? String(entry.title || "") : "";
    $("slugInput").value = slug || "";
    $("slugInput").readOnly = !!slug;
    $("targetInput").value = entry ? String(entry.target || "") : "";
    $("activeInput").checked = entry ? entry.active === true : true;
    $("fgInput").value = current.original.fg;
    $("bgInput").value = current.original.bg;
    $("logoScaleInput").value = current.original.logoScale;
    $("logoInput").value = "";
    $("formError").textContent = "";
    $("formStatus").textContent = "";
    $("dangerZone").hidden = !slug;
    closeDeleteConfirm();
    updateDangerZone();

    if (current.original.logo) {
      current.logo.loading = true;
      setLogoInfo("Mevcut logo yükleniyor…");
      loadRepoLogo(current.original.logo)
        .then(function (img) {
          if (editor !== current) return;
          current.logo.loading = false;
          if (current.logo.status !== "keep") return;
          current.logo.img = img;
          setLogoInfo(img ? "Mevcut logo" : "Logo dosyası repoda bulunamadı.");
          updateEditor();
        })
        .catch(function (err) {
          if (editor !== current) return;
          current.logo.loading = false;
          setLogoInfo("Logo yüklenemedi: " + err.message);
          updateEditor();
        });
    } else {
      setLogoInfo("Logo yok");
    }

    showView("editor");
    updateEditor();
  }

  function updateEditor() {
    if (!editor) return;
    var form = currentForm();
    $("logoScaleValue").textContent = form.logoScale.toFixed(2);

    var slugHint = $("slugHint");
    var problem = editor.slug ? null : slugProblem(form.slug);
    if (editor.slug) {
      slugHint.textContent = "Slug değiştirilemez: basılı QR'lar bu adrese bağlı. Farklı bir adres gerekiyorsa yeni bir QR oluştur.";
    } else {
      slugHint.textContent = problem || "Kısa link: " + shortLink(form.slug);
    }
    slugHint.classList.toggle("error", !!problem);

    $("contrastWarning").textContent = contrastWarning(form.fg, form.bg) || "";
    $("appearanceNote").hidden = !(editor.slug && appearanceChanged(form));
    $("logoRemoveBtn").hidden = !(editor.logo.status === "new" ||
      (editor.logo.status === "keep" && editor.original.logo));

    var host = $("previewHost");
    $("previewError").textContent = "";
    if (problem) {
      host.replaceChildren();
      $("previewLink").textContent = "—";
      $("previewError").textContent = "Geçerli bir slug girince önizleme görünür.";
    } else {
      $("previewLink").textContent = shortLink(form.slug);
      try {
        host.replaceChildren(renderQR(qrOptions(form, 640)).canvas);
      } catch (e) {
        host.replaceChildren();
        $("previewError").textContent = e.message;
      }
    }

    var canDownload = !!editor.slug && !editor.logo.loading && !$("previewError").textContent;
    $("pngBtn").disabled = !canDownload;
    $("svgBtn").disabled = !canDownload;
    $("previewCopyBtn").disabled = !!problem;
    $("downloadHint").textContent = editor.slug
      ? ""
      : "İndirmek için önce kaydet. Kaydedilmemiş bir QR basılırsa “Bu QR bulunamadı” gösterir.";
  }

  function updateDangerZone() {
    if (!editor || !editor.slug) return;
    var entry = data.links[editor.slug];
    $("deactivateBtn").hidden = !entry || entry.active !== true;
  }

  function closeDeleteConfirm() {
    $("deleteConfirm").hidden = true;
    $("deleteInput").value = "";
    updateDeleteConfirm();
  }

  function updateDeleteConfirm() {
    $("deleteConfirmBtn").disabled = busy || !editor || !editor.slug ||
      $("deleteInput").value.trim() !== editor.slug;
  }

  function validateForm(form) {
    if (!form.title) return "Başlık gerekli.";
    if (!editor.slug) {
      var problem = slugProblem(form.slug);
      if (problem) return problem;
    }
    if (!normalizeTarget(form.target)) return "Hedef link geçerli bir http:// veya https:// adresi olmalı.";
    return null;
  }

  async function handleSave(ev) {
    ev.preventDefault();
    if (busy || !editor) return;
    var form = currentForm();
    var invalid = validateForm(form);
    $("formError").textContent = invalid || "";
    if (invalid) return;

    var current = editor;
    var isNew = !current.slug;
    var slug = form.slug;
    var target = normalizeTarget(form.target);
    $("targetInput").value = target;

    setBusy(true);
    try {
      var stamp = null;
      var logoPath = "assets/logos/" + slug + ".png";
      var logoValue;

      if (current.logo.status === "new") {
        $("formStatus").textContent = "Logo yükleniyor…";
        var existing = await client.getFile(logoPath);
        await client.putFile(
          logoPath,
          current.logo.dataURL.split(",")[1],
          "qr: " + slug + " logosu yüklendi",
          existing ? existing.sha : undefined
        );
        logoCache[logoPath] = Promise.resolve(current.logo.img);
        logoValue = logoPath;
      } else if (current.logo.status === "removed") {
        logoValue = null;
      } else {
        logoValue = current.original.logo;
      }

      var style = { fg: form.fg, bg: form.bg, ecl: eclFor(!!logoValue), logoScale: form.logoScale };

      $("formStatus").textContent = "Kaydediliyor…";
      await commitLinks(function (links) {
        if (isNew) {
          if (has(links, slug)) throw userError("“" + slug + "” bu arada başka bir yerden eklenmiş; farklı bir slug seç.");
          stamp = isoNow();
          links[slug] = {
            target: target,
            title: form.title,
            active: form.active,
            logo: logoValue,
            style: style,
            createdAt: stamp,
            updatedAt: stamp
          };
        } else {
          if (!has(links, slug)) throw userError("Bu QR bu arada başka bir yerden silinmiş.");
          var entry = links[slug];
          stamp = nextStamp(entry.updatedAt);
          entry.target = target;
          entry.title = form.title;
          entry.active = form.active;
          entry.logo = logoValue;
          entry.style = Object.assign({}, entry.style, style);
          entry.updatedAt = stamp;
        }
      }, "qr: " + slug + (isNew ? " oluşturuldu" : " güncellendi"));

      if (current.logo.status === "removed" && current.original.logo && current.original.logo !== logoValue) {
        removeRepoFile(current.original.logo, "qr: " + slug + " logosu silindi");
      }

      watchPublish(slug, stamp);
      setBusy(false);
      openEditor(slug);
      $("formStatus").textContent = isNew ? "QR oluşturuldu." : "Değişiklikler kaydedildi.";
    } catch (e) {
      $("formStatus").textContent = "";
      handleError(e, $("formError"));
      // Çakışmada links.json yeniden okunmuş olabilir; slug uyarısını tazele.
      if (editor === current) updateEditor();
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    if (busy || !editor || !editor.slug) return;
    var slug = editor.slug;
    $("formError").textContent = "";
    setBusy(true);
    try {
      var stamp = null;
      await commitLinks(function (links) {
        if (!has(links, slug)) throw userError("Bu QR bu arada başka bir yerden silinmiş.");
        stamp = nextStamp(links[slug].updatedAt);
        links[slug].active = false;
        links[slug].updatedAt = stamp;
      }, "qr: " + slug + " güncellendi");
      $("activeInput").checked = false;
      $("formStatus").textContent = "QR devre dışı bırakıldı. Basılı QR'lar “Bu QR şu an devre dışı” gösterir; “Aktif” kutusunu işaretleyip kaydederek yeniden açabilirsin.";
      watchPublish(slug, stamp);
    } catch (e) {
      handleError(e, $("formError"));
    } finally {
      setBusy(false);
      updateDangerZone();
    }
  }

  async function handleDelete() {
    if (busy || !editor || !editor.slug) return;
    var slug = editor.slug;
    if ($("deleteInput").value.trim() !== slug) return;
    var entry = data.links[slug];
    var logo = entry && entry.logo;
    $("formError").textContent = "";
    setBusy(true);
    try {
      await commitLinks(function (links) {
        if (!has(links, slug)) throw userError("Bu QR zaten silinmiş.");
        delete links[slug];
      }, "qr: " + slug + " silindi");
      if (logo) removeRepoFile(logo, "qr: " + slug + " logosu silindi");
      watchPublish(slug, null);
      setBusy(false);
      editor = null;
      renderList();
      showView("list");
    } catch (e) {
      handleError(e, $("formError"));
    } finally {
      setBusy(false);
    }
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function handleDownload(kind) {
    if (!editor || !editor.slug) return;
    var slug = editor.slug;
    try {
      var result = renderQR(qrOptions(currentForm(), kind === "png" ? 2048 : 1024));
      if (kind === "png") {
        result.toPNGBlob()
          .then(function (blob) { saveBlob(blob, slug + ".png"); })
          .catch(function (e) { $("previewError").textContent = e.message; });
      } else {
        saveBlob(new Blob([result.toSVGString()], { type: "image/svg+xml" }), slug + ".svg");
      }
    } catch (e) {
      $("previewError").textContent = e.message;
    }
  }

  async function handleLogoFile() {
    var input = $("logoInput");
    var file = input.files[0];
    if (!file || !editor) return;
    var current = editor;
    $("formError").textContent = "";
    try {
      var img = await loadImageFromFile(file);
      var norm = await normalizeLogo(img);
      var logoImg = await loadImage(norm.dataURL);
      if (editor !== current) return;
      current.logo = { status: "new", img: logoImg, dataURL: norm.dataURL, loading: false };
      setLogoInfo("Yeni logo (" + norm.width + "×" + norm.height + " px), kaydedince yüklenecek.");
      updateEditor();
    } catch (e) {
      if (editor === current) $("formError").textContent = e.message;
    } finally {
      input.value = "";
    }
  }

  function handleLogoRemove() {
    if (!editor) return;
    editor.logo = {
      status: editor.original.logo ? "removed" : "keep",
      img: null,
      dataURL: null,
      loading: false
    };
    setLogoInfo(editor.original.logo ? "Logo kaldırılacak (kaydedince)." : "Logo yok");
    updateEditor();
  }

  // ---- Olaylar ----

  $("loginForm").addEventListener("submit", handleLogin);
  $("logoutBtn").addEventListener("click", function () {
    if (!busy) endSession("Çıkış yapıldı; token bu cihazdan silindi.");
  });
  $("bannerClose").addEventListener("click", function () {
    publishRun++;
    setBanner("");
  });

  $("searchInput").addEventListener("input", renderList);
  $("newBtn").addEventListener("click", function () { openEditor(null); });
  $("backBtn").addEventListener("click", function () {
    if (busy) return;
    editor = null;
    renderList();
    showView("list");
  });

  $("titleInput").addEventListener("input", function () {
    if (editor && !editor.slug && !editor.slugTouched) $("slugInput").value = slugify(this.value);
    updateEditor();
  });
  $("slugInput").addEventListener("input", function () {
    if (!editor || editor.slug) return;
    var lower = this.value.toLowerCase();
    if (lower !== this.value) this.value = lower;
    editor.slugTouched = this.value !== "";
    updateEditor();
  });
  ["targetInput", "activeInput", "fgInput", "bgInput", "logoScaleInput"].forEach(function (id) {
    $(id).addEventListener("input", updateEditor);
  });
  $("logoInput").addEventListener("change", handleLogoFile);
  $("logoRemoveBtn").addEventListener("click", handleLogoRemove);
  $("editorForm").addEventListener("submit", handleSave);

  $("deactivateBtn").addEventListener("click", handleDeactivate);
  $("deleteBtn").addEventListener("click", function () {
    $("deleteSlug").textContent = editor ? editor.slug : "";
    $("deleteConfirm").hidden = false;
    $("deleteInput").focus();
  });
  $("deleteInput").addEventListener("input", updateDeleteConfirm);
  // Alan düzenleme formunun içinde; Enter formu kaydetmesin, silmeyi onaylasın.
  $("deleteInput").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    if (!$("deleteConfirmBtn").disabled) handleDelete();
  });
  $("deleteCancelBtn").addEventListener("click", closeDeleteConfirm);
  $("deleteConfirmBtn").addEventListener("click", handleDelete);

  $("pngBtn").addEventListener("click", function () { handleDownload("png"); });
  $("svgBtn").addEventListener("click", function () { handleDownload("svg"); });
  bindCopy($("previewCopyBtn"), function () { return shortLink(currentForm().slug); });

  autoLogin();
})();
