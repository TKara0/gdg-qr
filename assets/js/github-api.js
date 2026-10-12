// GitHub REST API (Contents) için küçük istemci. Token yalnızca Authorization
// başlığında kullanılır; hiçbir yere yazılmaz, loglanmaz.
(function () {
  "use strict";

  var API = "https://api.github.com";
  var ZERO_SHA = "0000000000000000000000000000000000000000";

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function apiError(status, message) {
    var err = new Error(message);
    err.status = status;
    return err;
  }

  function messageFor(status, body, rateLimited) {
    var detail = body && body.message ? " (" + body.message + ")" : "";
    if (rateLimited) return "GitHub istek sınırı aşıldı. Biraz bekleyip tekrar dene.";
    switch (status) {
      case 401:
        return "Token geçersiz ya da süresi dolmuş.";
      case 403:
        return "Token'ın bu işlem için yetkisi yok" + detail + ".";
      case 404:
        return "GitHub'da bulunamadı.";
      case 409:
        return "Dosya başka bir yerden değiştirilmiş (çakışma).";
      case 422:
        return "GitHub isteği reddetti" + detail + ".";
      default:
        return "GitHub hatası: " + status + detail + ".";
    }
  }

  function createClient(token, owner, repo, branch) {
    var repoPath = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);

    async function request(method, path, body) {
      var headers = {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28"
      };
      if (body) headers["Content-Type"] = "application/json";

      var res;
      try {
        res = await fetch(API + path, {
          method: method,
          headers: headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store"
        });
      } catch (e) {
        throw apiError(0, "GitHub'a bağlanılamadı. İnternet bağlantını kontrol et.");
      }

      var json = null;
      try {
        json = await res.json();
      } catch (e) {
        // Gövdesiz yanıt
      }
      if (!res.ok) {
        var rateLimited =
          (res.status === 403 || res.status === 429) &&
          res.headers.get("x-ratelimit-remaining") === "0";
        var err = apiError(res.status, messageFor(res.status, json, rateLimited));
        err.rateLimited = rateLimited;
        throw err;
      }
      return json;
    }

    function contentsPath(path) {
      return repoPath + "/contents/" + encodePath(path);
    }

    function getRepo() {
      return request("GET", repoPath);
    }

    // Dosya yoksa null döner. content base64'tür (boşluksuz).
    async function getFile(path) {
      var json;
      try {
        json = await request("GET", contentsPath(path) + "?ref=" + encodeURIComponent(branch));
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
      if (!json || json.type !== "file") throw apiError(422, path + " bir dosya değil.");
      if (json.encoding === "none") {
        throw apiError(422, path + " 1 MB'tan büyük; Contents API ile okunamıyor.");
      }
      return { sha: json.sha, content: String(json.content || "").replace(/\s/g, "") };
    }

    function putFile(path, base64, message, sha) {
      var body = { message: message, content: base64, branch: branch };
      if (sha) body.sha = sha;
      return request("PUT", contentsPath(path), body);
    }

    function deleteFile(path, sha, message) {
      return request("DELETE", contentsPath(path), { message: message, sha: sha, branch: branch });
    }

    // Yazma iznini commit oluşturmadan sınar: dosyanın mevcut içeriğini hiçbir
    // blob'la eşleşmeyecek bir sha ile PUT eder. Token yazabiliyorsa GitHub sha
    // uyuşmazlığı (409/422) döner; yazamıyorsa 403/404.
    async function canWrite(path, currentBase64) {
      try {
        await putFile(path, currentBase64, "yetki kontrolü", ZERO_SHA);
        return true;
      } catch (e) {
        if (e.rateLimited) throw e;
        if (e.status === 409 || e.status === 422) return true;
        if (e.status === 403 || e.status === 404) return false;
        throw e;
      }
    }

    return {
      getRepo: getRepo,
      getFile: getFile,
      putFile: putFile,
      deleteFile: deleteFile,
      canWrite: canWrite
    };
  }

  window.GitHubAPI = {
    createClient: createClient,
    utf8ToBase64: utf8ToBase64,
    base64ToUtf8: base64ToUtf8
  };
})();
