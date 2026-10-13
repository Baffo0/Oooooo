package it.cabinefibra.mappa;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Unica schermata dell'app: una WebView che mostra la web app delle cabine.
 *
 * Due modalità, scelte dalla pagina setup.html inclusa nell'APK:
 *  - "local": la web app inclusa negli asset, servita da WebViewAssetLoader su un'origine
 *    https finta (così GPS, IndexedDB e service worker funzionano come su un sito vero);
 *  - "server": la web app del server della squadra, caricata dal suo indirizzo, così le
 *    correzioni pubblicate sul server arrivano senza reinstallare l'APK.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "CabineFibra";

    private static final String ASSET_HOST = WebViewAssetLoader.DEFAULT_DOMAIN; // appassets.androidplatform.net
    private static final String ASSET_BASE = "https://" + ASSET_HOST + "/assets/www/";
    static final String SETUP_URL = ASSET_BASE + "setup.html";
    static final String LOCAL_URL = ASSET_BASE + "index.html";

    private static final String PREFS = "cabine";
    private static final String KEY_MODE = "mode";
    private static final String KEY_SERVER_URL = "serverUrl";
    private static final String MODE_LOCAL = "local";
    private static final String MODE_SERVER = "server";

    private static final String FILE_AUTHORITY = BuildConfig.APPLICATION_ID + ".files";
    private static final String NO_APP_MESSAGE = "Nessuna app per aprire questo collegamento";

    // Tipi MIME espliciti per gli asset: i moduli JS e il service worker vengono rifiutati
    // se il tipo non è JavaScript, e il testo deve essere letto come UTF-8 (accenti).
    private static final Map<String, String> MIME_TYPES = new HashMap<>();

    static {
        MIME_TYPES.put("html", "text/html");
        MIME_TYPES.put("js", "text/javascript");
        MIME_TYPES.put("mjs", "text/javascript");
        MIME_TYPES.put("css", "text/css");
        MIME_TYPES.put("json", "application/json");
        MIME_TYPES.put("webmanifest", "application/manifest+json");
        MIME_TYPES.put("svg", "image/svg+xml");
        MIME_TYPES.put("png", "image/png");
        MIME_TYPES.put("jpg", "image/jpeg");
        MIME_TYPES.put("jpeg", "image/jpeg");
        MIME_TYPES.put("webp", "image/webp");
        MIME_TYPES.put("ico", "image/x-icon");
        MIME_TYPES.put("woff2", "font/woff2");
        MIME_TYPES.put("txt", "text/plain");
    }

    // Chiede alla web app di gestire "indietro" (chiudere un pannello, un dialogo...).
    // Restituisce "noapp" se sulla pagina non c'è la web app (server sbagliato, pagina di
    // errore di un proxy...): in quel caso Indietro riporta alla pagina di scelta.
    private static final String BACK_SCRIPT =
            "(function(){try{if(typeof window.cabineBack!=='function')return 'noapp';"
                    + "return !!window.cabineBack();}catch(e){return false;}})()";

    // Foto della fotocamera in corso, salvata per accorgersi se Android chiude l'app nel frattempo.
    private static final String STATE_CAMERA_FILE = "cameraFile";

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    // Richieste di posizione arrivate mentre aspettiamo la risposta al permesso.
    private final List<GeoRequest> pendingGeoRequests = new ArrayList<>();

    // Scelta foto in corso: la web app aspetta esattamente una risposta su questa callback.
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean pendingFileMultiple;
    private File cameraFile;
    private Uri cameraUri;

    // I launcher vanno registrati prima di onStart: inizializzarli qui è il modo standard.
    private final ActivityResultLauncher<String[]> locationPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(),
                    this::onLocationPermissionResult);

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),
                    this::onFileChooserResult);

    private static final class GeoRequest {
        final String origin;
        final GeolocationPermissions.Callback callback;

        GeoRequest(String origin, GeolocationPermissions.Callback callback) {
            this.origin = origin;
            this.callback = callback;
        }
    }

    // ---------------------------------------------------------------------------------
    // Ciclo di vita
    // ---------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            String photoPath = savedInstanceState.getString(STATE_CAMERA_FILE);
            if (photoPath != null) cameraFile = new File(photoPath);
        }

        // Con targetSdk 35 Android 15 disegna sempre sotto le barre di sistema: facciamo lo
        // stesso anche sulle versioni precedenti e gestiamo noi gli spazi con gli insets.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.accent));
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Il contenuto sta tra barra di stato, barra di navigazione, notch e tastiera;
        // dietro le barre si vede lo sfondo verde della radice.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        // Icone chiare (bianche) sulle barre verdi.
        WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightNavigationBars(false);

        // https://appassets.androidplatform.net/assets/... -> file in assets/ dell'APK.
        // Gli indirizzi che finiscono con "/" ricevono index.html, come su un server web.
        final WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                .addPathHandler("/assets/", path -> {
                    String file = path.isEmpty() || path.endsWith("/") ? path + "index.html" : path;
                    return withMimeType(file, assets.handle(file));
                })
                .build();

        configureWebView();
        setUpServiceWorkerClient();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBack();
            }
        });

        webView.loadUrl(startUrl());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (cameraFile != null) outState.putString(STATE_CAMERA_FILE, cameraFile.getAbsolutePath());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        // I cookie di sessione del server vanno scritti su disco prima che il processo
        // possa essere chiuso dal sistema.
        CookieManager.getInstance().flush();
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        if (webView != null) {
            webView.stopLoading();
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------
    // WebView
    // ---------------------------------------------------------------------------------

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Permette al server (e alla web app) di riconoscere che gira dentro l'APK.
        s.setUserAgentString(s.getUserAgentString() + " CabineFibraApp/" + BuildConfig.VERSION_NAME);

        CookieManager.getInstance().setAcceptCookie(true);

        webView.addJavascriptInterface(new Bridge(), "CabineApp");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
    }

    /**
     * La web app registra un service worker: le richieste fatte DAL service worker non
     * passano da WebViewClient ma da ServiceWorkerClient. Senza questo, in modalità locale
     * il service worker non troverebbe i file degli asset.
     */
    private void setUpServiceWorkerClient() {
        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return assetLoader.shouldInterceptRequest(request.getUrl());
                }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "Service worker non configurabile", e);
        }
    }

    private final class AppWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return assetLoader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isInAppUrl(uri)) return false;

            String scheme = lower(uri.getScheme());
            boolean web = scheme.equals("http") || scheme.equals("https");
            // Redirect del server della squadra (da http:// a https://, verso www., ...).
            // WebView li passa di qui anche per gli indirizzi aperti con loadUrl: non vanno
            // mai aperti fuori, altrimenti a ogni avvio partirebbe il browser e l'app
            // resterebbe bianca senza modo di tornare alla pagina di scelta.
            if (request.isForMainFrame() && request.isRedirect() && web && isServerMode()) {
                return handleServerRedirect(view, uri);
            }
            // Riquadri interni (iframe): le loro navigazioni http(s) non passano di qui
            // (WebView le carica e basta); questa riga copre solo i casi rimasti.
            if (!request.isForMainFrame() && web) return false;
            // Indirizzi interni del browser: niente da aprire fuori.
            if (scheme.equals("about") || scheme.equals("javascript")
                    || scheme.equals("blob") || scheme.equals("data")) {
                return true;
            }
            // Un riquadro interno non può aprire altre app da solo, senza un tocco.
            if (!request.isForMainFrame() && !request.hasGesture()) return true;
            // Google Maps, Waze, siti esterni, geo:, tel:, mailto:, intent://...
            openExternalUrl(uri.toString());
            return true;
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            // Pagina di errore di un proxy (502, 503...) al posto della web app: meglio la
            // pagina di scelta con una spiegazione.
            if (errorResponse == null || !request.isForMainFrame() || !isServerMode()) return;
            final int status = errorResponse.getStatusCode();
            if (status < 500) return;
            if (!sameHost(request.getUrl(), Uri.parse(getSavedServerUrl()))) return;
            Log.w(TAG, "Il server ha risposto " + status);
            view.post(() -> showSetupWithError("Il server ha risposto con un errore (" + status
                    + "). Riprova tra poco o controlla l'indirizzo."));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || !isServerMode()) return;
            Uri server = Uri.parse(getSavedServerUrl());
            if (!sameHost(request.getUrl(), server)) return;
            // ERR_ABORTED arriva anche quando una navigazione viene sostituita da un'altra.
            CharSequence description = error.getDescription();
            if (description != null && description.toString().contains("ERR_ABORTED")) return;
            Log.w(TAG, "Server non raggiungibile: " + error.getErrorCode() + " " + description);
            view.post(() -> showSetupWithError("Server non raggiungibile: controlla la connessione o l'indirizzo."));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Mai proseguire con un certificato non valido.
            handler.cancel();
            String url = error.getUrl();
            if (url != null && isServerMode() && sameHost(Uri.parse(url), Uri.parse(getSavedServerUrl()))) {
                view.post(() -> showSetupWithError("Il certificato https del server non è valido."));
            }
        }
    }

    private final class AppChromeClient extends WebChromeClient {

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            // Risposta immediata solo con la posizione PRECISA. Con la sola approssimativa
            // (Android 12+) si chiede di nuovo: il sistema propone "Posizione precisa" e
            // smette da solo di chiederlo dopo due rifiuti.
            if (hasFineLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingGeoRequests.add(new GeoRequest(origin, callback));
            // Una sola richiesta di permesso alla volta; le altre aspettano la stessa risposta.
            if (pendingGeoRequests.size() == 1) {
                locationPermissionLauncher.launch(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION});
            }
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams fileChooserParams) {
            return showFileChooser(filePathCallback, fileChooserParams);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, message.messageLevel() + " " + message.message()
                        + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
            }
            return true;
        }
    }

    // ---------------------------------------------------------------------------------
    // Modalità e navigazione
    // ---------------------------------------------------------------------------------

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private String getMode() {
        String mode = prefs().getString(KEY_MODE, "");
        return MODE_LOCAL.equals(mode) || MODE_SERVER.equals(mode) ? mode : "";
    }

    private String getSavedServerUrl() {
        return prefs().getString(KEY_SERVER_URL, "");
    }

    private boolean isServerMode() {
        return MODE_SERVER.equals(getMode()) && normalizeServerUrl(getSavedServerUrl()) != null;
    }

    /** Pagina da aprire per la modalità salvata; la pagina di scelta se non ce n'è una. */
    private String startUrl() {
        String mode = getMode();
        if (MODE_LOCAL.equals(mode)) return LOCAL_URL;
        if (MODE_SERVER.equals(mode)) {
            String url = normalizeServerUrl(getSavedServerUrl());
            if (url != null) return url;
        }
        return SETUP_URL;
    }

    private void showSetupWithError(String message) {
        if (webView == null) return;
        String query;
        try {
            query = "?errore=" + URLEncoder.encode(message, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            query = "";
        }
        webView.loadUrl(SETUP_URL + query);
    }

    private void onBack() {
        if (webView == null) return;
        webView.evaluateJavascript(BACK_SCRIPT, value -> {
            if ("true".equals(value) || webView == null) return;
            String current = webView.getUrl();
            if (current != null && current.startsWith(SETUP_URL)) {
                if (!getMode().isEmpty()) {
                    // Dalla pagina di scelta si torna alla mappa della modalità già scelta.
                    webView.loadUrl(startUrl());
                } else {
                    moveTaskToBack(true);
                }
            } else if (!"false".equals(value)) {
                // Sulla pagina non c'è la web app ("noapp" o nessuna risposta): server
                // sbagliato, pagina di errore... Si torna alla scelta della modalità.
                webView.loadUrl(SETUP_URL);
            } else {
                // Come il tasto Home: l'app resta aperta dov'era.
                moveTaskToBack(true);
            }
        });
    }

    /**
     * Redirect del server salvato verso un altro indirizzo. Lo stesso server su https viene
     * adottato (e salvato, così il GPS funziona e i prossimi avvii vanno diretti); qualsiasi
     * altro indirizzo porta alla pagina di scelta con una spiegazione, mai a un'altra app e
     * mai dentro la WebView, che darebbe window.CabineApp a un sito non scelto.
     * Restituisce il valore per shouldOverrideUrlLoading (true = navigazione annullata).
     */
    private boolean handleServerRedirect(WebView view, Uri target) {
        Uri server = Uri.parse(getSavedServerUrl());
        String authority = target.getEncodedAuthority();
        if (sameHost(target, server) && "https".equals(lower(target.getScheme())) && authority != null) {
            String path = server.getEncodedPath();
            String upgraded = normalizeServerUrl("https://" + authority + (path == null ? "" : path));
            if (upgraded != null) {
                prefs().edit().putString(KEY_SERVER_URL, upgraded).apply();
                Log.i(TAG, "Server spostato su " + upgraded);
            }
            return false;
        }
        final String where = lower(target.getScheme()) + "://" + (authority == null ? "" : authority);
        Log.w(TAG, "Redirect del server verso " + where + " bloccato");
        view.post(() -> showSetupWithError("Il server rimanda a " + where
                + ": se è l'indirizzo giusto, scrivilo qui sotto e tocca «Collegati»."));
        return true;
    }

    /** Indirizzi che restano nella WebView: gli asset dell'APK e il server della squadra. */
    private boolean isInAppUrl(Uri uri) {
        if (uri == null) return false;
        if ("https".equals(lower(uri.getScheme())) && ASSET_HOST.equalsIgnoreCase(uri.getHost())) return true;
        return isServerMode() && sameOrigin(uri, Uri.parse(getSavedServerUrl()));
    }

    /** Apre un collegamento con l'app adatta (navigatore, telefono, browser...). */
    private void openExternalUrl(String url) {
        if (url == null || url.trim().isEmpty()) return;
        try {
            // file:// verso un'altra app è vietato da Android 7 (chiuderebbe l'app) e non serve.
            if (url.regionMatches(true, 0, "file:", 0, 5)) {
                Toast.makeText(this, NO_APP_MESSAGE, Toast.LENGTH_SHORT).show();
                return;
            }
            if (url.regionMatches(true, 0, "intent:", 0, 7)) {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                if ("file".equals(lower(intent.getScheme()))) {
                    Toast.makeText(this, NO_APP_MESSAGE, Toast.LENGTH_SHORT).show();
                    return;
                }
                // Come fa Chrome: solo attività pubbliche raggiungibili dal web.
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
                // Un collegamento web non deve poter concedere accesso ai file dell'app.
                intent.setFlags(intent.getFlags() & ~(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION));
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    String fallback = intent.getStringExtra("browser_fallback_url");
                    if (fallback == null || normalizeServerUrl(fallback) == null) throw e;
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fallback)));
                }
                return;
            }
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (RuntimeException | URISyntaxException e) {
            // RuntimeException comprende ActivityNotFoundException, SecurityException e gli
            // errori di Intent.parseUri su collegamenti intent:// malformati.
            Log.w(TAG, "Collegamento non aperto: " + url, e);
            Toast.makeText(this, NO_APP_MESSAGE, Toast.LENGTH_SHORT).show();
        }
    }

    // ---------------------------------------------------------------------------------
    // Posizione
    // ---------------------------------------------------------------------------------

    private boolean hasFineLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void onLocationPermissionResult(Map<String, Boolean> result) {
        boolean granted = false;
        for (Boolean value : result.values()) {
            if (Boolean.TRUE.equals(value)) granted = true;
        }
        // Se il sistema non ha mostrato nulla (es. processo ricreato) vale lo stato attuale.
        granted = granted || hasLocationPermission();
        boolean precise = hasFineLocationPermission();
        List<GeoRequest> requests = new ArrayList<>(pendingGeoRequests);
        pendingGeoRequests.clear();
        for (GeoRequest request : requests) {
            request.callback.invoke(request.origin, granted, false);
        }
        if (requests.isEmpty()) return;
        if (!granted) {
            Toast.makeText(this, "Senza il permesso di posizione il GPS non funziona: puoi attivarlo "
                    + "nelle impostazioni dell'app.", Toast.LENGTH_LONG).show();
        } else if (!precise) {
            Toast.makeText(this, "Posizione approssimativa: attiva «Posizione precisa» nelle "
                    + "impostazioni dell'app per salvare le cabine nel punto giusto.", Toast.LENGTH_LONG).show();
        }
    }

    // ---------------------------------------------------------------------------------
    // Foto (input type=file della web app)
    // ---------------------------------------------------------------------------------

    private boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        // La web app deve ricevere sempre una risposta: chiudiamo una scelta rimasta aperta.
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
        }
        pendingFileCallback = callback;
        pendingFileMultiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        cameraFile = null;
        cameraUri = null;

        // Foto (galleria o fotocamera) oppure un file qualsiasi, es. la mappa KML/KMZ da importare:
        // Android spesso non conosce il tipo dei file KML, quindi per quelli si mostra tutto.
        boolean images = acceptsOnlyImages(params);
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType(images ? "image/*" : "*/*");
        if (pendingFileMultiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

        Intent chooser = Intent.createChooser(pick, images ? "Aggiungi foto" : "Scegli il file");
        Intent camera = images ? createCameraIntent() : null;
        if (camera != null) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
        }

        try {
            fileChooserLauncher.launch(chooser);
        } catch (ActivityNotFoundException e) {
            pendingFileCallback = null;
            callback.onReceiveValue(null);
            Toast.makeText(this, images ? "Nessuna app per scegliere le foto" : "Nessuna app per scegliere i file",
                    Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    /** true se la pagina chiede solo immagini (o non dice cosa), come il campo delle foto. */
    private static boolean acceptsOnlyImages(WebChromeClient.FileChooserParams params) {
        if (params == null || params.getAcceptTypes() == null) return true;
        for (String type : params.getAcceptTypes()) {
            if (type == null) continue;
            for (String part : type.split(",")) {
                String t = part.trim().toLowerCase(Locale.ROOT);
                if (!t.isEmpty() && !t.startsWith("image/")) return false;
            }
        }
        return true;
    }

    /**
     * Fotocamera di sistema che salva la foto in cache/images/ (condivisa con FileProvider).
     * Non serve il permesso CAMERA perché non è dichiarato nel manifest.
     */
    private Intent createCameraIntent() {
        try {
            File dir = new File(getCacheDir(), "images");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            deleteOldFiles(dir);
            File photo = File.createTempFile("foto_", ".jpg", dir);
            Uri uri = FileProvider.getUriForFile(this, FILE_AUTHORITY, photo);

            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.setClipData(ClipData.newRawUri("foto", uri));
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            cameraFile = photo;
            cameraUri = uri;
            return intent;
        } catch (IOException | IllegalArgumentException e) {
            Log.w(TAG, "Fotocamera non disponibile", e);
            return null;
        }
    }

    private void onFileChooserResult(ActivityResult result) {
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        File photo = cameraFile;
        Uri photoUri = cameraUri;
        cameraFile = null;
        cameraUri = null;
        if (callback == null) {
            // Android ha chiuso l'app mentre era aperta la fotocamera o la galleria: la pagina
            // è stata ricaricata e non aspetta più nessuna foto. Almeno lo diciamo.
            Intent lostData = result.getData();
            boolean lost = result.getResultCode() == RESULT_OK
                    && ((photo != null && photo.length() > 0)
                    || (lostData != null && (lostData.getData() != null || lostData.getClipData() != null)));
            if (photo != null && photo.length() == 0) {
                //noinspection ResultOfMethodCallIgnored
                photo.delete();
            }
            if (lost) {
                Toast.makeText(this, "Il file scelto non è arrivato perché Android ha chiuso l'app: riprova.",
                        Toast.LENGTH_LONG).show();
            }
            return;
        }

        Uri[] uris = null;
        Intent data = result.getData();
        if (result.getResultCode() == RESULT_OK) {
            if (data != null) {
                // Galleria: più foto arrivano in ClipData; alcune app mettono lì anche la
                // singola foto lasciando vuoto getData().
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0 && (pendingFileMultiple || data.getData() == null)) {
                    int count = pendingFileMultiple ? clip.getItemCount() : 1;
                    List<Uri> list = new ArrayList<>();
                    for (int i = 0; i < count; i++) {
                        Uri item = clip.getItemAt(i).getUri();
                        boolean emptyPhoto = item != null && item.equals(photoUri)
                                && (photo == null || photo.length() == 0);
                        if (item != null && !emptyPhoto) list.add(item);
                    }
                    if (!list.isEmpty()) uris = list.toArray(new Uri[0]);
                }
                if (uris == null && data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            // Fotocamera: di solito non restituisce dati, la foto è nel file che le abbiamo dato.
            if (uris == null && photo != null && photo.length() > 0) {
                uris = new Uri[]{photoUri};
            }
        }
        // File vuoto della fotocamera non usata: lo togliamo subito.
        if (photo != null && photo.length() == 0) {
            //noinspection ResultOfMethodCallIgnored
            photo.delete();
        }
        callback.onReceiveValue(uris);
    }

    /** Le foto restano in cache il tempo di essere caricate dalla web app, poi si buttano. */
    private static void deleteOldFiles(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long limit = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < limit) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    // ---------------------------------------------------------------------------------
    // Condivisione di file esportati dalla web app
    // ---------------------------------------------------------------------------------

    private void shareText(String name, String mimeType, String content) {
        String safeName = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "");
        if (safeName.isEmpty() || safeName.startsWith(".")) safeName = "esportazione.txt";
        String type = mimeType == null || mimeType.trim().isEmpty() ? "text/plain" : mimeType.trim();

        try {
            File dir = new File(getCacheDir(), "exports");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cartella non creata");
            File file = new File(dir, safeName);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(this, FILE_AUTHORITY, file);

            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(type);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, safeName);
            send.setClipData(ClipData.newRawUri(safeName, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, "Condividi"));
        } catch (IOException | IllegalArgumentException | ActivityNotFoundException e) {
            Log.w(TAG, "Condivisione non riuscita", e);
            Toast.makeText(this, "Condivisione non riuscita", Toast.LENGTH_SHORT).show();
        }
    }

    // ---------------------------------------------------------------------------------
    // Ponte JavaScript: window.CabineApp
    // ---------------------------------------------------------------------------------

    /**
     * Metodi chiamati dalla web app e da setup.html. Girano su un thread della WebView,
     * quindi tutto ciò che tocca l'interfaccia passa da runOnUiThread.
     * Pubblica perché la WebView cerca per riflessione i metodi @JavascriptInterface.
     */
    public final class Bridge {

        @JavascriptInterface
        public String getMode() {
            return MainActivity.this.getMode();
        }

        @JavascriptInterface
        public String getServerUrl() {
            return getSavedServerUrl();
        }

        @JavascriptInterface
        public String getVersion() {
            return BuildConfig.VERSION_NAME;
        }

        // useLocal e useServer cambiano la modalità salvata: valgono solo se la pagina
        // principale è una di quelle incluse nell'APK (pagina di scelta, app locale), così un
        // sito esterno o una pagina manomessa non può dirottare l'app verso un altro server.

        @JavascriptInterface
        public void useLocal() {
            runOnUiThread(() -> {
                if (!isBundledTopPage("useLocal")) return;
                prefs().edit().putString(KEY_MODE, MODE_LOCAL).apply();
                webView.loadUrl(LOCAL_URL);
            });
        }

        @JavascriptInterface
        public void useServer(String url) {
            final String clean = normalizeServerUrl(url);
            if (clean == null) return;
            runOnUiThread(() -> {
                if (!isBundledTopPage("useServer")) return;
                prefs().edit().putString(KEY_MODE, MODE_SERVER).putString(KEY_SERVER_URL, clean).apply();
                webView.loadUrl(clean);
            });
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> {
                if (webView != null) webView.loadUrl(SETUP_URL);
            });
        }

        @JavascriptInterface
        public void shareFile(String name, String mimeType, String content) {
            runOnUiThread(() -> shareText(name, mimeType, content));
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openExternalUrl(url));
        }
    }

    /** Vero se la pagina principale della WebView è servita dagli asset dell'APK. */
    private boolean isBundledTopPage(String action) {
        if (webView == null) return false;
        String top = webView.getUrl();
        if (top != null && top.startsWith(ASSET_BASE)) return true;
        Log.w(TAG, action + " ignorato: chiamato dalla pagina " + top);
        return false;
    }

    // ---------------------------------------------------------------------------------
    // Utilità sugli indirizzi
    // ---------------------------------------------------------------------------------

    private static WebResourceResponse withMimeType(String path, WebResourceResponse response) {
        if (response == null) return null;
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime = MIME_TYPES.get(ext);
        if (mime != null) {
            response.setMimeType(mime);
            if (mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                    || mime.endsWith("+xml")) {
                response.setEncoding("utf-8");
            }
        }
        return response;
    }

    /** Indirizzo http(s) ripulito (spazi e "/" finali), oppure null se non valido. */
    static String normalizeServerUrl(String raw) {
        if (raw == null) return null;
        String url = raw.trim();
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (url.isEmpty()) return null;
        Uri uri = Uri.parse(url);
        String scheme = lower(uri.getScheme());
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        return url;
    }

    private static boolean sameHost(Uri a, Uri b) {
        return a != null && b != null && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost());
    }

    private static boolean sameOrigin(Uri a, Uri b) {
        if (!sameHost(a, b)) return false;
        String schemeA = lower(a.getScheme());
        String schemeB = lower(b.getScheme());
        return schemeA.equals(schemeB) && effectivePort(a) == effectivePort(b);
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        if (port != -1) return port;
        String scheme = lower(uri.getScheme());
        if (scheme.equals("https")) return 443;
        if (scheme.equals("http")) return 80;
        return -1;
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }
}
