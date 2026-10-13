# Mappa Cabine Fibra

Web app per **localizzare e salvare le posizioni delle cabine della fibra** (Open Fiber: armadi PFP, PFS, PTE, PCN, pozzetti, muffole…) dove lavora la squadra.
Le cabine salvate da un collega compaiono subito sulla mappa di tutti gli altri.

Pensata per il telefono, in strada: si apre dal browser e si può aggiungere alla schermata Home come un'app.

## Cosa fa

- **Si apre come Google Maps**: la mappa parte da dove sei (pallino blu, con la direzione di marcia quando ti muovi) e intorno vedi i segnaposto delle cabine. Avvicinandoti compare anche il nome di ogni cabina.
- **Mappa stradale, satellite con i nomi delle vie oppure OpenStreetMap**, con i segnaposto colorati per stato: blu *da fare*, arancione *in corso*, verde *fatto*, rosso *problema*.
- **Barra di ricerca con suggerimenti**: trova le cabine per codice, indirizzo o note, oppure cerca un indirizzo qualsiasi e aggiungi una cabina in quel punto. Sotto la barra ci sono i filtri rapidi per stato.
- **Percorsi in auto e a piedi dentro l'app**: tempo, distanza, orario di arrivo ed elenco delle svolte in italiano. Con **Avvia** parte la navigazione passo passo: la mappa ti segue, mostra la prossima svolta e la distanza, e ricalcola il percorso se sbagli strada. Lo schermo resta acceso. Per la guida con la voce restano i tasti per Google Maps e Waze.
- **Salva la posizione con il GPS** ("Sono qui adesso") oppure **scegliendo il punto sulla mappa** con il mirino. Su computer basta il tasto destro sulla mappa, su telefono una pressione prolungata.
- **Scheda della cabina**: codice, tipo, indirizzo (rilevato in automatico), note, precisione del GPS, distanza da te, chi l'ha aggiunta e quando.
- **Foto** (fino a 6 per cabina): vengono ridotte sul telefono prima dell'invio, così si caricano anche con poco segnale.
- **Diario interventi**: ogni collega annota cosa ha fatto, con nome e data.
- **Elenco con ricerca e filtri**, ordinato per distanza da dove sei.
- **Funziona anche senza campo**: l'ultima copia delle cabine resta sul telefono, e le cabine aggiunte offline vengono inviate da sole quando torna la connessione.
- **Esportazione** in Excel (CSV), Google Earth (KML) e GeoJSON, utile anche come backup.
- **Accesso con password di squadra**: ognuno entra col proprio nome, così si vede chi ha fatto cosa.

## App Android

C'è anche un'app Android (APK) da installare sul telefono. L'ultima versione si scarica sempre da qui:
<https://github.com/Baffo0/Oooooo/releases/download/apk-test/cabine-fibra.apk>

Se sul telefono il download dell'APK resta fermo al 100%, c'è lo stesso file dentro uno ZIP da aprire con l'app Archivio: <https://github.com/Baffo0/Oooooo/releases/download/apk-test/cabine-fibra.zip>

Al primo avvio si sceglie come usarla:

- **Prova sul telefono**: funziona subito, senza server. Le cabine restano salvate solo su quel telefono.
- **Server della squadra**: si inserisce l'indirizzo del sito (vedi sotto come metterlo online) e le cabine sono condivise con i colleghi.

Si può cambiare in ogni momento dal menu in alto a destra, alla voce **Modalità e server**. Dettagli in [android/README.md](android/README.md).

