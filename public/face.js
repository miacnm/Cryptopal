// Face check that belongs to CryptoPal, not the phone: unlocking the phone with
// Face ID or a passcode never unlocks CryptoPal. Runs on the device (face-api, MIT license).
// The face itself (128 numbers) is saved ONLY on this phone. CryptoPal's server never gets it.
const BASE = '/face-api';
export const FILES = [
  `${BASE}/face-api.esm.js`,
  `${BASE}/model/tiny_face_detector_model-weights_manifest.json`, `${BASE}/model/tiny_face_detector_model.bin`,
  `${BASE}/model/face_landmark_68_model-weights_manifest.json`, `${BASE}/model/face_landmark_68_model.bin`,
  `${BASE}/model/face_recognition_model-weights_manifest.json`, `${BASE}/model/face_recognition_model.bin`
];
export const CACHE = 'cp-face-1.7.15'; // the service worker serves these from the same cache
const LOAD_LIMIT = 90e3;
let ready = null;

// Download every face file into the phone once (about 8 MB), reporting 0..1 progress.
export async function downloadAll(onProgress = () => {}) {
  if (!('caches' in self)) return;
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const f of FILES) if (!(await cache.match(f))) missing.push(f);
  if (!missing.length) return onProgress(1);
  const sizes = { 'face-api.esm.js': 1333462, 'face_recognition_model.bin': 6444032, 'face_landmark_68_model.bin': 356840, 'tiny_face_detector_model.bin': 193321 };
  const size = f => sizes[f.split('/').pop()] || 20000;
  const total = missing.reduce((s, f) => s + size(f), 0);
  let done = 0;
  onProgress(0);
  for (const f of missing) {
    const r = await fetch(f, { cache: 'no-store' });
    if (!r.ok) throw new Error('download failed');
    const parts = [], reader = r.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      parts.push(value); done += value.length; onProgress(Math.min(0.99, done / total));
    }
    await cache.put(f, new Response(new Blob(parts), { headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } }));
  }
  onProgress(1);
}

export function loadFace() {
  ready = ready || Promise.race([
    (async () => {
      const fa = await import(`${BASE}/face-api.esm.js`);
      if (fa.tf?.ready) await fa.tf.ready();
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
        fa.nets.faceLandmark68Net.loadFromUri(`${BASE}/model`),
        fa.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`)
      ]);
      return fa;
    })(),
    new Promise((_, no) => setTimeout(() => no(new Error('timeout')), LOAD_LIMIT))
  ]).catch(e => { ready = null; throw e; });
  return ready;
}

// 128 numbers that describe a face, or null if no face is found.
export async function faceFrom(el, tries = 10) {
  const fa = await loadFace();
  for (let i = 0; i < tries; i++) {
    const d = await fa.detectSingleFace(el, new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })).withFaceLandmarks().withFaceDescriptor();
    if (d) return Array.from(d.descriptor);
    if (i < tries - 1) await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

// One look at the camera: the face numbers plus which way the head is turned.
// yaw: nose left/right of the eyes' middle; pitch: nose below the eyes. Both divided by the eye distance.
export async function faceAndPose(el) {
  const fa = await loadFace();
  const d = await fa.detectSingleFace(el, new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 })).withFaceLandmarks().withFaceDescriptor();
  if (!d) return null;
  const p = d.landmarks.positions;
  const avg = (a, b) => { let x = 0, y = 0; for (let i = a; i <= b; i++) { x += p[i].x; y += p[i].y; } return { x: x / (b - a + 1), y: y / (b - a + 1) }; };
  const l = avg(36, 41), r = avg(42, 47), mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const ed = Math.hypot(r.x - l.x, r.y - l.y) || 1;
  return { face: Array.from(d.descriptor), yaw: (p[30].x - mid.x) / ed, pitch: (p[30].y - mid.y) / ed };
}

// ---- the owner's face, kept on this phone only (one set of numbers per angle) ----
const key = w => 'cp_face_' + w;
export function saveMyFace(w, faces) { localStorage.setItem(key(w), JSON.stringify(faces)); }
export function myFace(w) {
  try {
    const f = JSON.parse(localStorage.getItem(key(w)) || 'null');
    const ok = x => Array.isArray(x) && x.length === 128 && x.every(Number.isFinite);
    const list = ok(f) ? [f] : Array.isArray(f) ? f.filter(ok) : [];
    return list.length ? list : null;
  } catch { return null; }
}
export function forgetMyFace(w) { try { localStorage.removeItem(key(w)); } catch {} }
// How different a face is from the owner's saved angles (0 = same; the closest angle counts).
const d1 = (x, y) => Math.sqrt(x.reduce((s, v, i) => s + (v - (y[i] || 0)) ** 2, 0));
export const faceDist = (x, saved) => Math.round(Math.min(...(Array.isArray(saved[0]) ? saved : [saved]).map(s => d1(x, s))) * 100) / 100;
export const SAME = 0.55; // under this = the same person

let stream = null;
export async function camOn(video) {
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } }, audio: false });
  video.srcObject = stream;
  await video.play().catch(() => {});
}
export function camOff() { stream?.getTracks().forEach(t => t.stop()); stream = null; }

// Grab the current camera frame as a small JPEG.
export function snap(video, max = 640) {
  const s = Math.min(1, max / Math.max(video.videoWidth || 1, video.videoHeight || 1));
  const c = document.createElement('canvas');
  c.width = Math.round((video.videoWidth || 480) * s); c.height = Math.round((video.videoHeight || 480) * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c;
}
