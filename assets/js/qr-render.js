// QR çizimi: canvas + SVG. Bağımlılık: /vendor/qrcode.min.js (qrcode-generator 1.4.4)
(function () {
  "use strict";

  if (typeof window.qrcode !== "function") {
    throw new Error("qr-render.js: önce vendor/qrcode.min.js yüklenmeli.");
  }
  // Türkçe karakterler vb. için Byte modunda UTF-8 kodla.
  window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"];

  var ECL_LEVELS = ["L", "M", "Q", "H"];
  var MAX_LOGO_SCALE = 0.28;
  var PLATE_PADDING = 1.12; // logo zemini logodan %12 büyük
  var PLATE_RADIUS = 0.15; // köşe yarıçapı, zeminin kısa kenarına oran

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function num(n) {
    return Math.round(n * 10000) / 10000;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Satır satır ardışık koyu modülleri tek dikdörtgende birleştir.
  function darkRuns(qr, count) {
    var runs = [];
    for (var row = 0; row < count; row++) {
      var col = 0;
      while (col < count) {
        if (!qr.isDark(row, col)) {
          col++;
          continue;
        }
        var start = col;
        while (col < count && qr.isDark(row, col)) col++;
        runs.push({ row: row, col: start, len: col - start });
      }
    }
    return runs;
  }

  // Logonun QR içindeki kutusu (modül biriminde, merkeze göre).
  function logoBox(logo, count, logoScale) {
    var iw = logo.naturalWidth || logo.width;
    var ih = logo.naturalHeight || logo.height;
    if (!iw || !ih) return null;
    var box = count * Math.min(Math.max(logoScale, 0), MAX_LOGO_SCALE);
    // contain: en-boy oranını koruyarak kutuya sığdır
    var ratio = Math.min(box / iw, box / ih);
    var w = iw * ratio;
    var h = ih * ratio;
    var pw = w * PLATE_PADDING;
    var ph = h * PLATE_PADDING;
    return { w: w, h: h, pw: pw, ph: ph, pr: Math.min(pw, ph) * PLATE_RADIUS };
  }

  function imageToDataURL(img) {
    if (/^data:/i.test(img.src || "")) return img.src;
    var c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  function renderQR(options) {
    var opts = options || {};
    var text = opts.text;
    var fg = opts.fg || "#000000";
    var bg = opts.bg || "#ffffff";
    var quiet = opts.quiet == null ? 4 : Math.max(0, Math.floor(opts.quiet));
    var logo = opts.logo || null;
    var logoScale = opts.logoScale == null ? 0.22 : Number(opts.logoScale);
    var size = Math.max(1, Math.floor(opts.size || 512));
    var ecl = String(opts.ecl || "M").toUpperCase();
    if (ECL_LEVELS.indexOf(ecl) === -1) ecl = "M";
    if (logo) ecl = "H"; // logo modüllerin bir kısmını kapatır

    if (typeof text !== "string" || text === "") {
      throw new Error("QR metni boş olamaz.");
    }

    var qr = window.qrcode(0, ecl);
    qr.addData(text, "Byte");
    try {
      qr.make();
    } catch (e) {
      throw new Error("Metin, " + ecl + " hata düzeltme seviyesi için çok uzun.");
    }

    var count = qr.getModuleCount();
    var total = count + quiet * 2;
    var runs = darkRuns(qr, count);
    var box = logo ? logoBox(logo, count, logoScale) : null;

    // Keskin modüller için tam sayı ölçek; artan pikseller kenar boşluğuna eklenir.
    var cell = Math.max(1, Math.floor(size / total));
    var canvasSize = Math.max(size, total * cell);
    var offset = Math.floor((canvasSize - total * cell) / 2);

    var canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = fg;
    runs.forEach(function (r) {
      ctx.fillRect(
        offset + (quiet + r.col) * cell,
        offset + (quiet + r.row) * cell,
        r.len * cell,
        cell
      );
    });

    if (box) {
      var center = offset + (total * cell) / 2;
      var pw = box.pw * cell;
      var ph = box.ph * cell;
      ctx.fillStyle = bg;
      roundRectPath(ctx, center - pw / 2, center - ph / 2, pw, ph, box.pr * cell);
      ctx.fill();
      // Logo küçültülürken bozulmasın diye yalnızca logo için yumuşatma açık.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      var lw = box.w * cell;
      var lh = box.h * cell;
      ctx.drawImage(logo, center - lw / 2, center - lh / 2, lw, lh);
      ctx.imageSmoothingEnabled = false;
    }

    function toPNGBlob() {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error("PNG oluşturulamadı."));
        }, "image/png");
      });
    }

    function toSVGString() {
      var d = runs
        .map(function (r) {
          return "M" + (quiet + r.col) + " " + (quiet + r.row) + "h" + r.len + "v1h-" + r.len + "z";
        })
        .join("");

      var parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
          '" viewBox="0 0 ' + total + " " + total + '">',
        '<rect width="' + total + '" height="' + total + '" fill="' + escapeAttr(bg) + '"/>',
        '<path d="' + d + '" fill="' + escapeAttr(fg) + '" shape-rendering="crispEdges"/>'
      ];

      if (box) {
        var c = total / 2;
        parts.push(
          '<rect x="' + num(c - box.pw / 2) + '" y="' + num(c - box.ph / 2) +
            '" width="' + num(box.pw) + '" height="' + num(box.ph) +
            '" rx="' + num(box.pr) + '" fill="' + escapeAttr(bg) + '"/>',
          '<image href="' + escapeAttr(imageToDataURL(logo)) +
            '" x="' + num(c - box.w / 2) + '" y="' + num(c - box.h / 2) +
            '" width="' + num(box.w) + '" height="' + num(box.h) + '"/>'
        );
      }

      parts.push("</svg>");
      return parts.join("");
    }

    return { canvas: canvas, toPNGBlob: toPNGBlob, toSVGString: toSVGString };
  }

  window.renderQR = renderQR;
})();
