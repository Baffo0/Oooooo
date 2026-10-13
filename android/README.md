# Cabine Fibra – app Android

Questa cartella contiene l'app Android di **Cabine Fibra**: un guscio nativo leggero
(una sola schermata con una WebView) attorno alla stessa web app che sta in `../public`.
Rispetto al sito aperto nel browser, l'app aggiunge:

- l'icona sul telefono e l'apertura a schermo intero;
- il GPS con il permesso di posizione di Android;
- le foto scattate direttamente con la fotocamera o scelte dalla galleria;
- i collegamenti di navigazione aperti in Google Maps / Waze;
- la condivisione dei file esportati (WhatsApp, email, Drive…).

## Installare l'APK di prova

Ogni modifica a `android/` o `public/` fa partire su GitHub Actions la compilazione
dell'APK, che viene pubblicato sempre allo stesso indirizzo:

**https://github.com/Baffo0/Oooooo/releases/download/apk-test/cabine-fibra.apk**

1. **Solo Samsung Galaxy**: disattiva **Blocco automatico** (*Auto Blocker*) in
   **Impostazioni → Sicurezza e privacy → Blocco automatico**. Sui Samsung recenti è
   attivo di serie e blocca in silenzio ogni APK che non arriva da Play Store o Galaxy
   Store: il download arriva al 100% ma l'installazione non parte. Puoi riattivarlo dopo
   l'installazione (l'app continua a funzionare; va disattivato di nuovo solo per
   installare un aggiornamento).
2. Apri il link dal telefono con **Chrome** o **Samsung Internet** (non dall'app in cui
   hai ricevuto il link, che di solito non può installare app). Se il browser avvisa che
   il file potrebbe essere dannoso, tocca **Scarica comunque**.
3. Apri il file scaricato dalla notifica del download oppure dall'app **Archivio**
   (*My Files*) → **Download** → `cabine-fibra.apk`.

   **Se il download resta fermo al 100%** (succede con alcune versioni di Chrome per
   Android con i file APK): scarica lo stesso APK dentro uno ZIP,
   **https://github.com/Baffo0/Oooooo/releases/download/apk-test/cabine-fibra.zip**,
   poi apri **Archivio → Download → `cabine-fibra.zip` → Estrai** e tocca
   `cabine-fibra.apk`. In alternativa usa **Samsung Internet** al posto di Chrome.
4. La prima volta Android chiede di consentire a quell'app di **«installare app
   sconosciute»**: attiva l'opzione, torna indietro e tocca **Installa**.
5. Se compare **Play Protect** («app non riconosciuta»), tocca **Altri dettagli →
   Installa comunque**.
6. Le build successive si installano come **aggiornamento** (sono firmate tutte con la
   stessa chiave di prova): le cabine salvate sul telefono restano.

L'APK di ogni build si trova anche tra gli *artifact* dell'esecuzione in
**Actions → APK Android** (file `cabine-fibra-apk`).

## Le due modalità

Al primo avvio l'app mostra la pagina di scelta (si riapre anche dal menu della web app):

| Modalità | Dove stanno le cabine | Quando usarla |
| --- | --- | --- |
| **Prova sul telefono** | Solo su questo telefono (IndexedDB della WebView). La web app è quella inclusa nell'APK. | Per provare l'app senza server, anche offline. |
| **Server della squadra** | Sul server Node (`server.js`), condivise con tutta la squadra. | Uso reale. Le correzioni pubblicate sul server arrivano senza reinstallare l'APK. |

Cambiare modalità non cancella le cabine salvate sul telefono. Per il server serve un
indirizzo **https** (senza https il GPS non funziona); un indirizzo `http://` in rete
locale va bene solo per prove. Se il server rimanda da `http://` allo stesso indirizzo in
`https://`, l'app adotta da sola l'indirizzo https; un rimando verso un altro indirizzo
riporta invece alla pagina di scelta, con la spiegazione.

Se il server non risponde, risponde con un errore (5xx) o all'indirizzo non c'è la web app,
l'app torna alla pagina di scelta; dalla pagina di un sito che non è la web app anche il
tasto **Indietro** riporta lì.

## Come funziona (per chi sviluppa)

- `app/src/main/java/it/cabinefibra/mappa/MainActivity.java` – l'unica Activity.
- `app/src/main/web/` – la pagina di scelta modalità (`setup.html`, `setup.js`, `setup.css`).
- A ogni build il task Gradle `syncWebAssets` copia `../public/**` e `app/src/main/web/**`
  negli asset dell'APK (`www/`) e scrive `www/config.js` con
  `window.CABINE_CONFIG = { local: true };`. Nota: Android esclude dagli asset i file che
  iniziano con `.` e le cartelle che iniziano con `_`.
- In modalità locale le pagine sono servite da
  `https://appassets.androidplatform.net/assets/www/` (WebViewAssetLoader), un'origine
  https vera: GPS, IndexedDB e service worker funzionano come su un sito.
- La web app parla con Android tramite `window.CabineApp`: `getMode()`, `getServerUrl()`,
  `getVersion()`, `useLocal()`, `useServer(url)`, `openSettings()`,
  `shareFile(nome, mimeType, testo)`, `keepScreenOn(bool)`, `openExternal(url)`.
  `useLocal()` e `useServer(url)` funzionano solo dalle pagine incluse nell'APK (pagina di
  scelta, web app locale): dal server si cambia modalità con `openSettings()`.
  Il tasto Indietro chiama prima `window.cabineBack()` (se restituisce `true` lo ha gestito
  la web app; se la funzione non esiste la pagina non è la web app e si torna alla scelta).
- Fiducia https: `res/xml/network_security_config.xml` aggiunge ai certificati di sistema
  le radici Let's Encrypt (`res/raw/isrg_root_x1.pem`, `isrg_root_x2.pem`), che mancano ad
  Android 7.0.
- Lo user agent termina con `CabineFibraApp/<versione>`.

## Compilare in locale

Serve un Android SDK (API 35) e Java 17.

- **Android Studio**: *File → Open* sulla cartella `android/`, poi *Run* oppure
  *Build → Build APK(s)*.
- **Riga di comando** (con `ANDROID_HOME` impostato o un file `local.properties` con
  `sdk.dir=/percorso/android-sdk`):

  ```sh
  cd android
  ./gradlew assembleDebug
  # APK: app/build/outputs/apk/debug/app-debug.apk
  ```

## Sicurezza della build di prova

La chiave `app/debug.keystore` è solo **di prova** (password `android`) ed è nel
repository apposta, perché ogni build si installi sopra la precedente.

> **Attenzione:** la chiave è pubblica. Chiunque può firmare con essa un APK che Android
> installa come *aggiornamento* di questa app, ereditando i suoi dati (cabine salvate sul
> telefono, accesso al server, permesso di posizione). Installa e aggiorna l'app **solo**
> dal link ufficiale
> https://github.com/Baffo0/Oooooo/releases/download/apk-test/cabine-fibra.apk
> e mai da file ricevuti in chat o via email. Finché si usa questa build, evita i dati
> reali della squadra.

Inoltre è una build *debug*: con il telefono sbloccato e collegato via USB (opzioni
sviluppatore attive) i dati dell'app sono leggibili. Prima dell'uso reale servono:

- una chiave privata tenuta fuori dal repository (ad esempio nei *secret* di GitHub,
  decodificata dalla CI al momento della build) — la stessa chiave poi per sempre;
- una build *release* (non debuggabile).

Nota: gli APK firmati con la chiave di prova non si aggiornano con quelli firmati con la
chiave vera: al passaggio bisognerà disinstallare l'app di prova.
