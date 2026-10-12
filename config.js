// Site ayarları. Sistemde elle düzenlenecek tek dosya budur.
// owner/repo: GitHub kullanıcı adın ve repo adı.
// basePath:
//   - User site (https://<owner>.github.io/)            → ""
//   - Project site (https://<owner>.github.io/<repo>/)  → "/<repo>"
//   - Özel alan adı (ör. https://qr.ornek.com)           → "" (GitHub Pages siteyi kökten sunar)
// siteUrl: Boş bırakılırsa kısa linkler https://<owner>.github.io<basePath>/<slug> olur.
//   Özel alan adı bağladıysan buraya yaz (ör. "https://qr.ornek.com"); bu durumda
//   basePath MUTLAKA "" olmalı.
window.QR_CONFIG = {
  owner: "TKara0",
  repo: "gdg-qr",
  branch: "main",
  basePath: "/gdg-qr",
  siteUrl: ""
};
