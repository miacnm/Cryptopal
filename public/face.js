// Face check that belongs to CryptoPal, not the phone: unlocking the phone with
// Face ID or a passcode never unlocks CryptoPal. Runs on the device (face-api).
const BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';
let ready = null;

export function loadFace() {
  ready = ready || (async () => {
    const fa = await import(`${BASE}/dist/face-api.esm.js`);
    if (fa.tf?.ready) await fa.tf.ready();
    await Promise.all([
      fa.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
      fa.nets.faceLandmark68Net.loadFromUri(`${BASE}/model`),
      fa.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`)
    ]);
    return fa;
  })().catch(e => { ready = null; throw e; });
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
