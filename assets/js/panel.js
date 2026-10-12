// Yönetim paneli. Bağımlılıklar: config.js, qr-render.js, image-utils.js,
// github-api.js
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
  // Yeni QR'ların görünüşü; kullanıcıya ayar olarak gösterilmez. Kenar boşluğu
  // renderQR'ın varsayılanı (4).
  var DEFAULT_STYLE = { fg: "#000000", bg: "#ffffff", ecl: "H", logoScale: 0.22 };

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
  var createLogo = null; // { img, dataURL } yeni QR için seçilen görsel
  var resultSlug = null;
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

  function button(text, className, onClick) {
    var b = el("button", className, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
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

  // QR'ın içine her zaman bu adres yazılır, hedef link asla yazılmaz.
  function shortLink(slug) {
    return siteRoot + "/" + slug;
  }

  function normalizeHex(value, fallback) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || ""));
    if (!m) return fallback;
    var h = m[1].toLowerCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h;
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

  function slugFree(slug, links) {
    return SLUG_RE.test(slug) && RESERVED.indexOf(slug) === -1 && !has(links, slug);
  }

  function randomSlug() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var bytes = crypto.getRandomValues(new Uint8Array(6));
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  // QR adından slug: çakışırsa ya da ayrılmışsa -2, -3… eklenir; geçerli bir
  // slug çıkmıyorsa (boş ya da tek karakter) rastgele 6 karakter.
  function uniqueSlug(title, links) {
    var base = slugify(title);
    var slug;
    if (base.length < 2) {
      do { slug = randomSlug(); } while (!slugFree(slug, links));
      return slug;
    }
    if (slugFree(base, links)) return base;
    for (var n = 2; ; n++) {
      var suffix = "-" + n;
      slug = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
      if (slugFree(slug, links)) return slug;
    }
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
    ["login", "main", "editor"].forEach(function (v) {
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
    ["createBtn", "saveBtn", "backBtn", "logoutBtn"].forEach(function (id) {
      $(id).disabled = value;
    });
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

  async function uploadLogo(slug, dataURL, img) {
    var path = "assets/logos/" + slug + ".png";
    var existing = await client.getFile(path);
    await client.putFile(path, dataURL.split(",")[1], "qr: " + slug + " logosu yüklendi", existing ? existing.sha : undefined);
    logoCache[path] = Promise.resolve(img);
    return path;
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
          done = has(links, slug) && links[slug].updatedAt === expected;
        }
      } catch (e) {
        // Bir sonraki denemede tekrar bakılır.
      }
      if (run !== publishRun) return;
      if (done) {
        setBanner("Yayında: " + slug + " güncel.", "ok");
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
    resetCreateForm();
    $("result").hidden = true;
    resultSlug = null;
    renderList();
    showView("main");
  }

  function endSession(message) {
    clearToken();
    client = null;
    data = null;
    sha = null;
    logoCache = {};
    editor = null;
    resultSlug = null;
    publishRun++;
    setBanner("");
    setBusy(false);
    resetCreateForm();
    $("result").hidden = true;
    $("list").replaceChildren();
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

  // ---- QR çizimi ve indirme ----

  // Kaydın kendi style alanı kullanılır; eksik değerler renderQR varsayılanına düşer.
  function entryQrOptions(slug, entry, logo, size) {
    var style = entry.style || {};
    var scale = Number(style.logoScale);
    return {
      text: shortLink(slug),
      fg: normalizeHex(style.fg, DEFAULT_STYLE.fg),
      bg: normalizeHex(style.bg, DEFAULT_STYLE.bg),
      ecl: style.ecl,
      logo: logo,
      logoScale: style.logoScale != null && isFinite(scale) ? scale : DEFAULT_STYLE.logoScale,
      size: size
    };
  }

  // Logo dosyası repoda yoksa QR logosuz çizilir.
  async function entryLogo(entry) {
    if (!entry.logo) return null;
    return loadRepoLogo(entry.logo);
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

  async function downloadEntry(slug, kind, errorTarget) {
    errorTarget.textContent = "";
    var entry = data.links[slug];
    if (!entry) return;
    try {
      var logo = await entryLogo(entry);
      var result = renderQR(entryQrOptions(slug, entry, logo, kind === "png" ? 2048 : 1024));
      if (kind === "png") {
        saveBlob(await result.toPNGBlob(), slug + ".png");
      } else {
        saveBlob(new Blob([result.toSVGString()], { type: "image/svg+xml" }), slug + ".svg");
      }
    } catch (e) {
      handleError(e, errorTarget);
    }
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

  function flash(btn, text) {
    btn.textContent = text;
    clearTimeout(btn._flash);
    btn._flash = setTimeout(function () { btn.textContent = "Kopyala"; }, 1500);
  }

  // ---- Liste ----

  function linkOrText(url) {
    var safe = safeHttpUrl(url);
    if (!safe) return document.createTextNode(String(url || "—"));
    var a = el("a", null, String(url));
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function renderThumb(host, slug, entry, size) {
    function draw(logo) {
      try {
        host.replaceChildren(renderQR(entryQrOptions(slug, entry, logo, size || 144)).canvas);
      } catch (e) {
        host.textContent = "";
      }
    }
    draw(null);
    entryLogo(entry).then(function (img) { if (img) draw(img); }).catch(function () {});
  }

  function buildRow(slug, entry) {
    var li = el("li", "qr-card");

    var thumb = el("div", "thumb");
    renderThumb(thumb, slug, entry);
    li.appendChild(thumb);

    var body = el("div", "card-body");
    body.appendChild(el("strong", null, String(entry.title || slug)));
    var target = el("div", "target small");
    target.appendChild(linkOrText(entry.target));
    body.appendChild(target);
    li.appendChild(body);

    var actions = el("div", "actions");
    actions.appendChild(button("Düzenle", "secondary small", function () { openEditor(slug); }));
    actions.appendChild(button("PNG", "secondary small", function () { downloadEntry(slug, "png", $("listError")); }));
    actions.appendChild(button("SVG", "secondary small", function () { downloadEntry(slug, "svg", $("listError")); }));
    li.appendChild(actions);
    return li;
  }

  function renderList() {
    var links = data.links;
    var slugs = Object.keys(links).sort(function (a, b) {
      return String((links[b] || {}).createdAt || "").localeCompare(String((links[a] || {}).createdAt || ""));
    });
    var list = $("list");
    list.replaceChildren();
    slugs.forEach(function (slug) {
      if (links[slug]) list.appendChild(buildRow(slug, links[slug]));
    });
    $("listEmpty").hidden = slugs.length > 0;
  }

  // ---- Yeni QR ----

  function resetCreateForm() {
    $("createForm").reset();
    createLogo = null;
    $("createLogoInfo").textContent = "";
    $("createLogoRemove").hidden = true;
    $("createError").textContent = "";
    $("createStatus").textContent = "";
  }

  function readTitleAndTarget(titleInput, targetInput) {
    var title = titleInput.value.trim();
    if (!title) return { error: "QR adı gerekli." };
    if (!targetInput.value.trim()) return { error: "Bağlanılacak link gerekli." };
    var target = normalizeTarget(targetInput.value);
    if (!target) return { error: "Link, http:// ya da https:// ile başlayan geçerli bir adres olmalı." };
    return { title: title, target: target };
  }

  // Seçilen dosyayı 512px PNG'ye çevirir; { img, dataURL, width, height } döner.
  async function prepareLogo(file) {
    var norm = await normalizeLogo(await loadImageFromFile(file));
    var img = await loadImage(norm.dataURL);
    return { img: img, dataURL: norm.dataURL, width: norm.width, height: norm.height };
  }

  async function handleCreateLogo() {
    var input = $("createLogo");
    var file = input.files[0];
    $("createError").textContent = "";
    if (!file) {
      createLogo = null;
      $("createLogoInfo").textContent = "";
      $("createLogoRemove").hidden = true;
      return;
    }
    try {
      createLogo = await prepareLogo(file);
      $("createLogoInfo").textContent = "Görsel hazır (" + createLogo.width + "×" + createLogo.height + " px).";
      $("createLogoRemove").hidden = false;
    } catch (e) {
      createLogo = null;
      input.value = "";
      $("createLogoInfo").textContent = "";
      $("createLogoRemove").hidden = true;
      $("createError").textContent = e.message;
    }
  }

  function showResult(slug) {
    var entry = data.links[slug];
    if (!entry) return;
    resultSlug = slug;
    $("resultTitle").textContent = String(entry.title || slug);
    $("resultLink").textContent = shortLink(slug);
    renderThumb($("resultPreview"), slug, entry, 640);
    $("result").hidden = false;
  }

  async function handleCreate(ev) {
    ev.preventDefault();
    if (busy) return;
    var form = readTitleAndTarget($("createTitle"), $("createTarget"));
    $("createError").textContent = form.error || "";
    if (form.error) return;

    var logo = createLogo;
    setBusy(true);
    try {
      var slug = uniqueSlug(form.title, data.links);
      var logoValue = null;
      if (logo) {
        $("createStatus").textContent = "Görsel yükleniyor…";
        logoValue = await uploadLogo(slug, logo.dataURL, logo.img);
      }
      $("createStatus").textContent = "Kaydediliyor…";
      var stamp = null;
      await commitLinks(function (links) {
        // Çakışmada links.json yeniden okunur; bu arada aynı slug alınmışsa
        // görsel yolu da o slug'a ait olacağından yeniden oluşturmak gerekir.
        if (has(links, slug)) throw userError("Bu ad az önce başka bir yerden kullanıldı. “QR oluştur”a tekrar bas.");
        stamp = isoNow();
        links[slug] = {
          target: form.target,
          title: form.title,
          active: true,
          logo: logoValue,
          style: JSON.parse(JSON.stringify(DEFAULT_STYLE)),
          createdAt: stamp,
          updatedAt: stamp
        };
      }, "qr: " + slug + " oluşturuldu");

      watchPublish(slug, stamp);
      resetCreateForm();
      renderList();
      showResult(slug);
    } catch (e) {
      $("createStatus").textContent = "";
      handleError(e, $("createError"));
    } finally {
      setBusy(false);
    }
  }

  // ---- Düzenleme ----

  function updateEditorLogo() {
    var logo = editor.logo;
    var img = logo.status === "removed" ? null : logo.img;
    $("editLogoImg").hidden = !img;
    if (img) $("editLogoImg").src = img.src;
    var info;
    if (logo.status === "new") info = "Yeni görsel, kaydedince yüklenecek.";
    else if (logo.status === "removed") info = "Görsel kaldırılacak (kaydedince).";
    else if (logo.loading) info = "Mevcut görsel yükleniyor…";
    else if (editor.original.logo) info = img ? "Mevcut görsel" : "Görsel dosyası repoda bulunamadı.";
    else info = "Görsel yok";
    $("editLogoInfo").textContent = info;
    $("editLogoRemove").hidden = !(logo.status === "new" || (logo.status === "keep" && editor.original.logo));
  }

  function openEditor(slug) {
    var entry = data.links[slug];
    if (!entry) return;
    var current = {
      slug: slug,
      original: { logo: entry.logo || null },
      logo: { status: "keep", img: null, dataURL: null, loading: !!entry.logo }
    };
    editor = current;

    $("editForm").reset();
    $("editTitle").value = String(entry.title || "");
    $("editTarget").value = String(entry.target || "");
    $("editError").textContent = "";
    $("editStatus").textContent = "";
    updateEditorLogo();

    if (entry.logo) {
      entryLogo(entry)
        .then(function (img) {
          if (editor !== current) return;
          current.logo.loading = false;
          if (current.logo.status === "keep") current.logo.img = img;
          updateEditorLogo();
        })
        .catch(function () {
          if (editor !== current) return;
          current.logo.loading = false;
          updateEditorLogo();
        });
    }
    showView("editor");
  }

  async function handleEditLogo() {
    var input = $("editLogo");
    var file = input.files[0];
    if (!file || !editor) return;
    var current = editor;
    $("editError").textContent = "";
    try {
      var logo = await prepareLogo(file);
      if (editor !== current) return;
      current.logo = { status: "new", img: logo.img, dataURL: logo.dataURL, loading: false };
      updateEditorLogo();
    } catch (e) {
      input.value = "";
      if (editor === current) $("editError").textContent = e.message;
    }
  }

  function handleEditLogoRemove() {
    if (!editor) return;
    editor.logo = {
      status: editor.original.logo ? "removed" : "keep",
      img: null,
      dataURL: null,
      loading: false
    };
    $("editLogo").value = "";
    updateEditorLogo();
  }

  async function handleSave(ev) {
    ev.preventDefault();
    if (busy || !editor) return;
    var form = readTitleAndTarget($("editTitle"), $("editTarget"));
    $("editError").textContent = form.error || "";
    if (form.error) return;

    var current = editor;
    var slug = current.slug; // ad değişse de slug asla değişmez
    $("editTarget").value = form.target;
    setBusy(true);
    try {
      var logoValue = current.original.logo;
      if (current.logo.status === "new") {
        $("editStatus").textContent = "Görsel yükleniyor…";
        logoValue = await uploadLogo(slug, current.logo.dataURL, current.logo.img);
      } else if (current.logo.status === "removed") {
        logoValue = null;
      }

      $("editStatus").textContent = "Kaydediliyor…";
      var stamp = null;
      await commitLinks(function (links) {
        if (!has(links, slug)) throw userError("Bu QR repoda bulunamadı.");
        var entry = links[slug];
        // active ve style'a dokunulmaz.
        stamp = nextStamp(entry.updatedAt);
        entry.title = form.title;
        entry.target = form.target;
        entry.logo = logoValue;
        entry.updatedAt = stamp;
      }, "qr: " + slug + " güncellendi");

      if (current.logo.status === "removed" && current.original.logo && current.original.logo !== logoValue) {
        removeRepoFile(current.original.logo, "qr: " + slug + " logosu silindi");
      }

      watchPublish(slug, stamp);
      editor = null;
      renderList();
      if (resultSlug === slug) showResult(slug);
      showView("main");
    } catch (e) {
      $("editStatus").textContent = "";
      handleError(e, $("editError"));
    } finally {
      setBusy(false);
    }
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

  $("createForm").addEventListener("submit", handleCreate);
  $("createLogo").addEventListener("change", handleCreateLogo);
  $("createLogoRemove").addEventListener("click", function () {
    $("createLogo").value = "";
    handleCreateLogo();
  });

  $("resultCopyBtn").addEventListener("click", function () {
    var btn = this;
    copyText(shortLink(resultSlug)).then(
      function () { flash(btn, "Kopyalandı"); },
      function () { flash(btn, "Kopyalanamadı"); }
    );
  });
  $("resultPngBtn").addEventListener("click", function () { downloadEntry(resultSlug, "png", $("createError")); });
  $("resultSvgBtn").addEventListener("click", function () { downloadEntry(resultSlug, "svg", $("createError")); });

  $("editForm").addEventListener("submit", handleSave);
  $("editLogo").addEventListener("change", handleEditLogo);
  $("editLogoRemove").addEventListener("click", handleEditLogoRemove);
  $("backBtn").addEventListener("click", function () {
    if (busy) return;
    editor = null;
    showView("main");
  });

  autoLogin();
})();
