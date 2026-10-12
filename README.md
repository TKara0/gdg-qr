# QR Sistemi

GitHub Pages üzerinde çalışan, sunucusuz bir **dinamik QR** sistemi. QR koda hedef adres değil, sabit bir kısa link yazılır (`https://<site>/<slug>`). Kısa linkin nereye gideceğini panelden istediğin zaman değiştirebilirsin; basılı QR'lar yeni adrese gitmeye devam eder.

Build adımı, framework, npm veya backend yok. Her şey repo kökünden statik olarak yayınlanır.

---

## Nasıl çalışır?

```
Telefon QR'ı okur
  → https://<site>/linkedin           (böyle bir dosya yok)
  → GitHub Pages 404.html'i sunar
  → redirect.js links.json'u okur
  → "linkedin" kaydı aktifse hedefe yönlendirir
```

- **Veri:** Tüm kayıtlar repodaki [links.json](links.json) dosyasında. Anahtar slug'dır.
- **Yönlendirme:** [404.html](404.html) + [assets/js/redirect.js](assets/js/redirect.js). GitHub Pages bilinmeyen her adres için `404.html`'i sunar; sayfa adresten slug'ı çıkarır, `links.json`'a bakar, yönlendirir.
- **Panel:** [panel/index.html](panel/index.html) tamamen tarayıcıda çalışır. Değişiklikleri GitHub REST API (Contents API) ile doğrudan repoya commit eder. Commit sonrası GitHub Pages siteyi yeniden yayınlar.
- **QR üretimi:** Tarayıcıda, repoya gömülü [vendor/qrcode.min.js](vendor/qrcode.min.js) (qrcode-generator 1.4.4) ile. CDN kullanılmaz.

### Dosyalar

| Dosya | Görevi |
|---|---|
| `config.js` | **Elle düzenlenen tek dosya.** owner, repo, branch, basePath, siteUrl |
| `links.json` | QR kayıtları (panel yönetir, elle düzenleme gerekmez) |
| `404.html`, `assets/js/redirect.js` | Yönlendirici |
| `index.html` | Karşılama sayfası |
| `panel/index.html`, `assets/js/panel.js`, `assets/js/github-api.js`, `assets/css/panel.css` | Yönetim paneli |
| `assets/js/qr-render.js` | QR çizimi (PNG/SVG, logo) |
| `assets/js/image-utils.js` | Logo dosyası okuma ve 512px'e küçültme |
| `assets/js/contrast.js` | Renk kontrastı uyarısı |
| `panel/qr-test.html` | QR modülünü tek başına denemek için test sayfası |
| `assets/logos/` | Panelden yüklenen logolar |
| `vendor/qrcode.min.js` | QR kütüphanesi (yerel kopya) |
| `.nojekyll` | GitHub Pages'in Jekyll işlemesini kapatır |

### links.json kaydı

```json
"linkedin": {
  "target": "https://www.linkedin.com/in/ornek",
  "title": "LinkedIn – yaka kartı",
  "active": true,
  "logo": null,
  "style": { "fg": "#000000", "bg": "#ffffff", "ecl": "H", "logoScale": 0.22 },
  "createdAt": "2026-10-12T00:00:00Z",
  "updatedAt": "2026-10-12T00:00:00Z"
}
```

- **Slug kuralı:** `^[a-z0-9-]{2,40}$`.
- **Ayrılmış slug'lar:** `panel`, `assets`, `vendor`, `index`, `404`, `links`.

---

## Kurulum

### 1. Repo

1. GitHub'da yeni bir repo oluştur (ör. `qr`). Ücretsiz planda GitHub Pages yalnızca **public** repolarda çalışır.
2. Bu klasördeki tüm dosyaları (gizli `.nojekyll` dahil) reponun köküne, `main` dalına gönder:
   ```sh
   git init -b main
   git add .
   git commit -m "QR sistemi"
   git remote add origin https://github.com/<kullanici-adi>/<repo>.git
   git push -u origin main
   ```

> Repo adını `<kullanici-adi>.github.io` koyarsan bir **user site** olur ve site `https://<kullanici-adi>.github.io/` adresinde yayınlanır. Başka her ad bir **project site** olur ve site `https://<kullanici-adi>.github.io/<repo>/` adresinde yayınlanır.

