import glob, os, random, sys, time
import numpy as np, torch, torchaudio
from scipy.io import wavfile
from scipy.signal import fftconvolve, lfilter
from scipy.signal import stft as sstft, istft as sistft
from v4_model import V4
from v4sig_model import V4Sig, warm_from_v4

ROOT = os.path.expanduser("~/Desktop/venomx")
DATA = f"{ROOT}/data_mac"
BASES = os.path.expanduser("~/Desktop/train_voicefilter/v2t_saved/v3/v3_bases.npz")
WARM = f"{ROOT}/ckpt_vx3/vx3_step88908.pt"
ROUTER_CK = f"{ROOT}/ckpt_v7/v7_step40873.pt"
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
BATCH = 8
ASR_ITEMS = 4
ASR_CROP = 24000
ASR_W = 4.0
TAIL_W = 1.0
MEL_W = 2.0
LR = 2.5e-6
SLEEP = 0.4
PAUSE_FILE = f"{ROOT}/PAUSE"
TTS_FRAC = 0.0
TWOX = 0.0
SIGX = 0.0
QDEPTH_TOP = 38.0
STAIRS = [6.0, 10.0, 14.0, 18.0, 22.0, 26.0, 30.0, 34.0, 38.0, 42.0]
CKDIR = f"{ROOT}/ckpt_vx3c"
os.makedirs(CKDIR, exist_ok=True)
LOGF = open(f"{ROOT}/v5_log.txt", "a")

def log(m):
    LOGF.write(time.strftime("%H:%M:%S ") + m + "\n")
    LOGF.flush()
    print(m, flush=True)

def rd(p):
    sr, x = wavfile.read(p)
    return x.astype(np.float32) / 32768.0

def rr(x):
    return float(np.sqrt((x ** 2).mean()) + 1e-9)

spk_dirs = {os.path.basename(d): [f for f in glob.glob(d + "/0*.wav")
                                  if "_stem" not in f and "_v2" not in f]
            for d in sorted(glob.glob(f"{DATA}/cache_spk/*"))}
train_spk = [s for s in spk_dirs if not s.startswith("test_") and len(spk_dirs[s]) >= 4]
test_spk = [s for s in spk_dirs if s.startswith("test_") and len(spk_dirs[s]) >= 4]
loops = sorted(glob.glob(f"{DATA}/music/*.wav"))
songs = sorted(glob.glob(f"{DATA}/songs/*.wav"))
ttspool = sorted(glob.glob(f"{ROOT}/tts_pool/*.wav"))
_sb = np.load(f"{ROOT}/sig_bank.npz")
SIG_IDX = {str(nm): i for i, nm in enumerate(_sb["names"])}
SIG_VEC = _sb["vecs"].astype(np.float32)
log(f"VX1 START dev={DEV} train={len(train_spk)} test={len(test_spk)} music={len(loops)} songs={len(songs)} sigbank={len(SIG_IDX)}")
log(f"VX4S r14 SAVE THEM ALL (re-born from 182235; the one-voice era quarantined in r13_one_voice after Michael's correction): viper2 stays FROZEN and identifies up to 3 voices - the filter gets THREE fingerprint slots (576 input) filled with EVERY identified voice and the answer is ALWAYS ALL voices, never one, NEVER dominance (levels random, quietest weighted hardest); rows keep 1-3 random voices at ALL music levels; blank-slot rows keep the champion behavior; exams run blank-slot on the SAME pinned deck = no-forgetting gauge + 0.95 wire; sig cell now grades save-them-all (2 voices + 4x music, both sigs given, answer = both); ckpts prefix vx4s_step")

leakz = np.load(f"{DATA}/leak_spans.npz", allow_pickle=True) if os.path.exists(f"{DATA}/leak_spans.npz") else None
leak_fn = [str(s) for s in leakz["fn"]] if leakz is not None else []
leak_off = leakz["off"].tolist() if leakz is not None else []
log(f"leak pool: {len(leak_fn)} mined spans")

probe_files = sorted(glob.glob(f"{DATA}/songs_holdout/*.wav"))
probe_w = []
for f in probe_files[:2]:
    x = rd(f)
    for o in range(0, min(len(x) - 23040, 92160) + 1, 23040):
        w = x[o:o + 23040]
        probe_w.append(np.clip(w / rr(w) * 0.20, -1, 1))