**Sui Samsung Galaxy** prima di installare va disattivato **Blocco automatico** (Impostazioni → Sicurezza e privacy → Blocco automatico): è attivo di serie e blocca gli APK scaricati fuori dagli store. I passaggi completi sono in [android/README.md](android/README.md#installare-lapk-di-prova).

L'APK viene costruito automaticamente da GitHub Actions a ogni modifica (file `.github/workflows/android.yml`).

## Provarlo sul computer

Serve [Node.js](https://nodejs.org) 18 o più recente. Non ci sono dipendenze da installare.

```bash
TEAM_PASSWORD=scegli-una-password npm start
```

Poi apri <http://localhost:3000>.

## Metterlo online per la squadra

Il sito deve essere raggiungibile in **HTTPS**, altrimenti i telefoni non concedono la posizione GPS.
Deve anche avere un **disco permanente**: i servizi gratuiti senza disco cancellano i dati a ogni riavvio.

### Opzione 1: Render (la più semplice, circa 7 $ al mese)

1. Crea un account su [render.com](https://render.com) e collega il tuo GitHub.
2. Scegli **New → Blueprint** e seleziona questo repository: Render legge `render.yaml` e crea il servizio con il disco dei dati.
3. Quando lo chiede, inserisci la **TEAM_PASSWORD** da dare ai colleghi.
4. Al termine ricevi un indirizzo `https://….onrender.com` da condividere con la squadra.

### Opzione 2: server tuo o Raspberry Pi con Docker

```bash
docker build -t mappa-cabine .
docker run -d --name mappa-cabine --restart unless-stopped \
  -p 3000:3000 -e TEAM_PASSWORD=scegli-una-password \
  -v cabine-dati:/data mappa-cabine
```

Metti davanti un proxy con HTTPS, per esempio [Caddy](https://caddyserver.com): `caddy reverse-proxy --from cabine.tuodominio.it --to localhost:3000`.

### Impostazioni

| Variabile | A cosa serve | Predefinito |
| --- | --- | --- |
| `TEAM_PASSWORD` | Password che i colleghi inseriscono per entrare. Se la cambi, tutti devono rientrare. | nessuna: **sito aperto a chiunque**, da usare solo per prova |
| `DATA_DIR` | Cartella dove vengono salvate cabine (`cabinets.json`) e foto | `./data` |
| `PORT` | Porta del server | `3000` |
| `SESSION_DAYS` | Dopo quanti giorni bisogna rifare l'accesso | `90` |
| `SESSION_SECRET` | Chiave per firmare gli accessi. Se manca viene generata e salvata in `DATA_DIR` | generata |

## Sul telefono

- **Android (Chrome)**: menu ⋮ → *Aggiungi a schermata Home*.
- **iPhone (Safari)**: tasto Condividi → *Aggiungi alla schermata Home*.

Al primo utilizzo del GPS il telefono chiede il permesso per la posizione: va concesso.

## Backup

Tutti i dati stanno nella cartella `DATA_DIR`: il file `cabinets.json` e la sottocartella `photos/`. Basta copiarla.
In alternativa, dal menu in alto a destra si scarica in ogni momento l'elenco completo in CSV, KML o GeoJSON.

## Sviluppo

```bash
npm test
```

- `server.js`: server HTTP e API, usa solo moduli integrati di Node.js.
- `public/`: l'interfaccia (HTML, CSS, JavaScript), con [Leaflet](https://leafletjs.com) incluso in `public/vendor/`.
- `public/routing.js`: calcolo dei percorsi, indicazioni in italiano e avanzamento durante la navigazione.

## Servizi di mappe usati

Sono tutti gratuiti e non serve nessuna chiave o registrazione:

- mappa stradale: [OpenFreeMap](https://openfreemap.org) (stile "liberty", mappe vettoriali disegnate con [MapLibre](https://maplibre.org)) su dati © [OpenStreetMap](https://www.openstreetmap.org/copyright); se non risponde l'app passa da sola alle tile di OpenStreetMap;
- satellite: Esri World Imagery, con le scritte di vie e luoghi di OpenFreeMap;
- percorsi: [OSRM](https://project-osrm.org) sul server pubblico di [FOSSGIS](https://routing.openstreetmap.de);
- indirizzi: [Nominatim](https://nominatim.org).

Sono servizi pubblici pensati per un uso moderato, che per una squadra va benissimo. Se l'app dovesse essere usata da un'intera azienda, conviene verificare le condizioni d'uso di OpenFreeMap, Esri e FOSSGIS oppure passare a un fornitore a pagamento.