### 2. GitHub Pages

Repo → **Settings → Pages**:
- **Source:** Deploy from a branch
- **Branch:** `main` / `/ (root)` → Save

Birkaç dakika sonra sayfanın üstünde site adresi görünür. Yayın durumunu repodaki **Actions** sekmesinden izleyebilirsin.

### 3. config.js

Sistemde elle düzenlenecek tek dosya [config.js](config.js):

```js
window.QR_CONFIG = {
  owner: "kullanici-adi",   // GitHub kullanıcı adın
  repo: "qr",               // repo adı
  branch: "main",           // Pages'in yayınladığı dal
  basePath: "/qr",          // aşağıdaki tabloya bak
  siteUrl: ""               // özel alan adı yoksa boş bırak
};
```

| Site tipi | basePath | siteUrl | Kısa link örneği |
|---|---|---|---|
| User site (`<owner>.github.io` reposu) | `""` | `""` | `https://owner.github.io/linkedin` |
| Project site (başka ad) | `"/<repo>"` | `""` | `https://owner.github.io/qr/linkedin` |
| Özel alan adı | `""` (**zorunlu**) | `"https://qr.ornek.com"` | `https://qr.ornek.com/linkedin` |

Özel alan adında GitHub Pages siteyi kökten sunar; bu yüzden `siteUrl` doluyken `basePath` mutlaka `""` olmalı. Yanlış ayarla basılan QR'lar ölü linke gideceği için panel bu durumda açılmaz ve hatayı gösterir.

Değişikliği commit edip gönder, ardından yayınlanmasını bekle.

### 4. Erişim token'ı (fine-grained)

Panel, repoya yazmak için senin oluşturduğun bir token kullanır.

1. [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) adresine git (Settings → Developer settings → Personal access tokens → Fine-grained tokens).
2. **Token name:** ör. "QR paneli". **Expiration:** bir süre seç; dolunca yenisini oluşturman gerekir.
3. **Resource owner:** kendi hesabın.
4. **Repository access:** *Only select repositories* → yalnızca QR reposu.
5. **Permissions → Repository permissions → Contents: Read and write.** (Metadata: Read otomatik eklenir.) Başka izin verme.
6. **Generate token** → token'ı kopyala. Bir daha gösterilmez.

### 5. İlk giriş

`https://<site>/panel/` adresini aç, token'ı yapıştır, **Giriş yap**.

Panel token'ı üç adımda doğrular; her biri için ayrı ve açık bir hata mesajı vardır:
- token geçerli mi,
- repoya erişebiliyor mu,
- yazma izni var mı.

Yazma izni commit oluşturmadan sınanır.

### 6. Özel alan adı (önerilir)

Basılı QR'ların ömrü, içlerindeki adresin ömrüyle sınırlıdır. `github.io` adresi GitHub kullanıcı adına ve repo adına bağlıdır (bkz. [Sınırlamalar](#sınırlamalar)). Sana ait bir alan adı bu bağı koparır: repo ya da hesap değişse bile DNS'i yeni yere yönlendirip aynı QR'ları kullanmaya devam edebilirsin.

1. DNS sağlayıcında bir alt alan adı için **CNAME** kaydı ekle: `qr.ornek.com` → `<kullanici-adi>.github.io`.
2. Repo → **Settings → Pages → Custom domain** → `qr.ornek.com` → Save. DNS doğrulanınca **Enforce HTTPS** kutusunu işaretle.
3. `config.js`'te `siteUrl: "https://qr.ornek.com"` ve `basePath: ""` yap, commit et.
4. Panelde kısa linklerin `https://qr.ornek.com/<slug>` olduğunu kontrol et.

**Özel alan adına geçmeden önce bastığın QR'lar** `github.io` adresini taşır. GitHub bu adresleri özel alan adına yönlendirdiği için çalışmaya devam ederler, ama hesap/repo adına bağlı olmaya da devam ederler. Mümkünse özel alan adını **ilk baskıdan önce** kur.

---

## Kullanım

### Yeni QR

