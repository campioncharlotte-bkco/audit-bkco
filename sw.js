/* Service worker minimal : il rend l'application installable et permet de
   l'ouvrir sans barre de navigateur. Il ne met rien en cache — l'app va
   toujours chercher la dernière version en ligne, ce qui évite d'expliquer
   à sept directeurs comment vider un cache. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
