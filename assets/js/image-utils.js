// Logo dosyası okuma ve normalize etme.
(function () {
  "use strict";

  var MAX_BYTES = 5 * 1024 * 1024;
  var MAX_EDGE = 512;
  var ALLOWED = {
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/webp": ["webp"],
    "image/svg+xml": ["svg"]
  };

  function extensionOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function isAllowed(file) {
    if (Object.prototype.hasOwnProperty.call(ALLOWED, file.type)) return true;
    // Bazı sistemler türü boş bildirir; o zaman uzantıya bak.
    if (file.type) return false;
    var ext = extensionOf(file.name);
    return Object.keys(ALLOWED).some(function (type) {
      return ALLOWED[type].indexOf(ext) !== -1;
    });
  }

  function isSVG(img) {
    return /^data:image\/svg\+xml/i.test(img.src || "");
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("Görsel açılamadı; dosya bozuk ya da desteklenmeyen biçimde olabilir."));
      };
      img.src = src;
    });
  }

  function loadImageFromFile(file) {
    if (!file) {
      return Promise.reject(new Error("Dosya seçilmedi."));
    }
    if (!isAllowed(file)) {
      return Promise.reject(
        new Error("Desteklenmeyen dosya türü. Yalnızca PNG, JPG, WEBP veya SVG yükleyebilirsiniz.")
      );
    }
    if (file.size > MAX_BYTES) {
      var mb = (file.size / (1024 * 1024)).toFixed(1);
      return Promise.reject(new Error("Dosya çok büyük (" + mb + " MB). En fazla 5 MB olabilir."));
    }

    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var src = String(reader.result);
        // Türü boş gelen SVG'lerin tarayıcıda çizilebilmesi için doğru MIME ver.
        if (!file.type && extensionOf(file.name) === "svg") {
          src = src.replace(/^data:[^;,]*/, "data:image/svg+xml");
        }
        resolve(loadImage(src));
      };
      reader.onerror = function () {
        reject(new Error("Dosya okunamadı."));
      };
      reader.readAsDataURL(file);
    });
  }

  // En uzun kenar 512px'i geçmeyecek şekilde küçültür (SVG her zaman 512px'e
  // rasterize edilir), şeffaflığı koruyarak PNG üretir.
  function normalizeLogo(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) {
      // Boyutu tanımsız SVG'ler
      w = MAX_EDGE;
      h = MAX_EDGE;
    }
    var longest = Math.max(w, h);
    var scale = longest > MAX_EDGE || isSVG(img) ? MAX_EDGE / longest : 1;
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));

    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cw, ch);

    var dataURL = canvas.toDataURL("image/png");
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("Logo PNG'ye dönüştürülemedi."));
          return;
        }
        resolve({ dataURL: dataURL, blob: blob, width: cw, height: ch });
      }, "image/png");
    });
  }

  window.loadImageFromFile = loadImageFromFile;
  window.normalizeLogo = normalizeLogo;
})();