1. Panel → **Yeni QR**.
2. **Başlık:** Yazdıkça slug önerilir (ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u). Slug'ı elle değiştirebilirsin. Geçersiz, ayrılmış ya da kullanılan bir slug kaydedilmez.
3. **Hedef link:** Yalnızca `http://` ve `https://` kabul edilir; şema yazmazsan `https://` eklenir. Türkçe karakterler yazdığın gibi saklanır.
4. **Görünüş:** Renkleri, isteğe bağlı logoyu (PNG/JPG/WEBP/SVG, en fazla 5 MB) ve logo boyutunu seç.
   - Logo 512 px PNG'ye küçültülüp `assets/logos/<slug>.png` olarak commit edilir.
   - Logolu QR'lar her zaman en yüksek hata düzeltme seviyesiyle (H) üretilir.
   - Renk kontrastı düşükse ya da ön plan arka plandan açıksa uyarı çıkar.
5. **Kaydet.** Ardından "Yayına alınıyor (~1 dk)" görünür; panel herkese açık `links.json`'u 10 saniyede bir kontrol eder ve değişiklik yayına girince "Yayında" yazar.
6. **PNG indir (2048 px)** ya da **SVG indir**. İndirme yalnızca kayıttan sonra açılır; kaydedilmemiş bir QR basılırsa "Bu QR bulunamadı" gösterir.

QR'ın içine **her zaman kısa link** yazılır, hedef link asla yazılmaz. Önizlemenin altında QR'ın içindeki adres görünür.

### Düzenleme

Listeden bir QR seç (arama başlık, slug ve hedefte çalışır).

- **Hedef link, başlık, aktif/pasif:** Kaydedip yayına girdikten sonra basılı QR'lar da yeni ayarla çalışır.
- **Renkler ve logo:** Yalnızca bundan sonra indireceğin QR'ın görünüşünü değiştirir; basılı QR'lar etkilenmez.
- **Slug:** Değiştirilemez, çünkü basılı QR'lar bu adrese bağlıdır. Farklı bir adres gerekiyorsa yeni bir QR oluştur.

### Silme

