/*
 * Service worker «Толмача», этап 1.
 *
 * Делает ровно одно: принимает «Поделиться → Толмач» (POST /share из
 * share_target в manifest), кладёт присланное в IndexedDB и отправляет на
 * страницу /share?pending=1, которая это разберёт.
 *
 * Ничего не кэширует: старые версии, застрявшие в кэше, в прошлом проекте
 * были главной бедой. Все остальные запросы идут в сеть как обычно.
 *
 * База и хранилище — те же, что у idb-keyval по умолчанию
 * ("keyval-store" / "keyval"), ключ "tolmach-share" (lib/client/share.ts).
 */

var DB_NAME = "keyval-store";
var STORE = "keyval";
var KEY = "tolmach-share";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

function put(value) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function str(v) {
  return typeof v === "string" ? v : null;
}

function handleShare(request) {
  return request
    .formData()
    .then(function (form) {
      var file = form.get("file");
      var record = {
        title: str(form.get("title")),
        text: str(form.get("text")),
        url: str(form.get("url")),
        file: null,
        at: Date.now(),
      };
      if (file && typeof file === "object" && typeof file.arrayBuffer === "function" && file.size > 0) {
        return file.arrayBuffer().then(function (data) {
          record.file = { name: file.name || "", type: file.type || "", data: data };
          return record;
        });
      }
      return record;
    })
    .then(put)
    .then(function () {
      return Response.redirect("/share?pending=1", 303);
    })
    .catch(function () {
      // Не вышло сохранить — страница покажет «нечего добавлять» и подскажет другой путь.
      return Response.redirect("/share?pending=1&failed=1", 303);
    });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "POST") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== "/share") return;
  event.respondWith(handleShare(req));
});
