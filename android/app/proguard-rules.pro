# Le build di prova non sono minimizzate. Se in futuro si attiva minifyEnabled,
# il ponte JavaScript deve restare intatto:
-keepclassmembers class it.cabinefibra.mappa.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