- **Sil (devre dışı bırak):** Kaydı silmez, `active: false` yapar. QR "Bu QR şu an devre dışı" gösterir; "Aktif" kutusunu işaretleyip kaydederek geri açabilirsin.
- **Kalıcı olarak sil…:** Sayfa içinde ikinci bir onay ister (slug'ı yazman gerekir). Kayıt ve logosu repodan silinir; QR artık "Bu QR bulunamadı" gösterir. Geri alınamaz; aynı slug ileride yeniden kullanılabilir.

### Yönlendiricinin davranışı

| Durum | Ekranda |
|---|---|
| Kayıt var, aktif, hedef `http(s)://` | Hedefe yönlendirir |
| Kayıt yok, slug geçersiz ya da ayrılmış | "Bu QR bulunamadı" |
| `active` `true` değil | "Bu QR şu an devre dışı" |
| Hedef `javascript:`, `data:`, boş vb. | "Bu QR bulunamadı" (asla açılmaz) |
| `links.json` okunamadı | "Bağlantı kurulamadı" + **Tekrar dene** |
| JavaScript kapalı | Açıklama metni |

- **Adres biçimleri:** Büyük harf (`/LinkedIn`) ve sondaki `/` (`/linkedin/`) tolere edilir.
- **Yedek biçim:** `https://<site>/404.html?k=<slug>`.

### Aynı anda iki yerden kaydetme

Panel `links.json`'u okuduğu sürümün sha'sıyla kaydeder. Bu arada başka bir sekme ya da cihaz dosyayı değiştirdiyse (409/422 çakışması), panel dosyayı yeniden okur, kendi değişikliğini en güncel sürüme tekrar uygular ve bir kez daha dener. Diğer kayıtlardaki değişiklikler korunur.

İki ayrı yerden **aynı slug** oluşturulmaya çalışılırsa ikincisi reddedilir. İkinci deneme de çakışırsa panel bunu söyler; sayfayı yenileyip tekrar dene.

---

## Sınırlamalar

- **Değişiklikler ~1 dakikada yansır.** Her kayıt bir commit'tir ve GitHub Pages'in siteyi yeniden yayınlaması gerekir. Bu genelde 30–60 saniye sürer, yoğun zamanlarda daha uzun olabilir. Panel 3 dakika içinde yayını göremezse bunu söyler; değişiklik yine de repoya kaydedilmiştir (Actions sekmesine bak).
- **Kullanıcı adı veya repo adı değişirse basılı QR'lar ölür.** `github.io` adresleri `https://<kullanici-adi>.github.io/<repo>/...` biçimindedir. GitHub kullanıcı adını değiştirirsen, repoyu yeniden adlandırırsan, taşırsan, silersen ya da Pages'i kapatırsan bu adresleri taşıyan tüm basılı QR'lar çalışmaz. Kalıcı çözüm [özel alan adı](#6-özel-alan-adı-önerilir).
- **Hedef linkler herkese açıktır.** `links.json` sitede yayınlanır ve repo public'tir. Gizli kalması gereken adresleri bu sisteme koyma. Commit geçmişi de tüm eski hedefleri gösterir.
- **Yönlendirme sayfası HTTP 404 durum koduyla gelir.** Bu, GitHub Pages'in `404.html` mekanizmasının doğası. Tarayıcılar sayfayı normal gösterir ve yönlendirir, ama yönlendirme JavaScript ile yapılır; JavaScript kapalıysa çalışmaz.
- **`?k=` yalnızca `404.html` üzerinde çalışır.** Doğru adres `https://<site>/404.html?k=<slug>`. Site köküne verilen `https://<site>/?k=<slug>` karşılama sayfasını açar.
- **Tek yönetici için tasarlandı.** Kullanıcı sistemi ya da yetki ayrımı yok; repoya yazma izni olan token'a sahip herkes her şeyi değiştirebilir.
- **Okutma istatistiği yok.**
- **links.json 1 MB'ı geçmemeli.** Contents API daha büyük dosyaları okuyamaz. Bu sınır binlerce kayda yeter.
- GitHub Pages'in kendi [kullanım sınırları](https://docs.github.com/pages/getting-started-with-github-pages/github-pages-limits) geçerlidir (ör. aylık bant genişliği, saatlik yayın sayısı).

---

## Token güvenliği

- **Kapsamı dar tut.** Token yalnızca bu repoya ve yalnızca *Contents: Read and write* iznine sahip olmalı. Böylece sızsa bile yalnızca bu repodaki dosyalar etkilenir.
- **Panel token'ı nereye yazar:**
  - Yalnızca GitHub API isteklerinin `Authorization` başlığında kullanır.
  - Konsola yazmaz, adres çubuğuna koymaz, repoya commit etmez.
  - Token alanının `name` özelliği yoktur; JavaScript yüklenmese bile form token'ı URL'ye ekleyemez.
- **Saklama:**
  - "Bu cihazda hatırla" seçili değilse token `sessionStorage`'da tutulur ve sekme kapanınca silinir.
  - Seçiliyse `localStorage`'da kalır. **Ortak kullanılan cihazlarda işaretleme.**
  - **Çıkış yap** token'ı her iki yerden de siler.
- **Aynı kökenden okunabilir:** Tarayıcıda saklanan token, aynı kökendeki (origin) tüm sayfalardan JavaScript ile okunabilir. `<kullanici-adi>.github.io` altındaki **bütün** project site'lar aynı kökeni paylaşır; yani diğer Pages repolarındaki kod da bu token'ı okuyabilir. Kendi kodun dışında bir şey barındırmıyorsan risk düşüktür. Özel alan adı kullanmak paneli ayrı bir kökene taşır.
- **Süre:** Token'a son kullanma tarihi ver; dolunca yenisini oluşturup panelde tekrar giriş yap.
- **Sızdıysa:** [Token ayarlarından](https://github.com/settings/personal-access-tokens) hemen iptal et (Revoke). Sonra repo geçmişinde beklenmeyen commit var mı bak.

---

## Yerelde deneme

```sh
cd "<proje klasörü>"
python -m http.server 8000
```

- **Yönlendirme:** `http://localhost:8000/404.html?k=linkedin` (yerelde `basePath` `""` olmalı). Python'un sunucusu bilinmeyen yollar için `404.html` sunmadığından `/<slug>` biçimi yalnızca GitHub Pages'te çalışır.
- **QR modülü:** `http://localhost:8000/panel/qr-test.html`.
- **Panel:** `http://localhost:8000/panel/` gerçek repoya yazar. `siteUrl` boşsa "Yayında" kontrolü yerelde 3 dakika sonra zaman aşımına uğrar: herkese açık `links.json` yerine diskteki dosyaya bakar.
