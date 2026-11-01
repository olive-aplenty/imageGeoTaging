# Picture GeoTagger Web

Statische Browser-Version des Picture GeoTaggers. Der erste Prototyp richtet sich auf JPG/JPEG und speichert Bilddaten im Browser.

## Aktueller Ablauf

1. Über **Bilder hochladen** einen Ordner freigeben (falls unterstützt) oder in Safari JPG-Dateien auswählen.
2. Die App zeigt höchstens zehn Bilder pro Gruppe und liest OCR nur für das gerade angezeigte Bild.
3. Die Adresssuche startet ausschließlich nach einem Klick auf **Adresse suchen**. Ergebnisse werden lokal im Browser zwischengespeichert und Adressanfragen mindestens eine Sekunde auseinandergehalten.
4. Bildkoordinaten, Adresskoordinaten oder manuell eingegebene Koordinaten auswählen.
5. Beim Speichern schreibt die App GPS-EXIF-Daten in eine neue JPEG-Datei. Bei Ordnerzugriff wird die Datei in `Erledigt` geschrieben; erst danach entfernt der Browser das Original aus dem Quellordner.
6. **Nächstes Bild** stellt ein nicht bearbeitetes Bild für einen späteren Durchgang zurück. Es bleibt unverändert im Quellordner und kann nach erneuter Auswahl wieder geprüft werden. Beim Weitergehen durch mehrere Gruppen bleiben offene Bilder ebenfalls im Quellordner.

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
- Direktes Schreiben in `Erledigt` und Entfernen des Originals benötigt Browser-Unterstützung und eine vom Benutzer gewählte Ordnerberechtigung. Ohne diese Unterstützung lädt die App die bearbeitete Datei herunter; das Original bleibt liegen.
- Tesseract.js kann OCR-Ergebnisse anders erkennen als Apple Vision. Die vorhandenen Testbilder müssen vor einem größeren Einsatz geprüft werden.

## Drittanbieter

Die Seite lädt Tesseract.js und Piexif.js von jsDelivr sowie Leaflet und Kartenkacheln von OpenStreetMap. Ohne Internet stehen OCR, Karte und Adresssuche nicht zur Verfügung.
