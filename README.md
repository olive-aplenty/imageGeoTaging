# Picture GeoTagger Web

Statische Browser-Version des Picture GeoTaggers. Der erste Prototyp richtet sich auf JPG/JPEG und speichert Bilddaten im Browser.

## Aktueller Ablauf

1. Über den einzigen Button **Bilder hochladen** öffnet sich je nach Browser die Ordnerauswahl oder die Dateiauswahl. In Safari wählst du JPG-Dateien aus; in Browsern mit Ordnerzugriff kannst du stattdessen einen Bildordner freigeben.
2. Die App zeigt höchstens zehn Bilder pro Gruppe und liest OCR nur für das gerade angezeigte Bild. Wenn zwei OCR-Worker verfügbar sind, laufen zwei gezielte Durchgänge parallel; bei knappem Speicher werden sie nacheinander ausgeführt: (a) Die Einblendung (Datum, Koordinaten, Adresse) wird als Ausschnitt oben oder unten rechts gelesen, zuerst nur die weiße Schrift, danach als Graustufen-Fallback. Eine Position, an der Koordinaten erkannt wurden, wird beim nächsten Bild zuerst versucht. (b) Das verkleinerte Gesamtbild wird für die Papierzettel (Adresse) gelesen. Koordinaten werden mit Himmelsrichtung vor oder nach den Zahlen erkannt (`N 46° 33' 55", E 14° 17' 16"` und `46°33'53,892"N 14°17'19,704"E`). Die Adressvorschläge kommen zuerst aus der Einblendung, danach von den Zetteln.
3. Die Adresssuche startet ausschließlich nach einem Klick auf **Adresse suchen**. Gefundene Ergebnisse werden lokal im Browser zwischengespeichert; nicht zwischengespeicherte Anfragen werden mit mindestens 1,1 Sekunden Abstand gesendet. Die Suche übermittelt die eingegebene Adresse zusammen mit dem eingestellten Ort an Nominatim.
4. Bildkoordinaten, Adresskoordinaten oder manuell eingegebene Koordinaten auswählen.
5. Beim Speichern schreibt die App GPS-EXIF-Daten in eine neue JPEG-Datei. Bei Ordnerzugriff wird die Datei in `Erledigt` geschrieben; erst nach erfolgreichem Schreiben wird das Original aus dem Quellordner entfernt. Bei einzeln ausgewählten Dateien wird stattdessen ein Download gestartet; der Speicherort kann vom Browser abhängen und das Original wird nicht verändert.
6. **Nächstes Bild** markiert ein nicht bearbeitetes Bild als offen und wechselt weiter. Es wird nicht automatisch erneut angezeigt; das Original bleibt unverändert und kann nach erneuter Auswahl des Ordners bzw. der Datei wieder geprüft werden. Beim Weitergehen durch mehrere Gruppen bleiben offene Bilder ebenfalls unverändert.

## GitHub Pages kostenlos veröffentlichen

GitHub Pages ist bei GitHub Free für öffentliche Repositories verfügbar. Dabei ist der Quellcode des Projekts öffentlich. Die ausgewählten Bilder werden von dieser statischen App nicht auf GitHub hochgeladen.

1. Ein neues öffentliches GitHub-Repository erstellen, zum Beispiel `picture-geotagger-web`.
2. `index.html`, `styles.css`, `app.js` und `README.md` in das Repository hochladen.
3. Im Repository **Settings → Pages** öffnen.
4. Unter **Build and deployment** die Quelle **Deploy from a branch** wählen, Branch `main` und Ordner `/ (root)` auswählen, dann speichern.
5. Die von GitHub angezeigte HTTPS-Adresse öffnen. Ordnerzugriff funktioniert nur in unterstützten Browsern und sicherem Kontext; am besten Chrome oder Edge verwenden.

## Grenzen des ersten Prototyps

- Nur JPG/JPEG; HEIC und TIFF sind noch nicht unterstützt.
- OCR, Kartenkacheln und Adresssuche benötigen eine Internetverbindung. OCR-Bilder werden im Browser verarbeitet. Bei der ausdrücklich gestarteten Suche wird die eingegebene Adresse an OpenStreetMap Nominatim übermittelt.
- Der öffentliche Nominatim-Dienst ist kein uneingeschränkt verfügbarer Massen-Geocoder. Die Suche ist einzeln, nutzerinitiiert und gedrosselt; für langfristige oder intensive Nutzung muss ein anderer Dienst geprüft werden.
- Direktes Schreiben in `Erledigt` und Entfernen des Originals benötigt Ordnerzugriff per File System Access API, eine sichere Verbindung (HTTPS oder localhost) und die vom Benutzer erteilte Ordnerberechtigung. Wenn Ordnerauswahl nicht unterstützt wird, können JPG-Dateien einzeln ausgewählt und die Ergebnisse heruntergeladen werden; bei verweigerter oder fehlgeschlagener Ordnerberechtigung bricht das Speichern mit einer Meldung ab und das Original bleibt erhalten.
- Tesseract.js kann OCR-Ergebnisse anders erkennen als Apple Vision. Die vorhandenen Testbilder müssen vor einem größeren Einsatz geprüft werden.

## Drittanbieter

- **jsDelivr** liefert die JavaScript-Bibliotheken aus, die die Seite verwendet.
- **Tesseract.js** übernimmt die Texterkennung (OCR), um Koordinaten und Adressen aus den ausgewählten Bildern auszulesen. Die Bilder werden dafür im Browser verarbeitet und nicht an Tesseract oder jsDelivr hochgeladen.
- **Piexif.js** liest und schreibt EXIF-Metadaten. Beim Speichern trägt die App damit die ausgewählten GPS-Koordinaten in die neue JPEG-Datei ein.
- **Leaflet** zeigt die Karte an und stellt die Bild-, Adress- und ausgewählten Koordinaten als Marker dar.
- **OpenStreetMap** liefert die Kartenkacheln als Kartenhintergrund.
- **Nominatim** sucht nach Koordinaten für eine Adresse. Eine Anfrage wird erst nach Klick auf **Adresse suchen** gesendet; sie enthält die eingegebene Adresse und den eingestellten Ort.

Für OCR, Kartenanzeige und Adresssuche ist eine Internetverbindung erforderlich. Beim Laden der Karte werden Kartenkacheln von OpenStreetMap abgerufen; die Bilddateien selbst bleiben auf dem Gerät.