probe_t = torch.from_numpy(np.stack(probe_w).astype(np.float32)) if probe_w else None

r = random.Random(47)
nprng = np.random.RandomState(47)

LENS = [1536 * k for k in range(2, 16)]
LENW = [5] * 13 + [35]

def crop(f, L):
    x = rd(f)
    if len(x) <= L:
        return np.pad(x, (0, L - len(x)))
    o = r.randrange(len(x) - L)
    return x[o:o + L]

def reverb_pair(x):
    rl = r.randrange(800, 4000)
    rir = nprng.normal(0, 1, rl).astype(np.float32) * np.exp(-np.arange(rl) / r.uniform(300, 1200))
    rir[0] = 1.0
    y = fftconvolve(x, rir)[: len(x)]
    return (y / (np.abs(y).max() + 1e-9) * (np.abs(x).max() + 1e-9)).astype(np.float32)

def wind_seg(L):
    n = nprng.normal(0, 1, L).astype(np.float32)
    n = lfilter([1.0], [1.0, -0.985], n).astype(np.float32)
    g = np.abs(nprng.normal(0, 1, max(L // 4800, 4))).astype(np.float32)
    g = np.interp(np.linspace(0, len(g) - 1, L), np.arange(len(g)), g).astype(np.float32)
    g = 0.3 + 0.7 * g / (g.max() + 1e-9)
    return (n * g).astype(np.float32)

def noise_seg(L):
    kind = r.random()
    if kind < 0.25:
        return wind_seg(L)
    if kind < 0.6 and (loops or songs):
        pool = songs if (songs and (not loops or r.random() < 0.6)) else loops
        mus = rd(pool[r.randrange(len(pool))])
        if len(mus) > L:
            o = r.randrange(len(mus) - L)
            return mus[o:o + L]
        return np.tile(mus, int(np.ceil(L / max(len(mus), 1))))[:L]
    n = nprng.normal(0, 1, L).astype(np.float32)
    if kind < 0.8:
        n = lfilter([1.0], [1.0, -r.uniform(0.6, 0.95)], n).astype(np.float32)
    return n

def vpio(x):
    f, t, Z = sstft(x, nperseg=512, noverlap=384)
    nb = 12
    edges = np.linspace(0, Z.shape[0], nb + 1).astype(int)
    for b in range(nb):
        if r.random() < 0.5:
            Z[edges[b]:edges[b + 1]] *= r.uniform(0.05, 1.0)
    holes = nprng.random(Z.shape) < r.uniform(0.02, 0.15)
    Z[holes] *= r.uniform(0.0, 0.3)
    _, y = sistft(Z, nperseg=512, noverlap=384)
    y = y[:len(x)].astype(np.float32)
    if len(y) < len(x):
        y = np.pad(y, (0, len(x) - len(y)))
    y = lfilter([1.0, -1.0], [1.0, -r.uniform(0.96, 0.99)], y).astype(np.float32)
    env = np.sqrt(np.convolve(y * y, np.ones(1600, np.float32) / 1600, mode="same") + 1e-9)
    tgt = 10 ** (r.uniform(-30, -22) / 20)
    pump = np.clip((tgt / (env + 1e-6)) ** r.uniform(0.4, 0.7), 0.5, 8.0)
    pump = np.convolve(pump, np.ones(2400, np.float32) / 2400, mode="same").astype(np.float32)
    return (y * pump).astype(np.float32)

router = V4()
_zr = np.load(BASES)
with torch.no_grad():
    for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
        getattr(router, k).copy_(torch.from_numpy(_zr[k]))
router.load_state_dict(torch.load(ROUTER_CK, map_location="cpu", weights_only=False)["state_dict"])
router = router.to(DEV).eval()
for p in router.parameters():
    p.requires_grad_(False)
routerB = V4()
with torch.no_grad():
    for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
        getattr(routerB, k).copy_(torch.from_numpy(_zr[k]))
routerB.load_state_dict(torch.load(f"{ROOT}/ckpt_v10/v10_step29367.pt", map_location="cpu", weights_only=False)["state_dict"])
routerB = routerB.to(DEV).eval()
for p in routerB.parameters():
    p.requires_grad_(False)
log("frozen routers loaded: 40873 + V10-29367 for triple-crush residue chain")

def song_crop(L, leak_p):
    if leak_fn and r.random() < leak_p:
        i = r.randrange(len(leak_fn))
        x = rd(leak_fn[i])
        if x.ndim > 1:
            x = x.mean(axis=1)
        c = leak_off[i] + 11520
        lo = max(0, min(c - L // 2, len(x) - L))
        if len(x) <= L:
            return np.pad(x, (0, L - len(x)))
        return x[lo:lo + L]
    pool = songs if (songs and r.random() < 0.7) else loops
    mus = rd(pool[r.randrange(len(pool))])
    if len(mus) > L:
        o = r.randrange(len(mus) - L)
        return mus[o:o + L]
    return np.tile(mus, int(np.ceil(L / max(len(mus), 1))))[:L]

def sample(spks, dirs, L):
    isloud = r.random() < 0.35
    quloud = isloud and r.random() < 0.75
    nv = r.choices([1, 2, 3], weights=[40, 45, 15] if isloud else [55, 33, 12])[0]
    chosen = r.sample(spks, nv)
    isw = r.random() < 0.08
    base_db = r.uniform(-46, -32) if isw else (r.uniform(-40, -24) if quloud else r.uniform(-40, -18))
    voices = []
    for i, spk in enumerate(chosen):
        fs = dirs[spk]
        v = crop(fs[r.randrange(len(fs))], L)
        db = base_db if i == 0 else base_db + r.uniform(-18, 3)
        v = v / rr(v) * (10 ** (db / 20))
        if r.random() < 0.6:
            v = reverb_pair(v)
        if r.random() < (0.5 if isloud else 0.25):
            n = r.randrange(L // 3, L)
            o = r.randrange(L - n + 1)
            w = np.zeros(L, np.float32)
            w[o:o + n] = v[:n]
            v = w
        voices.append(v)
    allv = np.sum(voices, axis=0).astype(np.float32)
    sig = np.zeros(576, np.float32)
    if SIGX > 0 and r.random() < 0.5:
        for si in range(nv):
            if chosen[si] in SIG_IDX:
                sig[si * 192:(si + 1) * 192] = SIG_VEC[SIG_IDX[chosen[si]]]
    label = allv
    mix = allv.copy()
    isclean = False
    if isloud:
        n = song_crop(L, 0.4)
        if r.random() < 0.9:
            n = vpio(n)
        mix = mix + n / rr(n) * rr(label) * (10 ** (((r.uniform(4, 9) if (TWOX > 0 and r.random() < 0.3) else r.uniform(3, QDEPTH_TOP)) if quloud else r.uniform(3, 15)) / 20))
    elif r.random() < 2.0 / 3.0:
        n = noise_seg(L)
        rel_db = r.uniform(-6, 6) if r.random() < 0.5 else r.uniform(-24, 10)
        mix = mix + n / rr(n) * rr(label) * (10 ** (rel_db / 20))
    else:
        mix = mix + nprng.normal(0, 10 ** (r.uniform(-52, -34) / 20), L).astype(np.float32)
        isclean = True
    hp = r.uniform(0.95, 0.985)
    a = r.uniform(-0.35, 0.35)
    proc = []
    for x in [mix, label]:
        y = lfilter([1.0, -1.0], [1.0, -hp], x).astype(np.float32)
        proc.append(lfilter([1.0, a], [1.0], y).astype(np.float32))
    m0 = proc[0]
    env = np.sqrt(np.convolve(m0 * m0, np.ones(800, np.float32) / 800, mode="same") + 1e-9)
    tgt = 10 ** (r.uniform(-28, -22) / 20)
    agc = np.clip((tgt / (env + 1e-6)) ** r.uniform(0.3, 0.6), 0.25, 4.0)
    gate_t = 10 ** (r.uniform(-50, -40) / 20)
    gate = np.clip(env / gate_t, 0.05, 1.0) ** r.uniform(0.5, 1.5)
    gain = np.convolve(agc * gate, np.ones(1600, np.float32) / 1600, mode="same").astype(np.float32)
    mix, label = proc[0] * gain, proc[1] * gain
    isres = False
    voiceless = r.random() < 0.25
    if voiceless:
        label = np.zeros(L, np.float32)
        sig = np.zeros(576, np.float32)
        kind = r.random()
        if kind < 0.35 and songs:
            n = vpio(song_crop(L, 0.4))
            isres = True
        elif kind < 0.85 and songs:
            s0 = song_crop(L, 0.4)
            if r.random() < 0.5:
                s0 = vpio(s0)
            s0 = np.clip(s0 / rr(s0) * 0.20, -1, 1)
            with torch.no_grad():
                n = router(torch.from_numpy(s0[None]).to(DEV))[0].cpu().numpy()[:L]
                if len(n) < L:
                    n = np.pad(n, (0, L - len(n)))
                if r.random() < 0.6:
                    n1 = np.clip(n / (rr(n) + 1e-9) * 0.06, -1, 1)
                    n = routerB(torch.from_numpy(n1[None]).to(DEV))[0].cpu().numpy()[:L]
                    if len(n) < L:
                        n = np.pad(n, (0, L - len(n)))
            isres = True
        elif ttspool and TTS_FRAC > 0 and kind < 0.85 + 0.10 * TTS_FRAC:
            n = vpio(crop(ttspool[r.randrange(len(ttspool))], L))
            isres = True
        else:
            n = noise_seg(L)
        n = lfilter([1.0, -1.0], [1.0, -hp], n).astype(np.float32)
        n = lfilter([1.0, a], [1.0], n).astype(np.float32)
        mix = n / rr(n) * r.uniform(0.05, 0.30)
    elif r.random() < 0.08 and songs:
        s0 = song_crop(L, 0.4)
        if r.random() < 0.5:
            s0 = vpio(s0)
        s0 = np.clip(s0 / rr(s0) * 0.20, -1, 1)
        with torch.no_grad():
            res = routerB(torch.from_numpy(s0[None]).to(DEV))[0].cpu().numpy()[:L]
        if len(res) < L:
            res = np.pad(res, (0, L - len(res)))
        mix = mix + res / rr(res) * rr(label) * (10 ** (r.uniform(-6, 6) / 20))
    elif ttspool and TTS_FRAC > 0 and r.random() < 0.08 * TTS_FRAC:
        t = vpio(crop(ttspool[r.randrange(len(ttspool))], L))
        mix = mix + t / rr(t) * rr(label) * (10 ** (r.uniform(-18, -12 + 6 * TTS_FRAC) / 20))
    if r.random() < 0.15 and L > 3072:
        wl = r.randrange(1536, L - 1536)
        mix[:wl] = 0
        label[:wl] = 0
    pk = np.abs(mix).max()
    if pk > 0.98:
        mix = mix / pk * 0.9
        label = label / pk * 0.9
    return mix.astype(np.float32), label, ((isw or quloud or isclean) and not voiceless), isres, (quloud and not voiceless), sig

def spoken_twin(spks, dirs, L, tgt_rms):
    spk = r.choice(spks)
    fs = dirs[spk]
    v = crop(fs[r.randrange(len(fs))], L)
    v = vpio(v)
    hp = r.uniform(0.95, 0.985)
    a = r.uniform(-0.35, 0.35)
    v = lfilter([1.0, -1.0], [1.0, -hp], v).astype(np.float32)
    v = lfilter([1.0, a], [1.0], v).astype(np.float32)
    v = np.clip(v / rr(v) * tgt_rms, -1, 1).astype(np.float32)
    return v

def sung_twin(L):
    mus = song_crop(L, 0.4)
    if r.random() < 0.7:
        mus = vpio(mus)
    sng = song_crop(L, 1.0)
    if r.random() < 0.7:
        sng = vpio(sng)
    mix = mus / rr(mus) + sng / rr(sng) * (10 ** (-r.uniform(3, 20.0) / 20))
    hp = r.uniform(0.95, 0.985)
    a = r.uniform(-0.35, 0.35)
    mix = lfilter([1.0, -1.0], [1.0, -hp], mix).astype(np.float32)
    mix = lfilter([1.0, a], [1.0], mix).astype(np.float32)
    return np.clip(mix / rr(mix) * r.uniform(0.05, 0.30), -1, 1).astype(np.float32)

def make_batch(spks, dirs, n, L):
    ms, ls, ws, rs, qs, gs = [], [], [], [], [], []
    while len(ms) < n:
        m, l, w, ir, iq, sg = sample(spks, dirs, L)
        ms.append(m); ls.append(l); ws.append(w); rs.append(ir); qs.append(iq); gs.append(sg)
        if ir and len(ms) < n:
            tw = spoken_twin(spks, dirs, L, rr(m))
            ms.append(tw); ls.append(tw.copy()); ws.append(True); rs.append(False); qs.append(False)
            gs.append(np.zeros(576, np.float32))
        if iq and len(ms) < n:
            sm = sung_twin(L)
            ms.append(sm); ls.append(np.zeros(L, np.float32)); ws.append(False); rs.append(False); qs.append(True)
            gs.append(np.zeros(576, np.float32))
    return (torch.from_numpy(np.stack(ms)), torch.from_numpy(np.stack(ls)),
            torch.tensor(ws), torch.tensor(rs), torch.tensor(qs),
            torch.from_numpy(np.stack(gs)))

def sisdr(est, ref):
    ref_e = (ref * ref).sum(-1, keepdim=True)
    proj = ((est * ref).sum(-1, keepdim=True) / (ref_e + 1e-8)) * ref
    noise = est - proj
    return 10 * torch.log10(((proj * proj).sum(-1) + 1e-8) / ((noise * noise).sum(-1) + 1e-8))

WINS = {nf: torch.hann_window(nf, device=DEV) for nf in (256, 512, 1024)}

def spec_l1(est, ref):
    tot = torch.zeros((), device=DEV)
    for nf, hop in ((512, 128), (1024, 256), (256, 64)):
        se = torch.stft(est, n_fft=nf, hop_length=hop, window=WINS[nf], return_complex=True).abs()
        sr = torch.stft(ref, n_fft=nf, hop_length=hop, window=WINS[nf], return_complex=True).abs()
        tot = tot + (torch.log(se + 1e-5) - torch.log(sr + 1e-5)).abs().mean()
    return tot / 3.0

MELSPEC = torchaudio.transforms.MelSpectrogram(
    sample_rate=16000, n_fft=512, hop_length=128, n_mels=64).to(DEV)

def mel_fid(est, ref):
    me = torch.log(MELSPEC(est) + 1e-5)
    mr = torch.log(MELSPEC(ref) + 1e-5)
    err = (me - mr).abs()
    ren = mr.mean(dim=1)
    attack = torch.relu(ren[:, 1:] - ren[:, :-1])
    w = 1.0 + 2.0 * attack / (attack.mean() + 1e-4)
    return (err[..., 1:] * w.unsqueeze(1)).mean()

bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
asr = bundle.get_model().to(DEV)
asr.eval()
for p in asr.parameters():
    p.requires_grad_(False)
log("ASR grader loaded (wav2vec2 base 960h, frozen)")

def asr_loss(est, ref):
    k = min(ASR_ITEMS, est.shape[0])
    idx = torch.randperm(est.shape[0])[:k]
    T = est.shape[-1]
    cl = min(ASR_CROP, T)
    o = r.randrange(0, T - cl + 1)
    e = est[idx, o:o + cl]
    rf = ref[idx, o:o + cl]
    fe, _ = asr.extract_features(e, num_layers=6)
    with torch.no_grad():
        fr, _ = asr.extract_features(rf, num_layers=6)
    a, b = fe[-1], fr[-1]
    return ((a - b) ** 2).mean() / (b.detach().pow(2).mean() + 1e-6)

_r_sv = r
_np_sv = nprng
r = random.Random(313)
nprng = np.random.RandomState(313)
_vp = []
for w in probe_w:
    v = vpio(w)
    _vp.append(np.clip(v / (np.sqrt((v ** 2).mean()) + 1e-9) * 0.20, -1, 1).astype(np.float32))
vpio_probe_t = torch.from_numpy(np.stack(_vp)) if _vp else None

_sp = []
if test_spk:
    for i in range(12):
        spk = test_spk[i % len(test_spk)]
        v = crop(spk_dirs[spk][r.randrange(len(spk_dirs[spk]))], 23040)
        v = vpio(v)
        lvl = (0.02, 0.05, 0.09)[i % 3]
        _sp.append(np.clip(v / (np.sqrt((v ** 2).mean()) + 1e-9) * lvl, -1, 1).astype(np.float32))
sp_probe_t = torch.from_numpy(np.stack(_sp)) if _sp else None
sp_probe_rms = torch.sqrt((sp_probe_t ** 2).mean(dim=1)) if _sp else None

_qlm, _qlr = [], []
if test_spk and songs:
    for i in range(12):
        spk = test_spk[i % len(test_spk)]
        v = crop(spk_dirs[spk][r.randrange(len(spk_dirs[spk]))], 23040)
        v = np.clip(v / (np.sqrt((v ** 2).mean()) + 1e-9) * 0.03, -1, 1).astype(np.float32)
        mus = vpio(song_crop(23040, 0.0))
        over = (2.0, 3.2, 5.0, 8.0)[i % 4]
        m = np.clip(v + mus / (np.sqrt((mus ** 2).mean()) + 1e-9) * 0.03 * over, -1, 1).astype(np.float32)
        _qlm.append(m); _qlr.append(v)
ql_mix_t = torch.from_numpy(np.stack(_qlm)) if _qlm else None
ql_ref_t = torch.from_numpy(np.stack(_qlr)) if _qlr else None
_bs = []
if leak_fn and songs:
    for i in range(12):
        sng = song_crop(23040, 1.0)
        sng = np.clip(sng / (np.sqrt((sng ** 2).mean()) + 1e-9) * 0.03, -1, 1).astype(np.float32)
        mus = vpio(song_crop(23040, 0.0))
        over = (2.0, 3.2, 5.0, 8.0)[i % 4]
        _bs.append(np.clip(sng + mus / (np.sqrt((mus ** 2).mean()) + 1e-9) * 0.03 * over, -1, 1).astype(np.float32))
bs_mix_t = torch.from_numpy(np.stack(_bs)) if _bs else None
_te = []
if ttspool:
    for i in range(12):
        t = crop(ttspool[i % len(ttspool)], 23040)
        t = vpio(t)
        _te.append(np.clip(t / (np.sqrt((t ** 2).mean()) + 1e-9) * (0.03, 0.08, 0.15)[i % 3], -1, 1).astype(np.float32))
te_mix_t = torch.from_numpy(np.stack(_te)) if _te else None
_sgm, _sgr, _sgv = [], [], []
if songs and len(test_spk) >= 10:
    for j in range(5):
        va = rd(spk_dirs[test_spk[j]][0])[:23040]
        vb = rd(spk_dirs[test_spk[j + 5]][0])[:23040]
        va = np.pad(va, (0, 23040 - len(va))) if len(va) < 23040 else va
        vb = np.pad(vb, (0, 23040 - len(vb))) if len(vb) < 23040 else vb
        va = (va / (np.sqrt((va ** 2).mean()) + 1e-9) * 0.05).astype(np.float32)
        vb = (vb / (np.sqrt((vb ** 2).mean()) + 1e-9) * 0.05).astype(np.float32)
        mus = rd(songs[j % len(songs)])
        mus = mus[100000:123040] if len(mus) >= 123040 else np.pad(mus[:23040], (0, max(0, 23040 - len(mus))))
        mus = (mus / (np.sqrt((mus ** 2).mean()) + 1e-9) * 0.05 * 4.0).astype(np.float32)
        mx = np.clip(va + vb + mus, -1, 1)
        sc = 0.05 / (np.sqrt((mx ** 2).mean()) + 1e-9)
        _sgm.append((mx * sc).astype(np.float32))
        _sgr.append(((va + vb) * sc).astype(np.float32))
        sv2 = np.zeros(576, np.float32)
        if test_spk[j] in SIG_IDX:
            sv2[0:192] = SIG_VEC[SIG_IDX[test_spk[j]]]
        if test_spk[j + 5] in SIG_IDX:
            sv2[192:384] = SIG_VEC[SIG_IDX[test_spk[j + 5]]]
        _sgv.append(sv2)
sig_mix_t = torch.from_numpy(np.stack(_sgm)) if _sgm else None
sig_ref_t = torch.from_numpy(np.stack(_sgr)) if _sgr else None
sig_vec_t = torch.from_numpy(np.stack(_sgv)) if _sgv else None
r = _r_sv
nprng = _np_sv

cks = sorted(glob.glob(f"{CKDIR}/vx4s_step*.pt"),
             key=lambda p: int(p.split("step")[-1].split(".")[0]))
if cks:
    model = V4Sig()
    z = np.load(BASES)
    with torch.no_grad():
        for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
            getattr(model, k).copy_(torch.from_numpy(z[k]))
    sd = torch.load(cks[-1], map_location="cpu", weights_only=False)
    model.load_state_dict(sd["state_dict"])
    step = sd["step"]
    log(f"resumed {cks[-1]}")
else:
    model, _wl = warm_from_v4(BASES, f"{ROOT}/ckpt_vx3c/vx3c_step182235.pt")
    step = 182235
    log(f"warm-born V4Sig from vx3c_step182235 ({_wl} tensors, zero-init sig wire)")
model = model.to(DEV)
opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-5)

def evaluate():
    model.eval()
    sv = nprng.get_state()
    global r, TTS_FRAC, QDEPTH_TOP, TWOX, SIGX
    r_old = r
    tf_old = TTS_FRAC
    qd_old = QDEPTH_TOP
    tx_old = TWOX
    sx_old = SIGX
    TTS_FRAC = 1.0
    QDEPTH_TOP = 38.0
    TWOX = 0.0
    SIGX = 0.0
    r = random.Random(777)
    nprng.seed(777)
    zs = lambda t: torch.zeros(t.shape[0], 576, device=DEV)
    tot, n, rej, rn = 0.0, 0, 0.0, 0
    with torch.no_grad():
        for _ in range(6):
            m, l, _, _, _, _ = make_batch(test_spk, spk_dirs, 8, LENS[-1])
            y = model(m.to(DEV), zs(m)).cpu()
            L = min(y.shape[-1], l.shape[-1])
            act = (l[..., :L] ** 2).mean(-1) > 1e-6
            if act.any():
                tot += float(sisdr(y[..., :L][act], l[..., :L][act]).mean())
                n += 1
            sil = ~act
            if sil.any():
                rej += float(torch.sqrt((y[..., :L][sil] ** 2).mean()))
                rn += 1
    pk, vk = 0.0, 0.0
    if probe_t is not None:
        with torch.no_grad():
            py = model(probe_t.to(DEV), zs(probe_t))
        pk = float(torch.sqrt((py[..., -3072:-1536] ** 2).mean(-1)).max())
    if vpio_probe_t is not None:
        with torch.no_grad():
            vy = model(vpio_probe_t.to(DEV), zs(vpio_probe_t))
        vk = float(torch.sqrt((vy[..., -3072:-1536] ** 2).mean(-1)).max())
    ql = 0.0
    if ql_mix_t is not None:
        with torch.no_grad():
            qy = model(ql_mix_t.to(DEV), zs(ql_mix_t)).cpu()
        Lq = min(qy.shape[-1], ql_ref_t.shape[-1])
        ql = float(sisdr(qy[..., :Lq], ql_ref_t[..., :Lq]).mean())
    bs = 0.0
    if bs_mix_t is not None:
        with torch.no_grad():
            by = model(bs_mix_t.to(DEV), zs(bs_mix_t))
        bs = float(torch.sqrt((by[..., -3072:-1536] ** 2).mean(-1)).max())
    te = 0.0
    if te_mix_t is not None:
        with torch.no_grad():
            ty = model(te_mix_t.to(DEV), zs(te_mix_t))
        te = float(torch.sqrt((ty[..., -3072:-1536] ** 2).mean(-1)).max())
    sk = 1.0
    if sp_probe_t is not None:
        with torch.no_grad():
            sy = model(sp_probe_t.to(DEV), zs(sp_probe_t)).cpu()
        Ls = min(sy.shape[-1], sp_probe_t.shape[-1])
        outr = torch.sqrt((sy[..., :Ls] ** 2).mean(dim=1))
        sk = float((outr / sp_probe_rms.clamp_min(1e-6)).min())
    dg = 0.0
    if sig_mix_t is not None:
        with torch.no_grad():
            dy = model(sig_mix_t.to(DEV), sig_vec_t.to(DEV)).cpu()
        Ld = min(dy.shape[-1], sig_ref_t.shape[-1])
        dg = float(sisdr(dy[..., :Ld], sig_ref_t[..., :Ld]).mean())
    r = r_old
    TTS_FRAC = tf_old
    QDEPTH_TOP = qd_old
    TWOX = tx_old
    SIGX = sx_old
    nprng.set_state(sv)
    model.train()
    return tot / max(n, 1), rej / max(rn, 1), pk, vk, sk, ql, bs, te, dg

run_si, run_sp, run_asr, run_tail, run_fid, last_ck = 0.0, 0.0, 0.0, 0.0, 0.0, time.time()
while True:
    TTS_FRAC = min(0.05, max(0.0, (step - 99000) / 30000.0))
    TWOX = 1.0
    SIGX = 1.0
    QDEPTH_TOP = STAIRS[(step // 2500) % len(STAIRS)]
    L = r.choices(LENS, weights=LENW)[0]
    m, l, wfl, rfl, qfl, sg = make_batch(train_spk, spk_dirs, BATCH, L)
    m, l, wfl, rfl, qfl, sg = m.to(DEV), l.to(DEV), wfl.to(DEV), rfl.to(DEV), qfl.to(DEV), sg.to(DEV)
    y = model(m, sg)
    L = min(y.shape[-1], l.shape[-1])
    y = y[..., :L]
    lb = l[..., :L]
    act = (lb * lb).mean(-1) > 1e-6
    loss = torch.zeros((), device=DEV)
    si_part, sp_part, asr_part, tail_part, fid_part = 0.0, 0.0, 0.0, 0.0, 0.0
    if act.any():
        lrms = lb[act].pow(2).mean(-1).sqrt().clamp_min(1e-6)
        wrow = torch.where(wfl[act], (0.05 / lrms).clamp(1.0, 12.0), torch.ones_like(lrms))
        wrow = torch.where(qfl[act], wrow * 5.0, wrow)
        si = -(wrow * sisdr(y[act], lb[act])).sum() / wrow.sum()
        sp = spec_l1(y[act], lb[act])
        al = asr_loss(y[act], lb[act])
        loss = loss + si + 3.0 * sp + ASR_W * al
        if L >= 3072:
            fid = mel_fid(y[act][..., -3072:-1536], lb[act][..., -3072:-1536])
            loss = loss + MEL_W * fid
            fid_part = float(fid.detach())
        tail = min(3072, L)
        ty, tl = y[act][..., -tail:], lb[act][..., -tail:]
        tact = (tl * tl).mean(-1) > 1e-6
        if tact.any():
            tsi = -sisdr(ty[tact], tl[tact]).mean()
            tsp = spec_l1(ty[tact], tl[tact])
            loss = loss + TAIL_W * (tsi + 3.0 * tsp)
            tail_part = float(tsi.detach())
        si_part, sp_part, asr_part = float(si.detach()), float(sp.detach()), float(al.detach())
    sil = ~act
    if sil.any():
        silres = sil & rfl
        silsung = sil & qfl & ~rfl
        silplain = sil & ~rfl & ~qfl
        for rows, w in ((silres, 120.0), (silsung, 90.0), (silplain, 60.0)):
            if rows.any():
                loss = loss + w * torch.sqrt((y[rows] ** 2).mean() + 1e-8)
                if L >= 3072:
                    loss = loss + w * torch.sqrt((y[rows][..., -3072:-1536] ** 2).mean() + 1e-8)
    opt.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    opt.step()
    run_si += si_part
    run_sp += sp_part
    run_asr += asr_part
    run_tail += tail_part
    run_fid += fid_part
    step += 1
    time.sleep(SLEEP)
    if os.path.exists(PAUSE_FILE):
        torch.save({"state_dict": model.state_dict(), "step": step}, f"{CKDIR}/vx4s_step{step}.pt")
        log(f"PAUSED at step {step} - checkpoint saved, safe to shut down")
        sys.exit(0)
    if step % 100 == 0:
        log(f"step {step} sisdr_loss {run_si/100:.3f} spec {run_sp/100:.3f} asr {run_asr/100:.3f} tail {run_tail/100:.3f} fid {run_fid/100:.3f}")
        run_si, run_sp, run_asr, run_tail, run_fid = 0.0, 0.0, 0.0, 0.0, 0.0
    if time.time() - last_ck >= 900:
        si_e, rj, pk, vk, sk, ql, bs, te, dg = evaluate()
        torch.save({"state_dict": model.state_dict(), "step": step}, f"{CKDIR}/vx4s_step{step}.pt")
        log(f"ckpt step {step} testSISDR {si_e:.2f}dB silRMS {rj:.4f} leak@0.2 {pk:.4f} vpioleak {vk:.4f} spkeep {sk:.2f} quloud {ql:.2f}dB bsng {bs:.4f} ttse {te:.4f} sig {dg:.2f}dB stair {QDEPTH_TOP:.0f}dB")
        last_ck = time.time()
