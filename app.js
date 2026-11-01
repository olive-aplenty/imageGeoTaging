(() => {
  "use strict";

  const BATCH_SIZE = 10;
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const HISTORY_KEY = "picture-geotagger-web-processed-v1";
  const state = {
    items: [], batchStart: 0, currentIndex: 0, sourceDirectory: null,
    outputDirectory: null, worker: null, map: null, markers: [],
    imageObjectURL: null, lastGeocodeAt: 0, current: null, ocrBusy: false, activeOCRItem: null
  };
  const $ = (id) => document.getElementById(id);

  const ui = {
    chooseImages: $("choose-images"), fileInput: $("file-input"),
    folderLabel: $("folder-label"), locality: $("locality"), status: $("status"), progress: $("progress-bar"),
    empty: $("empty-state"), review: $("review"), previous: $("previous"), next: $("next"),
    counter: $("counter"), save: $("save"), reprocess: $("reprocess"), fileName: $("file-name"), imageStatus: $("image-status"),
    photo: $("photo"), imageButton: $("image-button"), openOriginal: $("open-original"),
    rawCoordinate: $("raw-coordinate"), imageCoordinate: $("image-coordinate"),
    candidates: $("address-candidates"), addressInput: $("address-input"), searchAddress: $("search-address"),
    addressCoordinate: $("address-coordinate"), difference: $("difference"), ocrText: $("ocr-text"),
    chosenCoordinate: $("chosen-coordinate"), chosenSource: $("chosen-source"), useImage: $("use-image"),
    useAddress: $("use-address"), manualCoordinate: $("manual-coordinate"),
    applyCoordinate: $("apply-coordinate"), batchInfo: $("batch-info"), nextBatch: $("next-batch")
  };

  function setStatus(message, progress = null) {
    ui.status.textContent = message;
    if (progress !== null) ui.progress.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }

  function visibleReview(visible) {
    ui.review.classList.toggle("hidden", !visible);
    ui.empty.classList.toggle("hidden", visible);
  }

  function currentItem() { return state.items[state.currentIndex] ?? null; }
  function batchEnd() { return Math.min(state.batchStart + BATCH_SIZE, state.items.length); }
  function isResolved(item) { return ["saved", "downloaded", "processed-file"].includes(item?.status); }

  function processedHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}"); }
    catch { return {}; }
  }

  function fileFingerprint(file) {
    return file instanceof File ? `${file.name}|${file.size}|${file.lastModified}` : null;
  }

  function markBrowserDownload(item) {
    const fingerprint = fileFingerprint(item.file);
    if (!fingerprint) return;
    const history = processedHistory();
    history[fingerprint] = { processedAt: Date.now() };
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    item.historyFingerprint = fingerprint;
  }

  function updateNavigation() {
    const item = currentItem();
    const end = batchEnd();
    const batchNumber = Math.floor(state.batchStart / BATCH_SIZE) + 1;
    const localNumber = state.currentIndex - state.batchStart + 1;
    ui.counter.textContent = `Bild ${localNumber} von ${end - state.batchStart} · Gruppe ${batchNumber}`;
    ui.previous.disabled = state.currentIndex <= state.batchStart;
    ui.next.disabled = !item || state.currentIndex + 1 >= end;
    ui.save.disabled = !item || isResolved(item) || !item.coordinate || !item.approved || item.busy;
    ui.reprocess.classList.toggle("hidden", item?.status !== "downloaded");
    ui.useImage.disabled = !item?.imageCoordinate || item.busy;
    ui.useAddress.disabled = !item?.addressCoordinate || item.busy;
    ui.searchAddress.disabled = !item || item.busy || !ui.addressInput.value.trim();
    ui.nextBatch.classList.toggle("hidden", end >= state.items.length || state.currentIndex < end - 1);
    const completed = state.items.filter(isResolved).length;
    const deferred = state.items.filter((entry) => entry.status === "deferred").length;
    ui.batchInfo.textContent = `${completed} erledigt · ${deferred} offen für nächsten Durchgang · ${state.items.length} insgesamt`;
  }

  function setSelectedCoordinate(item, source, coordinate) {
    if (!coordinate) return;
    item.coordinate = { lat: coordinate.lat, lon: coordinate.lon };
    item.source = source;
    item.approved = true;
    item.status = source === "manual" ? "Manuell angepasst" : `${source === "image" ? "Bild" : "Adresse"} gewählt`;
    ui.chosenSource.textContent = sourceLabel(source);
    ui.chosenCoordinate.textContent = `Wird gespeichert: ${formatCoordinate(item.coordinate)} · ${toDMS(item.coordinate.lat, true)} ${toDMS(item.coordinate.lon, false)}`;
    ui.imageStatus.textContent = item.status;
    ui.imageStatus.className = `status-chip ${item.approved ? "good" : ""}`;
    refreshMap(item);
    updateNavigation();
  }

  function sourceLabel(source) {
    return ({ image: "Bildkoordinaten", address: "Adresskoordinaten", manual: "Manuell angepasst" })[source] ?? "Noch nicht gewählt";
  }

  function formatCoordinate(coordinate) {
    return `${coordinate.lat.toFixed(8)}, ${coordinate.lon.toFixed(8)}`;
  }

  function toDMS(value, latitude) {
    const absolute = Math.abs(value);
    const deg = Math.floor(absolute);
    const minutesValue = (absolute - deg) * 60;
    const min = Math.floor(minutesValue);
    const sec = ((minutesValue - min) * 60).toFixed(3);
    const direction = latitude ? (value < 0 ? "S" : "N") : (value < 0 ? "W" : "E");
    return `${deg}° ${String(min).padStart(2, "0")}′ ${sec}″ ${direction}`;
  }

  function parseCoordinate(text) {
    const dmsPair = findDMSPair(text);
    if (dmsPair) return { lat: dmsPair.lat.value, lon: dmsPair.lon.value };
    const labeled = text.match(/(?:lat|latitude)\s*[:=]?\s*(-?\d{1,2}[.,]\d+)\s*°?[^\n]{0,25}(?:lon|long|longitude)\s*[:=]?\s*(-?\d{1,3}[.,]\d+)/i);
    if (labeled) return validCoordinate(Number(labeled[1].replace(",", ".")), Number(labeled[2].replace(",", ".")));
    const decimal = text.match(/(-?\d{1,2}[.,]\d{4,})\s*([NS])[^\n\d]{0,24}(-?\d{1,3}[.,]\d{4,})\s*([EW])/i);
    if (decimal) {
      const lat = Number(decimal[1].replace(",", ".")) * (decimal[2].toUpperCase() === "S" ? -1 : 1);
      const lon = Number(decimal[3].replace(",", ".")) * (decimal[4].toUpperCase() === "W" ? -1 : 1);
      return validCoordinate(lat, lon);
    }
    return null;
  }

  function dmsToDecimal(degreesText, minutesText, secondsText, hemisphere) {
    const degrees = Number(degreesText);
    const minutes = Number(minutesText);
    const seconds = Number(secondsText.replace(",", "."));
    if (minutes >= 60 || seconds >= 60) return NaN;
    return (degrees + minutes / 60 + seconds / 3600) * (/[SW]/i.test(hemisphere) ? -1 : 1);
  }

  function findDMSPair(text) {
    // OCR may drop or alter ° and minute marks, or split the pair across lines.
    // Require all three numeric parts and a hemisphere for each token so an
    // incomplete fragment such as `7°04\"E` can never become a coordinate.
    const tokenPattern = /(?<![\d.,])(\d{1,3})\s*[°º˚]?\s*(\d{1,2})\s*['′´’:`]?\s*(\d{1,2}(?:[.,]\d+)?)\s*["″”]?\s*([NSEW])(?![A-Z])/gi;
    const latitudes = [], longitudes = [];
    for (const match of text.matchAll(tokenPattern)) {
      const hemisphere = match[4].toUpperCase();
      const value = dmsToDecimal(match[1], match[2], match[3], hemisphere);
      if (!Number.isFinite(value)) continue;
      const token = { value, raw: match[0].trim(), start: match.index, end: match.index + match[0].length };
      if ((hemisphere === "N" || hemisphere === "S") && Math.abs(value) <= 90) latitudes.push(token);
      if ((hemisphere === "E" || hemisphere === "W") && Math.abs(value) <= 180) longitudes.push(token);
    }
    let best = null;
    for (const lat of latitudes) for (const lon of longitudes) {
      const gap = lon.start >= lat.end ? lon.start - lat.end : lat.start >= lon.end ? lat.start - lon.end : 0;
      if (gap > 80) continue;
      if (!best || gap < best.gap) best = { lat, lon, gap };
    }
    return best;
  }

  function hasCoordinateOCRHints(text) {
    const dmsFragments = text.match(/\d{1,2}\s*[°º˚]\s*\d{1,2}\s*['′´’]/g) ?? [];
    return dmsFragments.length >= 2 || (dmsFragments.length >= 1 && /[NS]/i.test(text) && /[EW]/i.test(text));
  }

  function validCoordinate(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  function extractRawCoordinate(text) {
    const decimal = text.match(/-?\d{1,2}[.,]\d{4,}\s*[NS][^\n\d]{0,24}-?\d{1,3}[.,]\d{4,}\s*[EW]/i);
    if (decimal) return decimal[0].replace(/\s+/g, " ").trim();
    const pair = findDMSPair(text);
    if (pair) return `${pair.lat.raw} ${pair.lon.raw}`;
    return "Koordinaten erkannt; OCR-Schreibweise nicht sicher lesbar";
  }

  function extractAddresses(text) {
    const seen = new Set();
    const candidates = [];
    const road = "(?:straße|strasse|str\\.?|gasse|weg|platz|allee|ring|gürtel|street|road|avenue)";
    const roadThenNumber = new RegExp(`([\\p{L}][\\p{L}'’.-]*${road})\\s*(\\d{1,4}[a-z]?)\\b`, "giu");
    const numberThenRoad = new RegExp(`\\b(\\d{1,4}[a-z]?)\\s+([\\p{L}][\\p{L}'’.-]*${road})`, "giu");
    for (const line of text.split(/\r?\n/).map((entry) => entry.trim())) {
      const normalized = line
        .replace(/\bglsterweg\b/gi, "Elsterweg")
        .replace(/strare\b/gi, "straße")
        .replace(/strasse\b/gi, "straße");
      for (const match of normalized.matchAll(roadThenNumber)) candidates.push(`${match[1]} ${match[2]}`);
      for (const match of normalized.matchAll(numberThenRoad)) candidates.push(`${match[2]} ${match[1]}`);

      const postal = line.match(/\b([1-9]\d{3})\s+([^,\n]{2,})/);
      if (!postal) continue;
      const beforePostal = line.slice(0, postal.index).replace(/[,:;]+\s*$/, "").trim();
      const house = beforePostal.match(/([^\s,]+)\s+(\d{1,4}[a-z]?)\s*$/i);
      const locality = postal[2].replace(/\s+(?:Австрия|Austria|Österreich).*$/i, "").trim();
      if (!house || !locality) continue;
      const name = house[1].replace(/^[^\p{L}]*/u, "").replace(/[^\p{L}'’.-]/gu, "");
      const hasLeadingOCRJunk = /^[^\p{L}]+/u.test(house[1]);
      candidates.push(`${!hasLeadingOCRJunk && name.length >= 4 ? name : locality} ${house[2]}, ${postal[1]} ${locality}`);
    }
    return candidates.filter((line) => line && !seen.has(line.toLowerCase()) && seen.add(line.toLowerCase()));
  }

  function cleanDisplayedOCR(text) {
    return text.split(/\r?\n/).map((line) => {
      const pair = line.match(/\d{1,2}[.,]\d{4,}\s*[NS]\s*\d{1,3}[.,]\d{4,}\s*[EW]/i);
      return pair ? pair[0] : line;
    }).join("\n");
  }

  function haversine(a, b) {
    const rad = (value) => value * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function ensureMap() {
    if (state.map || !window.L) return;
    state.map = L.map("map", { scrollWheelZoom: true }).setView([46.565, 14.29], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);
  }

  function mapIcon(color, label) {
    return L.divIcon({ className: "custom-pin", html: `<span class="pin-label">${escapeHTML(label)}</span><span class="pin ${color}"></span>`, iconSize: [160, 45], iconAnchor: [80, 43] });
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function refreshMap(item) {
    ensureMap();
    if (!state.map) return;
    for (const marker of state.markers) state.map.removeLayer(marker);
    state.markers = [];
    const points = [];
    if (item?.imageCoordinate) {
      const marker = L.marker([item.imageCoordinate.lat, item.imageCoordinate.lon], { icon: mapIcon("red", "Bildkoordinaten") }).addTo(state.map);
      state.markers.push(marker); points.push([item.imageCoordinate.lat, item.imageCoordinate.lon]);
    }
    if (item?.addressCoordinate) {
      const marker = L.marker([item.addressCoordinate.lat, item.addressCoordinate.lon], { icon: mapIcon("blue", "Adresskoordinaten") }).addTo(state.map);
      state.markers.push(marker); points.push([item.addressCoordinate.lat, item.addressCoordinate.lon]);
    }
    if (item?.coordinate && ![item.imageCoordinate, item.addressCoordinate].filter(Boolean).some((coord) => Math.abs(coord.lat - item.coordinate.lat) < 1e-8 && Math.abs(coord.lon - item.coordinate.lon) < 1e-8)) {
      const marker = L.marker([item.coordinate.lat, item.coordinate.lon], { icon: mapIcon("purple", "Ausgewählt") }).addTo(state.map);
      state.markers.push(marker); points.push([item.coordinate.lat, item.coordinate.lon]);
    }
    if (points.length === 1) state.map.setView(points[0], 17);
    else if (points.length > 1) state.map.fitBounds(points, { padding: [70, 70], maxZoom: 17 });
    setTimeout(() => state.map.invalidateSize(), 50);
  }

  function makeItem(file, handle = null) {
    const item = { name: file.name, file, handle, status: "pending", busy: false, ocr: "", imageCoordinate: null, addressCoordinate: null, coordinate: null, source: null, approved: false, address: "", postalCode: "" };
    const fingerprint = fileFingerprint(file);
    if (/_GPS(?:_\d+)?\.jpe?g$/i.test(file.name)) {
      item.status = "processed-file";
      item.statusLabel = "Sieht bereits wie eine GPS-Ausgabedatei aus";
    } else if (fingerprint && processedHistory()[fingerprint]) {
      item.status = "downloaded";
      item.statusLabel = "Für dieses Original wurde in diesem Browser bereits ein Download gestartet";
      item.historyFingerprint = fingerprint;
    }
    return item;
  }

  function setBatch(items, label, sourceDirectory = null) {
    state.items = items;
    state.batchStart = 0;
    state.currentIndex = 0;
    state.sourceDirectory = sourceDirectory;
    state.outputDirectory = null;
    ui.folderLabel.textContent = label;
    visibleReview(items.length > 0);
    if (!items.length) { setStatus("Im ausgewählten Ordner wurden keine JPG-Bilder gefunden.", 0); return; }
    setStatus(`${items.length} JPG-Bilder gefunden. Es werden immer nur bis zu ${BATCH_SIZE} in einer Gruppe bearbeitet.`, 0);
    updateNavigation();
    void showCurrent();
  }

  async function chooseImages() {
    if (!window.showDirectoryPicker) {
      ui.fileInput.click();
      setStatus("Dieser Browser erlaubt keine Ordnerauswahl. Wähle stattdessen JPG-Bilder aus.");
      return;
    }
    try {
      const directory = await window.showDirectoryPicker({ mode: "readwrite" });
      const entries = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file" && /\.jpe?g$/i.test(name)) entries.push({ name, handle });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true, sensitivity: "base" }));
      const items = entries.map(({ name, handle }) => makeItem({ name }, handle));
      setBatch(items, directory.name, directory);
    } catch (error) {
      if (error.name !== "AbortError") setStatus(`Ordner konnte nicht geöffnet werden: ${error.message}`);
    }
  }

  function chooseFiles(event) {
    const files = [...event.target.files].filter((file) => /\.jpe?g$/i.test(file.name));
    if (!files.length) { setStatus("Bitte JPG- oder JPEG-Dateien auswählen."); return; }
    setBatch(files.map((file) => makeItem(file)), `${files.length} ausgewählte Dateien`);
    event.target.value = "";
  }

  async function getFile(item) {
    if (item.file instanceof File) return item.file;
    if (item.handle) {
      item.file = await item.handle.getFile();
      return item.file;
    }
    throw new Error("Die Bilddatei ist nicht mehr verfügbar.");
  }

  async function getWorker() {
    if (state.worker) return state.worker;
    if (!window.Tesseract?.createWorker) throw new Error("OCR-Modul konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu.");
    state.worker = await Tesseract.createWorker("deu+eng+rus", 1, {
      logger: (event) => {
        if (state.activeOCRItem !== currentItem()) return;
        if (event.status === "recognizing text") setStatus("Text wird gelesen …", Math.round((event.progress ?? 0) * 100));
        else if (event.status === "loading language traineddata") setStatus("OCR-Sprachdaten werden einmalig geladen …", Math.round((event.progress ?? 0) * 100));
      }
    });
    return state.worker;
  }

  async function enlargedOCRImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("Bild konnte für den zusätzlichen OCR-Durchgang nicht geöffnet werden."));
      });
      image.src = url;
      await loaded;
      const scale = Math.min(1.3, Math.max(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d");
      context.filter = "grayscale(1) contrast(1.2)";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function showCurrent() {
    const item = currentItem();
    if (!item) return;
    if (state.current !== item) {
      state.current = item;
      if (item.status === "pending") setStatus(state.ocrBusy ? "Wartet auf den laufenden OCR-Durchgang …" : "Bild wird vorbereitet …", 0);
      else setStatus(item.statusLabel ?? "Bild bereit.", 100);
    }
    visibleReview(true);
    updateNavigation();
    ui.fileName.textContent = item.name;
    ui.ocrText.textContent = item.ocr || (item.status === "pending" ? "OCR wird für dieses Bild gestartet …" : "Kein OCR-Text gespeichert.");
    ui.rawCoordinate.textContent = item.rawCoordinate || "Noch nicht erkannt";
    ui.imageCoordinate.textContent = item.imageCoordinate ? `${formatCoordinate(item.imageCoordinate)} · ${toDMS(item.imageCoordinate.lat, true)} ${toDMS(item.imageCoordinate.lon, false)}` : "Keine Koordinaten erkannt";
    ui.addressInput.value = item.address;
    ui.addressCoordinate.textContent = item.addressCoordinate ? `Koordinaten durch Adresse: ${formatCoordinate(item.addressCoordinate)}` : "Koordinaten durch Adresse: —";
    ui.difference.textContent = item.difference ? `Abweichung: ${Math.round(item.difference)} m` : "";
    ui.difference.classList.toggle("alert", (item.difference ?? 0) > 50);
    renderCandidates(item);
    if (state.imageObjectURL) URL.revokeObjectURL(state.imageObjectURL);
    try {
      const file = await getFile(item);
      state.imageObjectURL = URL.createObjectURL(file);
      ui.photo.src = state.imageObjectURL;
      ui.imageButton.onclick = ui.openOriginal.onclick = () => window.open(state.imageObjectURL, "_blank", "noopener");
      ui.imageButton.classList.remove("image-missing");
    } catch (error) {
      ui.photo.removeAttribute("src");
      ui.imageButton.classList.add("image-missing");
      setStatus(error.message);
    }
    setSelectedDisplay(item);
    refreshMap(item);
    if (item.status === "pending" && !item.busy) await recognize(item);
  }

  function setSelectedDisplay(item) {
    ui.manualCoordinate.value = item.manualCoordinateText ?? "";
    ui.chosenSource.textContent = sourceLabel(item.source);
    ui.chosenCoordinate.textContent = item.coordinate ? `Wird gespeichert: ${formatCoordinate(item.coordinate)} · ${toDMS(item.coordinate.lat, true)} ${toDMS(item.coordinate.lon, false)}` : "Wähle Bild- oder Adresskoordinaten oder gib sie manuell ein.";
    ui.imageStatus.textContent = item.status === "saved" ? "Gespeichert · nach Erledigt verschoben" : item.status === "downloaded" ? item.statusLabel : item.status === "processed-file" ? item.statusLabel : item.status === "deferred" ? item.statusLabel : item.statusLabel ?? item.status;
    ui.imageStatus.className = `status-chip ${item.status === "saved" || item.approved ? "good" : "needs-check"}`;
    updateNavigation();
  }

  async function recognize(item) {
    if (item.busy) return;
    if (state.ocrBusy) {
      setStatus("Das vorherige Bild wird noch gelesen. Dieses Bild startet direkt danach …", 0);
      return;
    }
    state.ocrBusy = true;
    state.activeOCRItem = item;
    item.busy = true;
    setStatus(`Lese Bild ${state.currentIndex + 1} von ${batchEnd() - state.batchStart} …`, 0);
    updateNavigation();
    try {
      const file = await getFile(item);
      const worker = await getWorker();
      const result = await worker.recognize(file);
      item.ocr = (result.data.text ?? "").trim();
      item.imageCoordinate = parseCoordinate(item.ocr);
      let coordinateOCR = item.ocr;
      if (!item.imageCoordinate && hasCoordinateOCRHints(item.ocr)) {
        try {
          if (currentItem() === item) setStatus("Koordinatenhinweis gefunden · prüfe das Bild vergrößert …", 55);
          const enlarged = await enlargedOCRImage(file);
          const retry = await worker.recognize(enlarged);
          const retryText = (retry.data.text ?? "").trim();
          const retryCoordinate = parseCoordinate(retryText);
          if (retryCoordinate) {
            item.imageCoordinate = retryCoordinate;
            coordinateOCR = retryText;
          }
        } catch (retryError) {
          console.info("Zusätzlicher Koordinaten-OCR-Durchgang nicht verfügbar:", retryError);
        }
      }
      item.rawCoordinate = item.imageCoordinate ? extractRawCoordinate(coordinateOCR) : "Keine Bildkoordinaten erkannt";
      item.addressCandidates = extractAddresses(item.ocr);
      item.address = item.addressCandidates[0] ?? "";
      if (!item.imageCoordinate && !item.manualCoordinateText) item.manualCoordinateText = "__°__'__,___\"N ___°__'__,___\"E";
      const postal = item.ocr.match(/\b([1-9]\d{3})\b/);
      item.postalCode = postal?.[1] ?? "";
      item.status = "ready";
      item.statusLabel = item.imageCoordinate ? "Bildkoordinaten erkannt" : "Adresse und Koordinaten prüfen";
      item.approved = Boolean(item.imageCoordinate);
      if (item.imageCoordinate) {
        item.coordinate = { ...item.imageCoordinate };
        item.source = "image";
      }
      if (!item.imageCoordinate && !item.address) item.statusLabel = "Keine sichere Adresse oder Koordinaten erkannt";
      if (currentItem() === item) {
        ui.ocrText.textContent = item.ocr ? cleanDisplayedOCR(item.ocr) : "Kein lesbarer Text erkannt.";
        ui.rawCoordinate.textContent = item.rawCoordinate;
        ui.imageCoordinate.textContent = item.imageCoordinate ? `${formatCoordinate(item.imageCoordinate)} · ${toDMS(item.imageCoordinate.lat, true)} ${toDMS(item.imageCoordinate.lon, false)}` : "Keine Koordinaten erkannt";
        ui.addressInput.value = item.address;
        renderCandidates(item);
        setSelectedDisplay(item);
        refreshMap(item);
        setStatus(`Bild ${state.currentIndex + 1} von ${batchEnd() - state.batchStart} prüfen. Die Adresssuche startet erst auf deinen Klick.`, 100);
      }
    } catch (error) {
      item.status = "error";
      item.statusLabel = `OCR-Fehler: ${error.message}`;
      if (currentItem() === item) {
        setStatus(item.statusLabel);
        setSelectedDisplay(item);
      }
    } finally {
      item.busy = false;
      state.ocrBusy = false;
      state.activeOCRItem = null;
      updateNavigation();
      const next = currentItem();
      if (next && next !== item && next.status === "pending" && !next.busy) void recognize(next);
    }
  }

  function renderCandidates(item) {
    ui.candidates.replaceChildren();
    for (const address of item.addressCandidates ?? []) {
      const button = document.createElement("button");
      button.className = "candidate";
      button.textContent = address;
      button.type = "button";
      button.onclick = () => {
        item.address = address;
        ui.addressInput.value = address;
        void searchAddress();
      };
      ui.candidates.append(button);
    }
    if (!(item.addressCandidates ?? []).length) {
      const note = document.createElement("span");
      note.className = "subtle";
      note.textContent = "Keine sichere Straße mit Hausnummer erkannt. Text kann manuell eingegeben werden.";
      ui.candidates.append(note);
    }
  }

  async function searchAddress() {
    const item = currentItem();
    const address = ui.addressInput.value.trim();
    if (!item || !address) return;
    item.address = address;
    item.busy = true;
    ui.searchAddress.disabled = true;
    setStatus("Suche genau diese Adresse …");
    updateNavigation();
    const query = `${address}, ${ui.locality.value.trim()}`.trim().replace(/^,|,$/g, "");
    const cacheKey = `geotagger:${query.toLowerCase()}`;
    try {
      let place = null;
      const cached = localStorage.getItem(cacheKey);
      if (cached) place = JSON.parse(cached);
      else {
        const wait = Math.max(0, 1100 - (Date.now() - state.lastGeocodeAt));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        state.lastGeocodeAt = Date.now();
        const url = new URL(NOMINATIM);
        url.search = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "1" });
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Adressdienst antwortete mit ${response.status}`);
        const data = await response.json();
        place = data[0] ? { lat: Number(data[0].lat), lon: Number(data[0].lon), displayName: data[0].display_name, address: data[0].address } : null;
        if (place) localStorage.setItem(cacheKey, JSON.stringify(place));
      }
      if (!place) throw new Error("Keine passende Adresse gefunden.");
      item.addressCoordinate = validCoordinate(place.lat, place.lon);
      item.postalCode = place.address?.postcode?.replace(/\D/g, "") || item.postalCode;
      item.difference = item.imageCoordinate ? haversine(item.imageCoordinate, item.addressCoordinate) : null;
      if (!item.imageCoordinate) {
        item.coordinate = { ...item.addressCoordinate };
        item.source = "address";
        item.approved = true;
      } else if (item.difference <= 50) {
        item.coordinate = { ...item.imageCoordinate };
        item.source = "image";
        item.approved = true;
      } else {
        item.coordinate = null;
        item.source = null;
        item.approved = false;
      }
      ui.addressCoordinate.textContent = `Koordinaten durch Adresse: ${formatCoordinate(item.addressCoordinate)} · ${place.displayName}`;
      ui.difference.textContent = item.difference === null ? "" : `Abweichung: ${Math.round(item.difference)} m${item.difference > 50 ? " · bitte Bild- oder Adresskoordinaten auswählen" : ""}`;
      ui.difference.classList.toggle("alert", (item.difference ?? 0) > 50);
      setSelectedDisplay(item);
      refreshMap(item);
      setStatus("Adresse gesucht. Prüfe die Koordinaten und wähle, was gespeichert werden soll.");
    } catch (error) {
      setStatus(`Adresssuche: ${error.message}`);
    } finally {
      item.busy = false;
      updateNavigation();
    }

  function reprocessCurrent() {
    const item = currentItem();
    if (!item || item.status !== "downloaded") return;
    const history = processedHistory();
    if (item.historyFingerprint) delete history[item.historyFingerprint];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    item.status = "pending";
    item.statusLabel = "Wird erneut geprüft";
    item.ocr = "";
    item.addressCoordinate = null;
    item.difference = null;
    item.coordinate = null;
    item.source = null;
    item.approved = false;
    void showCurrent();
  }
  }

  function applyManualCoordinate() {
    const item = currentItem();
    const text = ui.manualCoordinate.value.trim();
    const dms = parseCoordinate(text);
    const decimal = text.match(/^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/);
    const coordinate = dms ?? (decimal ? validCoordinate(Number(decimal[1].replace(",", ".")), Number(decimal[2].replace(",", "."))) : null);
    if (!item || !coordinate) { setStatus('Koordinaten bitte vollständig wie auf dem Bild eingeben, z. B. 46°33\'53,892"N 14°17\'19,704"E.'); return; }
    item.manualCoordinateText = text;
    setSelectedCoordinate(item, "manual", coordinate);
    setStatus("Manuell angepasste Koordinaten übernommen.");
  }

  function dataURLToBlob(dataURL) {
    const [header, encoded] = dataURL.split(",");
    const mime = header.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error ?? new Error("Bild konnte nicht gelesen werden."));
      reader.readAsDataURL(blob);
    });
  }

  function rational(value, scale = 1000000) {
    return [Math.round(value * scale), scale];
  }

  function metadataJpeg(dataURL, coordinate) {
    if (!window.piexif) throw new Error("EXIF-Modul konnte nicht geladen werden.");
    let exif = { "0th": {}, Exif: {}, GPS: {} };
    try { exif = piexif.load(dataURL); } catch { /* JPEG ohne vorhandene EXIF-Daten */ }
    exif.GPS = exif.GPS ?? {};
    const gps = piexif.GPSIFD;
    const setDMS = (value, refKey, valueKey, positiveRef, negativeRef) => {
      const abs = Math.abs(value), deg = Math.floor(abs), minValue = (abs - deg) * 60, min = Math.floor(minValue), sec = (minValue - min) * 60;
      exif.GPS[refKey] = value < 0 ? negativeRef : positiveRef;
      exif.GPS[valueKey] = [rational(deg, 1), rational(min, 1), rational(sec)];
    };
    exif.GPS[gps.GPSVersionID] = [2, 3, 0, 0];
    setDMS(coordinate.lat, gps.GPSLatitudeRef, gps.GPSLatitude, "N", "S");
    setDMS(coordinate.lon, gps.GPSLongitudeRef, gps.GPSLongitude, "E", "W");
    return piexif.insert(piexif.dump(exif), dataURL);
  }

  function safeName(item) {
    const address = item.address.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
    const postal = item.postalCode.trim();
    const prefix = [address, postal].filter(Boolean).join(" ");
    const dot = item.name.lastIndexOf(".");
    const base = dot > 0 ? item.name.slice(0, dot) : item.name;
    const ext = dot > 0 ? item.name.slice(dot) : ".jpg";
    return `${prefix ? `${prefix}_` : ""}${base}_GPS${ext}`;
  }

  async function uniqueOutputName(directory, desiredName) {
    const dot = desiredName.lastIndexOf(".");
    const stem = dot > 0 ? desiredName.slice(0, dot) : desiredName;
    const ext = dot > 0 ? desiredName.slice(dot) : ".jpg";
    let number = 1;
    while (true) {
      const candidate = number === 1 ? desiredName : `${stem}_${number}${ext}`;
      try {
        await directory.getFileHandle(candidate);
        number += 1;
      } catch (error) {
        if (error.name === "NotFoundError") return candidate;
        throw error;
      }
    }
  }

  async function saveCurrent() {
    const item = currentItem();
    if (!item?.coordinate || !item.approved || isResolved(item)) return;
    item.busy = true;
    setStatus("GPS wird geschrieben. Das Original wird erst danach verschoben.", 5);
    updateNavigation();
    try {
      const file = await getFile(item);
      if (!/\.jpe?g$/i.test(file.name)) throw new Error("Der erste Web-Versuch unterstützt nur JPG/JPEG.");
      const resultDataURL = metadataJpeg(await blobToDataURL(file), item.coordinate);
      const blob = dataURLToBlob(resultDataURL);
      const outputName = safeName(item);
      if (state.sourceDirectory && item.handle) {
        if (!state.outputDirectory) state.outputDirectory = await state.sourceDirectory.getDirectoryHandle("Erledigt", { create: true });
        const uniqueName = await uniqueOutputName(state.outputDirectory, outputName);
        const output = await state.outputDirectory.getFileHandle(uniqueName, { create: true });
        const writable = await output.createWritable();
        await writable.write(blob);
        await writable.close();
        await state.sourceDirectory.removeEntry(item.name);
        item.statusLabel = `Gespeichert: ${uniqueName}`;
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = outputName; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        markBrowserDownload(item);
        item.status = "downloaded";
        item.statusLabel = "Download gestartet. Safari kann den Speicherort nicht bestätigen.";
      }
      if (state.sourceDirectory) {
        item.status = "saved";
        item.statusLabel = item.statusLabel || `Gespeichert: ${outputName}`;
      }
      setStatus(state.sourceDirectory ? `Gespeichert und nach Erledigt verschoben: ${item.statusLabel.replace("Gespeichert: ", "")}` : `Download gestartet: ${outputName}. Das Original bleibt im Quellordner.`);
      setSelectedDisplay(item);
      if (state.currentIndex + 1 < batchEnd()) {
        state.currentIndex += 1;
        await showCurrent();
      } else {
        updateNavigation();
      }
    } catch (error) {
      item.status = "ready";
      item.statusLabel = `Fehler: ${error.message} · Original blieb liegen`;
      item.approved = Boolean(item.coordinate);
      setStatus(`Speichern fehlgeschlagen. Das Original bleibt liegen. ${error.message}`);
      setSelectedDisplay(item);
    } finally {
      item.busy = false;
      updateNavigation();
    }
  }

  function goNext() {
    const item = currentItem();
    if (!item) return;
    if (!isResolved(item)) {
      item.status = "deferred";
      item.statusLabel = "Offen · beim nächsten Durchgang erneut prüfen";
    }
    if (state.currentIndex + 1 < batchEnd()) {
      state.currentIndex += 1;
      void showCurrent();
    } else updateNavigation();
  }

  function nextBatch() {
    const end = batchEnd();
    if (end >= state.items.length || state.currentIndex < end - 1) return;
    for (const item of state.items.slice(state.batchStart, end)) {
      if (!isResolved(item)) {
        item.status = "deferred";
        item.statusLabel = "Offen · beim nächsten Durchgang erneut prüfen";
      }
    }
    state.batchStart = end;
    state.currentIndex = end;
    setStatus(`Gruppe ${Math.floor(end / BATCH_SIZE) + 1} von ${Math.ceil(state.items.length / BATCH_SIZE)} gestartet.`, 0);
    void showCurrent();
  }

  ui.chooseImages.addEventListener("click", chooseImages);
  ui.fileInput.addEventListener("change", chooseFiles);
  ui.previous.addEventListener("click", () => { state.currentIndex -= 1; void showCurrent(); });
  ui.next.addEventListener("click", goNext);
  ui.nextBatch.addEventListener("click", nextBatch);
  ui.save.addEventListener("click", saveCurrent);
  ui.reprocess.addEventListener("click", reprocessCurrent);
  ui.searchAddress.addEventListener("click", searchAddress);
  ui.addressInput.addEventListener("input", () => {
    const item = currentItem();
    if (item) {
      item.address = ui.addressInput.value;
      item.addressCoordinate = null;
      item.difference = null;
      if (item.source === "address") { item.coordinate = null; item.source = null; item.approved = false; }
      ui.addressCoordinate.textContent = item.address ? "Koordinaten durch Adresse: noch nicht gesucht" : "Koordinaten durch Adresse: —";
      ui.difference.textContent = "";
      refreshMap(item);
    }
    updateNavigation();
  });
  ui.addressInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void searchAddress(); });
  ui.useImage.addEventListener("click", () => setSelectedCoordinate(currentItem(), "image", currentItem()?.imageCoordinate));
  ui.useAddress.addEventListener("click", () => setSelectedCoordinate(currentItem(), "address", currentItem()?.addressCoordinate));
  ui.applyCoordinate.addEventListener("click", applyManualCoordinate);
  ui.manualCoordinate.addEventListener("keydown", (event) => { if (event.key === "Enter") applyManualCoordinate(); });
  ui.manualCoordinate.addEventListener("input", () => {
    const item = currentItem();
    if (item) item.manualCoordinateText = ui.manualCoordinate.value;
  });

  window.addEventListener("beforeunload", () => {
    if (state.imageObjectURL) URL.revokeObjectURL(state.imageObjectURL);
    if (state.worker) void state.worker.terminate();
  });
})();
