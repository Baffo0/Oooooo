# Mappa Cabine Fibra

Web app per **localizzare e salvare le posizioni delle cabine della fibra** (Open Fiber: armadi PFP, PFS, PTE, PCN, pozzetti, muffole…) dove lavora la squadra.
Le cabine salvate da un collega compaiono subito sulla mappa di tutti gli altri.

Pensata per il telefono, in strada: si apre dal browser e si può aggiungere alla schermata Home come un'app.

## Cosa fa

- **Salva la posizione con il GPS** ("Sono qui adesso") oppure **scegliendo il punto sulla mappa** con il mirino. Su computer basta il tasto destro sulla mappa, su telefono una pressione prolungata.
- **Mappa stradale o satellitare**, con i marcatori colorati per stato: blu *da fare*, arancione *in corso*, verde *fatto*, rosso *problema*.
- **Scheda della cabina**: codice, tipo, indirizzo (rilevato in automatico), note, precisione del GPS, chi l'ha aggiunta e quando.
- **Portami lì**: un tasto apre la navigazione in Google Maps o in Waze.
- **Foto** (fino a 6 per cabina): vengono ridotte sul telefono prima dell'invio, così si caricano anche con poco segnale.
- **Diario interventi**: ogni collega annota cosa ha fatto, con nome e data.
- **Elenco con ricerca e filtri**, ordinato per distanza da dove sei.
- **Funziona anche senza campo**: l'ultima copia delle cabine resta sul telefono, e le cabine aggiunte offline vengono inviate da sole quando torna la connessione.
- **Esportazione** in Excel (CSV), Google Earth (KML) e GeoJSON, utile anche come backup.
- **Accesso con password di squadra**: ognuno entra col proprio nome, così si vede chi ha fatto cosa.

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
- Mappe © [OpenStreetMap](https://www.openstreetmap.org/copyright), immagini satellitari Esri, indirizzi tramite [Nominatim](https://nominatim.org).
