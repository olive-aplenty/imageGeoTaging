(() => {
  "use strict";

  const BATCH_SIZE = 10;
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const HISTORY_KEY = "picture-geotagger-web-processed-v1";
  const state = {
    items: [], batchStart: 0, currentIndex: 0, sourceDirectory: null,
    outputDirectory: null, workersPromise: null, overlayHint: null, ocrProgress: { overlay: 0, paper: 0 }, map: null, markers: [],
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
    if (source !== "manual") item.manualCoordinateText = formatDMSInput(item.coordinate);
    ui.manualCoordinate.value = item.manualCoordinateText ?? "";
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

  function formatDMSInput(coordinate) {
    const formatPart = (value, latitude) => {
      const absolute = Math.abs(value);
      const degrees = Math.floor(absolute);
      const minuteValue = (absolute - degrees) * 60;
      const minutes = Math.floor(minuteValue);
      const seconds = ((minuteValue - minutes) * 60).toFixed(5).replace(".", ",");
      const direction = latitude ? (value < 0 ? "S" : "N") : (value < 0 ? "W" : "E");
      return `${degrees}°${String(minutes).padStart(2, "0")}'${seconds}\"${direction}`;
    };
    return `${formatPart(coordinate.lat, true)} ${formatPart(coordinate.lon, false)}`;
  }

  // OCR often garbles the tiny symbols (° ' ") and sometimes digits.
  // Normalise the most common confusions before parsing coordinates.
  function normalizeForCoordinates(text) {
    return String(text ?? "")
      .replace(/[′´’‘`]/g, "'")
      .replace(/[″”“]/g, '"')
      .replace(/[º˚]/g, "°")
      .replace(/(?<=\d)[Oo](?=[\d°'",.\s])|(?<=[°'",.\s])[Oo](?=\d)/g, "0")
      .replace(/(?<=\d)[Il|](?=\d)/g, "1");
  }

  function parseCoordinate(text) {
    const dmsPair = findDMSPair(text);
    if (dmsPair) return { lat: dmsPair.lat.value, lon: dmsPair.lon.value };
    text = normalizeForCoordinates(text);
    const labeled = text.match(/(?:lat|latitude)\s*[:=]?\s*(-?\d{1,2}[.,]\d+)\s*°?[^\n]{0,25}(?:lon|long|longitude)\s*[:=]?\s*(-?\d{1,3}[.,]\d+)/i);
    if (labeled) return validCoordinate(Number(labeled[1].replace(",", ".")), Number(labeled[2].replace(",", ".")));
    const decimal = text.match(/(-?\d{1,2}[.,]\d{4,})\s*([NS])[^\n\d]{0,24}(-?\d{1,3}[.,]\d{4,})\s*([EW])/i);
    if (decimal) {
      const lat = Number(decimal[1].replace(",", ".")) * (decimal[2].toUpperCase() === "S" ? -1 : 1);
      const lon = Number(decimal[3].replace(",", ".")) * (decimal[4].toUpperCase() === "W" ? -1 : 1);
      return validCoordinate(lat, lon);
    }
    const prefixed = text.match(/(?<![A-Za-z])([NS])\s*(\d{1,2}[.,]\d{4,})[^\n\dNSEW]{0,24}([EW])\s*(\d{1,3}[.,]\d{4,})/i);
    if (prefixed) {
      const lat = Number(prefixed[2].replace(",", ".")) * (prefixed[1].toUpperCase() === "S" ? -1 : 1);
      const lon = Number(prefixed[4].replace(",", ".")) * (prefixed[3].toUpperCase() === "W" ? -1 : 1);
      return validCoordinate(lat, lon);
    }
    const plain = text.match(/(?<![\d.,])(-?\d{1,2}\.\d{4,})\s*[,;]\s*(-?\d{1,3}\.\d{4,})(?!\d)/);
    if (plain) return validCoordinate(Number(plain[1]), Number(plain[2]));
    return null;
  }

  function dmsToDecimal(degreesText, minutesText, secondsText, hemisphere) {
    const degrees = Number(degreesText);
    const minutes = Number(minutesText);
    const seconds = Number(secondsText.replace(",", ".").replace(/[ \t]+/g, "."));
    if (minutes >= 60 || seconds >= 60) return NaN;
    return (degrees + minutes / 60 + seconds / 3600) * (/[SW]/i.test(hemisphere) ? -1 : 1);
  }

  function findDMSPair(rawText) {
    // Two layouts occur on the photos:
    //   suffix: 46°33'53,892"N 14°17'19,704"E      (hemisphere after the numbers)
    //   prefix: N 46° 33' 55", E 14° 17' 16"       (hemisphere before the numbers)
    // OCR may drop or alter the °, ' and " marks, so any 1-3 junk characters (or
    // plain spaces) are accepted between the number parts. All three numeric parts
    // and a hemisphere are required, so a fragment like `7°04"E` never becomes a coordinate.
    const text = normalizeForCoordinates(rawText);
    const sep = "(?:[ \\t]*[^\\d\\sNSEW]{1,3}[ \\t]*|[ \\t]+)";
    const numbers = `(\\d{1,3})${sep}(\\d{1,2})${sep}(\\d{1,2}(?:[.,]\\d+|[ \\t]\\d{3,})?)`;
    const suffix = new RegExp(`(?<![\\d.,])${numbers}[ \\t]*["'°*:.]{0,2}[ \\t]*([NSEW])(?![A-Za-z])`, "gi");
    const prefix = new RegExp(`(?<![A-Za-z])([NSEW])[ \\t]*${numbers}(?!\\d)`, "gi");

    const collect = (regex, hemisphereFirst) => {
      const lat = [], lon = [];
      for (const match of text.matchAll(regex)) {
        const [h, d, m, s] = hemisphereFirst ? [match[1], match[2], match[3], match[4]] : [match[4], match[1], match[2], match[3]];
        const hemisphere = h.toUpperCase();
        const value = dmsToDecimal(d, m, s, hemisphere);
        if (!Number.isFinite(value)) continue;
        const token = { value, raw: match[0].trim(), start: match.index, end: match.index + match[0].length };
        if ((hemisphere === "N" || hemisphere === "S") && Math.abs(value) <= 90) lat.push(token);
        else if ((hemisphere === "E" || hemisphere === "W") && Math.abs(value) <= 180) lon.push(token);
      }
      return { lat, lon };
    };
    const closest = ({ lat, lon }) => {
      let best = null;
      for (const a of lat) for (const b of lon) {
        const gap = b.start >= a.end ? b.start - a.end : a.start >= b.end ? a.start - b.end : 0;
        if (gap > 100) continue;
        if (!best || gap < best.gap) best = { lat: a, lon: b, gap };
      }
      return best;
    };
    return closest(collect(suffix, false)) ?? closest(collect(prefix, true));
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

  // Postal code for the file name. Dates and times (31:07:2024, 01.08.2024 14:56)
  // are removed first, otherwise the year 2024 was mistaken for a postal code.
  function findPostalCode(text) {
    const cleaned = String(text ?? "")
      .replace(/\d{1,2}[.:\-/]\d{1,2}[.:\-/]\d{2,4}(?:[ \t]+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)?/g, " ")
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ");
    return cleaned.match(/(?<![\d.,/-])([1-9]\d{3})(?![\d.,/-])/)?.[1] ?? "";
  }

  function mergeAddressCandidates(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) for (const entry of list) {
      const key = entry.toLowerCase();
      if (!seen.has(key)) { seen.add(key); merged.push(entry); }
    }
    return merged;
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
        .replace(/stra(?:ss|s|f|fs|r)e\b/gi, "straße")
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
    void getWorkers().catch(() => {}); // start loading OCR engine + language data while the first image opens
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

  // ---- OCR pipeline -------------------------------------------------------
  // Two small, targeted passes instead of one big full-image pass:
  //  1. "overlay": the GPS text block (date, coordinates, address) is cropped from the
  //     right side of the top or bottom edge. White text is isolated first (clean and fast);
  //     a grayscale variant is the fallback. The position that worked is tried first next time.
  //  2. "paper": the whole photo, downscaled, read in sparse mode for the paper notes
  //     ("Elsterweg 5", "Fasanstraße 7", ...). Large black text survives downscaling well.
  // Both passes run in parallel in two Tesseract workers.
  const OVERLAY_ATTEMPTS = [
    { key: "top-white", box: { x: 0.28, y: 0, w: 0.72, h: 0.26 }, mode: "white" },
    { key: "bottom-white", box: { x: 0.28, y: 0.74, w: 0.72, h: 0.26 }, mode: "white" },
    { key: "top-gray", box: { x: 0, y: 0, w: 1, h: 0.26 }, mode: "gray" },
    { key: "bottom-gray", box: { x: 0, y: 0.74, w: 1, h: 0.26 }, mode: "gray" }
  ];
  const OVERLAY_TARGET_WIDTH = 1000;
  const PAPER_MAX_SIDE = 1100;

  function createOCRWorker(slot) {
    return Tesseract.createWorker("deu+eng", 1, {
      logger: (event) => {
        if (state.activeOCRItem !== currentItem()) return;
        const progress = event.progress ?? 0;
        if (event.status === "loading language traineddata") {
          setStatus("OCR-Sprachdaten werden einmalig geladen …", Math.round(progress * 30));
        } else if (event.status === "recognizing text") {
          state.ocrProgress[slot] = progress;
          setStatus("Text und Koordinaten werden gelesen …", Math.round(30 + (state.ocrProgress.overlay + state.ocrProgress.paper) * 35));
        }
      }
    });
  }

  function getWorkers() {
    if (state.workersPromise) return state.workersPromise;
    if (!window.Tesseract?.createWorker) {
      return Promise.reject(new Error("OCR-Modul konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu."));
    }
    state.workersPromise = (async () => {
      const overlay = await createOCRWorker("overlay");
      let paper;
      try { paper = await createOCRWorker("paper"); }
      catch { paper = overlay; } // low memory: share one worker and run the passes one after another
      return { overlay, paper, shared: paper === overlay };
    })().catch((error) => { state.workersPromise = null; throw error; });
    return state.workersPromise;
  }

  async function runOCR(worker, canvas, pageSegMode) {
    if (worker.__psm !== pageSegMode) {
      await worker.setParameters({ tessedit_pageseg_mode: pageSegMode, user_defined_dpi: "300" });
      worker.__psm = pageSegMode;
    }
    const result = await worker.recognize(canvas);
    return (result.data.text ?? "").trim();
  }

  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("Bild konnte für die Texterkennung nicht geöffnet werden."));
        image.src = url;
      });
      if (image.decode) await image.decode().catch(() => {});
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    return { image, release: () => URL.revokeObjectURL(url) };
  }

  function applyFilter(context, canvas, mode) {
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    if (mode === "white") {
      // Overlay text is white: keep only near-white pixels (black text on white result).
      for (let i = 0; i < px.length; i += 4) {
        const value = Math.min(px[i], px[i + 1], px[i + 2]) > 190 ? 0 : 255;
        px[i] = px[i + 1] = px[i + 2] = value;
        px[i + 3] = 255;
      }
    } else {
      const histogram = new Uint32Array(256);
      const total = px.length / 4;
      for (let i = 0; i < px.length; i += 4) {
        const gray = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
        px[i] = gray;
        histogram[gray] += 1;
      }
      let accumulated = 0, low = 0, high = 255;
      for (let v = 0; v < 256; v += 1) { accumulated += histogram[v]; if (accumulated >= total * 0.02) { low = v; break; } }
      accumulated = 0;
      for (let v = 255; v >= 0; v -= 1) { accumulated += histogram[v]; if (accumulated >= total * 0.02) { high = v; break; } }
      const range = Math.max(1, high - low);
      for (let i = 0; i < px.length; i += 4) {
        const value = Math.max(0, Math.min(255, Math.round((px[i] - low) * 255 / range)));
        px[i] = px[i + 1] = px[i + 2] = value;
        px[i + 3] = 255;
      }
    }
    context.putImageData(data, 0, 0);
  }

  function cropCanvas(image, box, mode, { maxSide = 0 } = {}) {
    const sx = Math.round(image.naturalWidth * box.x), sy = Math.round(image.naturalHeight * box.y);
    const sw = Math.max(1, Math.round(image.naturalWidth * box.w)), sh = Math.max(1, Math.round(image.naturalHeight * box.h));
    const scale = maxSide
      ? Math.min(1, maxSide / Math.max(sw, sh))
      : Math.max(0.2, Math.min(2, OVERLAY_TARGET_WIDTH / sw));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Bildbereich konnte nicht vorbereitet werden.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    applyFilter(context, canvas, mode);
    return canvas;
  }

  async function readOverlay(worker, image) {
    const hinted = OVERLAY_ATTEMPTS.find((attempt) => attempt.key === state.overlayHint);
    const attempts = hinted ? [hinted, ...OVERLAY_ATTEMPTS.filter((attempt) => attempt !== hinted)] : OVERLAY_ATTEMPTS;
    const texts = [];
    for (const attempt of attempts) {
      const text = await runOCR(worker, cropCanvas(image, attempt.box, attempt.mode), "6");
      if (text) texts.push(text);
      const coordinate = parseCoordinate(text);
      if (coordinate) {
        state.overlayHint = attempt.key;
        return { text, coordinate, coordinateText: text };
      }
    }
    return { text: texts.join("\n"), coordinate: null, coordinateText: "" };
  }

  function readPaper(worker, image) {
    const canvas = cropCanvas(image, { x: 0, y: 0, w: 1, h: 1 }, "gray", { maxSide: PAPER_MAX_SIDE });
    return runOCR(worker, canvas, "11");
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
    state.ocrProgress = { overlay: 0, paper: 0 };
    item.busy = true;
    setStatus(`Lese Bild ${state.currentIndex + 1} von ${batchEnd() - state.batchStart} …`, 0);
    updateNavigation();
    let loaded = null;
    try {
      const file = await getFile(item);
      const workers = await getWorkers();
      loaded = await loadImage(file);
      let overlay, paperText;
      if (workers.shared) {
        overlay = await readOverlay(workers.overlay, loaded.image);
        paperText = await readPaper(workers.paper, loaded.image);
      } else {
        [overlay, paperText] = await Promise.all([
          readOverlay(workers.overlay, loaded.image),
          readPaper(workers.paper, loaded.image)
        ]);
      }
      let coordinate = overlay.coordinate;
      let coordinateText = overlay.coordinateText;
      if (!coordinate) {
        const fromPaperPass = parseCoordinate(paperText);
        if (fromPaperPass) { coordinate = fromPaperPass; coordinateText = paperText; }
      }
      item.ocr = [
        overlay.text && `Bild-Einblendung:\n${overlay.text}`,
        paperText && `Zettel / restliches Bild:\n${paperText}`
      ].filter(Boolean).join("\n\n");
      item.imageCoordinate = coordinate;
      item.rawCoordinate = coordinate ? extractRawCoordinate(coordinateText) : "Keine Bildkoordinaten erkannt";
      item.addressCandidates = mergeAddressCandidates(extractAddresses(overlay.text), extractAddresses(paperText));
      item.address = item.addressCandidates[0] ?? "";
      if (!item.imageCoordinate && !item.manualCoordinateText) item.manualCoordinateText = "__°__'__,___\"N ___°__'__,___\"E";
      item.postalCode = findPostalCode(overlay.text) || findPostalCode(paperText);
      item.status = "ready";
      item.statusLabel = item.imageCoordinate ? "Bildkoordinaten erkannt" : "Adresse und Koordinaten prüfen";
      item.approved = Boolean(item.imageCoordinate);
      if (item.imageCoordinate) {
        item.coordinate = { ...item.imageCoordinate };
        item.source = "image";
        item.manualCoordinateText = formatDMSInput(item.imageCoordinate);
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
      loaded?.release();
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
    state.workersPromise?.then(({ overlay, paper }) => { void overlay.terminate(); if (paper !== overlay) void paper.terminate(); }).catch(() => {});
  });
})();
