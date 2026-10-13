'use strict';

// Pagina di scelta modalità dell'app Android. Parla con il codice nativo tramite
// window.CabineApp (MainActivity.Bridge); aperta in un browser normale, CabineApp non
// esiste e i pulsanti mostrano solo un messaggio, così la pagina si può provare ovunque.
(function () {
  var PROBE_TIMEOUT_MS = 8000;
  var app = window.CabineApp || null;

  var el = function (id) { return document.getElementById(id); };
  var banner = el('banner');
  var input = el('server-url');
  var warning = el('server-warning');
  var errorBox = el('server-error');
  var connectBtn = el('connect');
  var anywayBtn = el('connect-anyway');

  // Chiamata protetta al ponte nativo: undefined se non c'è o se lancia un errore.
  function callApp(name, args) {
    if (!app || typeof app[name] !== 'function') return undefined;
    try {
      return app[name].apply(app, args || []);
    } catch (e) {
      return undefined;
    }
  }

  function showBanner(text, kind) {
    banner.textContent = text;
    banner.className = 'banner' + (kind === 'info' ? ' info' : '');
    banner.hidden = !text;
    if (text) banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function noAppMessage() {
    showBanner("Questa pagina funziona dentro l'app Android Cabine Fibra: qui nel browser i pulsanti non cambiano nulla.", 'info');
  }

  function showError(text) {
    errorBox.textContent = text;
    errorBox.hidden = !text;
  }

  // Accetta "cabine.ditta.it", "https://cabine.ditta.it/", "http://192.168.1.10:3000".
  // Restituisce { url, insecure, guessedScheme } oppure { error }.
  function normalizeUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return { error: "Scrivi l'indirizzo del server." };
    var guessedScheme = false;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      text = 'https://' + text;
      guessedScheme = true;
    }
    if (!/^https?:\/\//i.test(text)) {
      return { error: "L'indirizzo deve iniziare con http:// o https://" };
    }
    var parsed;
    try {
      parsed = new URL(text);
    } catch (e) {
      return { error: "Questo indirizzo non è valido. Esempio: https://cabine.tuodominio.it" };
    }
    if (!parsed.hostname || /\s/.test(text)) {
      return { error: "Questo indirizzo non è valido. Esempio: https://cabine.tuodominio.it" };
    }
    // Teniamo un eventuale percorso (server sotto una sottocartella), mai query e frammento.
    var url = (parsed.origin + parsed.pathname).replace(/\/+$/, '');
    return { url: url, insecure: parsed.protocol === 'http:', guessedScheme: guessedScheme };
  }

  // Controlla che all'indirizzo risponda davvero un server Cabine Fibra:
  // /api/config restituisce JSON con passwordRequired booleano (con CORS aperto).
  function probe(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, PROBE_TIMEOUT_MS);
    });
    var request = fetch(url + '/api/config', {
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || typeof data.passwordRequired !== 'boolean') throw new Error('risposta inattesa');
      return true;
    });
    return Promise.race([request, timeout]).then(
      function (ok) { clearTimeout(timer); return ok; },
      function (err) { clearTimeout(timer); throw err; }
    );
  }

  var pendingUrl = null;

  function setBusy(busy) {
    connectBtn.disabled = busy;
    connectBtn.textContent = busy ? 'Verifica in corso…' : 'Collegati';
  }

  function useServer(url) {
    if (!app) { noAppMessage(); return; }
    callApp('useServer', [url]);
  }

  function offerAnyway(url, message) {
    pendingUrl = url;
    showError(message);
    anywayBtn.hidden = false;
  }

  function onConnect(event) {
    event.preventDefault();
    showBanner('');
    showError('');
    anywayBtn.hidden = true;
    pendingUrl = null;

    var result = normalizeUrl(input.value);
    if (result.error) {
      warning.hidden = true;
      showError(result.error);
      input.focus();
      return;
    }
    input.value = result.url;
    warning.hidden = !result.insecure;

    // Da una pagina https (l'app) il browser blocca le richieste verso http://:
    // non possiamo verificare il server, lasciamo decidere a chi usa l'app.
    if (result.insecure && window.location.protocol === 'https:') {
      offerAnyway(result.url, "Non posso verificare un server senza https. Se l'indirizzo è giusto, tocca «Collegati comunque».");
      return;
    }

    setBusy(true);
    probe(result.url).then(function () {
      setBusy(false);
      if (!app) {
        showBanner('Il server risponde correttamente. Nel browser però non posso cambiare modalità.', 'info');
        return;
      }
      useServer(result.url);
    }, function () {
      setBusy(false);
      var message = 'Il server non risponde o non è un server Cabine Fibra.';
      if (result.guessedScheme) message += ' Se è in rete locale prova a scrivere http:// davanti.';
      offerAnyway(result.url, message);
    });
  }

  // Stato iniziale ------------------------------------------------------------

  var mode = callApp('getMode') || '';
  var savedUrl = callApp('getServerUrl') || '';
  var version = callApp('getVersion');

  if (savedUrl) input.value = savedUrl;

  var currentCard = mode === 'local' ? el('card-local') : mode === 'server' ? el('card-server') : null;
  if (currentCard) {
    currentCard.classList.add('is-current');
    currentCard.querySelector('.badge').hidden = false;
  }

  // Aperta dal menu della web app: si può tornare alla mappa senza cambiare nulla.
  if (mode === 'local' || (mode === 'server' && savedUrl)) {
    el('back').hidden = false;
    document.querySelector('.top').classList.add('has-back');
    el('back').addEventListener('click', function () {
      if (mode === 'local') callApp('useLocal');
      else callApp('useServer', [savedUrl]);
    });
  }

  el('version').textContent = app
    ? 'Versione ' + (version || '?')
    : 'Versione: anteprima nel browser';

  var errore = null;
  try {
    errore = new URLSearchParams(window.location.search).get('errore');
  } catch (e) {
    errore = null;
  }
  if (errore) showBanner(errore);

  // Eventi -----------------------------------------------------------------------

  el('use-local').addEventListener('click', function () {
    if (!app) { noAppMessage(); return; }
    callApp('useLocal');
  });

  el('server-form').addEventListener('submit', onConnect);

  anywayBtn.addEventListener('click', function () {
    if (pendingUrl) useServer(pendingUrl);
  });

  // Se l'indirizzo cambia, l'esito della verifica precedente non vale più.
  input.addEventListener('input', function () {
    anywayBtn.hidden = true;
    pendingUrl = null;
    showError('');
    warning.hidden = !/^http:\/\//i.test(input.value.trim());
  });
})();
