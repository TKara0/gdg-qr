// QR renkleri için kontrast kontrolü (WCAG bağıl parlaklık formülü).
(function () {
  "use strict";

  var MIN_RATIO = 4;

  function parseHex(color) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || "").trim());
    if (!m) return null;
    var hex = m[1];
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    return [0, 2, 4].map(function (i) {
      return parseInt(hex.substr(i, 2), 16);
    });
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Geçersiz renkte NaN döner.
  function contrastRatio(fg, bg) {
    var a = parseHex(fg);
    var b = parseHex(bg);
    if (!a || !b) return NaN;
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Sorun yoksa null, varsa kullanıcıya gösterilecek uyarı metni döner.
  function contrastWarning(fg, bg) {
    var a = parseHex(fg);
    var b = parseHex(bg);
    if (!a || !b) return "Renk değeri geçersiz; #rrggbb biçiminde olmalı.";

    var warnings = [];
    if (luminance(a) > luminance(b)) {
      warnings.push("Ön plan rengi arka plandan açık; bazı okuyucular ters renkli QR'ı okuyamaz.");
    }
    var ratio = contrastRatio(fg, bg);
    if (ratio < MIN_RATIO) {
      warnings.push("Kontrast düşük (" + ratio.toFixed(2) + ":1); en az " + MIN_RATIO + ":1 önerilir.");
    }
    return warnings.length ? warnings.join(" ") : null;
  }

  window.contrastRatio = contrastRatio;
  window.contrastWarning = contrastWarning;
})();
