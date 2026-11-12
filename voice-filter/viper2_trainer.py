import glob, os, random, sys, time
from itertools import permutations
import numpy as np, torch
import torch.nn.functional as F
from scipy.io import wavfile
from scipy.signal import fftconvolve, lfilter
from viper2_model import Viper2, load_from_champion, K_SLOTS, SEG2

ROOT = os.path.expanduser("~/Desktop/venomx")
TEST_CACHE = os.path.expanduser("~/Desktop/train_voicefilter/v2t_saved/exam")
CHAMPION = os.path.expanduser("~/Desktop/train_voicefilter/checkpoints_recovered/viper_step103446.pt")
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
BATCH = 24
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 10_000_000
SLEEP = 0.4
PAUSE_FILE = f"{os.path.expanduser('~/Desktop/venomx')}/PAUSE"
os.makedirs(f"{ROOT}/ckpt2r", exist_ok=True)
LOGF = open(f"{ROOT}/viper2_log.txt", "a")

def log(m):
    LOGF.write(time.strftime("%H:%M:%S ") + m + "\n")
    LOGF.flush()
    print(m, flush=True)

def rd(p):
    sr, x = wavfile.read(p)
    return x.astype(np.float32) / 32768.0

def rr(x):
    return float(np.sqrt((x ** 2).mean()) + 1e-9)

bank = dict(np.load(f"{ROOT}/data_mac/sig_bank.npz"))
train_dirs = {os.path.basename(d): [f for f in sorted(glob.glob(d + "/0*.wav"))
                                    if "_stem" not in f and "_v2" not in f]
              for d in sorted(glob.glob(f"{ROOT}/data_mac/cache_spk/*"))
              if not os.path.basename(d).startswith("test_")}
train_spk = [s for s in train_dirs if s in bank and len(train_dirs[s]) >= 8]
test_dirs = {os.path.basename(d): [f for f in sorted(glob.glob(d + "/0*.wav"))
                                   if "_stem" not in f and "_v2" not in f]
             for d in sorted(glob.glob(f"{TEST_CACHE}/cache_spk/test_*"))}
test_spk = [s for s in test_dirs if s in bank and len(test_dirs[s]) >= 4]
train_bank_mat = np.stack([bank[s] for s in train_spk]).astype(np.float32)
loops = sorted(glob.glob(f"{TEST_CACHE}/music/*.wav"))
songs = sorted(glob.glob(f"{ROOT}/data_mac/songs/*.wav"))
log(f"VIPER2 START dev={DEV} train={len(train_spk)} test={len(test_spk)} music={len(loops)} songs={len(songs)} steps={STEPS}")

r = random.Random(53)
nprng = np.random.RandomState(53)

def crop(f):
    x = rd(f)
    if len(x) <= SEG2:
        return np.pad(x, (0, SEG2 - len(x)))
    o = r.randrange(len(x) - SEG2)
    return x[o:o + SEG2]

def reverb_pair(x):
    rl = r.randrange(800, 4000)
    rir = nprng.normal(0, 1, rl).astype(np.float32) * np.exp(-np.arange(rl) / r.uniform(300, 1200))
    rir[0] = 1.0
    y = fftconvolve(x, rir)[: len(x)]
    return (y / (np.abs(y).max() + 1e-9) * (np.abs(x).max() + 1e-9)).astype(np.float32)

def sample(spks, dirs, mode=None):
    if mode == "empty":
        nv = 0
    elif mode == "onset":
        nv = 1
    elif mode is None:
        nv = r.choices([0, 1, 2, 3], weights=[12, 40, 35, 13])[0]
    else:
        nv = r.choices([1, 2, 3], weights=[25, 55, 20])[0]
    chosen = r.sample(spks, nv)
    base_db = r.uniform(-40, -26) if mode == "rawquiet" else r.uniform(-32, -18)
    voices = []
    for i, spk in enumerate(chosen):
        fs = dirs[spk]
        v = crop(fs[r.randrange(len(fs))])
        db = base_db if i == 0 else base_db + r.uniform(-8, 3)
        v = v / rr(v) * (10 ** (db / 20))
        if r.random() < 0.6:
            v = reverb_pair(v)
        voices.append(v)
    if voices and (mode == "onset" or (mode is None and r.random() < 0.10)):
        cut = SEG2 - int(r.uniform(0.25, 1.0) * 16000)
        voices = [np.concatenate([np.zeros(cut, np.float32), v[cut:]]) for v in voices]
    mix = np.sum(voices, axis=0) if voices else np.zeros(SEG2, np.float32)
    want_music = (mode == "musicv5") or (mode == "empty" and r.random() < 0.75) or (mode == "onset" and r.random() < 0.5) or (mode is None and r.random() < 0.55)
    if want_music and (loops or songs):
        pool = songs if (songs and (not loops or r.random() < 0.6)) else loops
        mus = rd(pool[r.randrange(len(pool))])
        if len(mus) > SEG2:
            o = r.randrange(len(mus) - SEG2)
            mus = mus[o:o + SEG2]
        else:
            mus = np.tile(mus, int(np.ceil(SEG2 / max(len(mus), 1))))[:SEG2]
        mus_db = r.uniform(-14, -6) if r.random() < 0.25 else r.uniform(-36, -8)
        mix = mix + mus / rr(mus) * (10 ** (mus_db / 20))
    else:
        mix = mix + nprng.normal(0, 10 ** (r.uniform(-52, -36) / 20), SEG2).astype(np.float32)
    hp = r.uniform(0.95, 0.985)
    a = r.uniform(-0.35, 0.35)
    mix = lfilter([1.0, -1.0], [1.0, -hp], mix).astype(np.float32)
    mix = lfilter([1.0, a], [1.0], mix).astype(np.float32)
    env = np.sqrt(np.convolve(mix * mix, np.ones(800, np.float32) / 800, mode="same") + 1e-9)
    tgt = 10 ** (r.uniform(-28, -22) / 20)
    agc = np.clip((tgt / (env + 1e-6)) ** r.uniform(0.3, 0.6), 0.25, 4.0)
    gate_t = 10 ** (r.uniform(-50, -40) / 20)
    gate = np.clip(env / gate_t, 0.05, 1.0) ** r.uniform(0.5, 1.5)
    gain = np.convolve(agc * gate, np.ones(1600, np.float32) / 1600, mode="same").astype(np.float32)
    mix = mix * gain
    pk = np.abs(mix).max()
    if pk > 0.98:
        mix = mix / pk * 0.9
    tsigs = np.stack([bank[s] for s in chosen]) if chosen else np.zeros((0, 192), np.float32)
    return mix.astype(np.float32), tsigs, nv, bool(want_music and (loops or songs)), chosen

def make_batch(spks, dirs, n, mode=None):
    ms, ts, ns, mm, who = [], [], [], [], []
    for _ in range(n):
        m, t, nv, hm, ch = sample(spks, dirs, mode)
        ms.append(m)
        ts.append(t)
        ns.append(nv)
        mm.append(hm)
        who.append(ch)
    return torch.from_numpy(np.stack(ms)), ts, ns, torch.tensor(mm), who

def v5_route(x, leak=None):
    c = v5(x)[..., : x.shape[-1]]
    if leak is not None:
        c = c + leak * x[..., : c.shape[-1]]
    tg = torch.empty(c.shape[0], 1, device=c.device).uniform_(0.045, 0.075)
    rms = c.pow(2).mean(dim=1, keepdim=True).sqrt().clamp_min(1e-6)
    return (c * (tg / rms)).clamp_(-1, 1)

def route_rows(md, rows):
    if not bool(rows.any()):
        return md
    idx = rows.nonzero(as_tuple=True)[0]
    half = idx[torch.rand(len(idx), device=md.device) < 0.5]
    rest = idx[~torch.isin(idx, half)]
    if len(rest):
        md[rest] = v5_route(md[rest])
    if len(half):
        alpha = torch.empty(len(half), 1, device=md.device).uniform_(0.0, 0.15)
        md[half] = v5_route(md[half], leak=alpha)
    return md

def pit_loss(sigs, pres, tsigs_list, nvs, names):
    B = sigs.shape[0]
    total = torch.zeros((), device=sigs.device)
    cos_hits = 0.0
    voiced_n = 0
    for b in range(B):
        t = torch.from_numpy(tsigs_list[b]).to(sigs.device)
        nv = nvs[b]
        best = None
        for perm in permutations(range(K_SLOTS), nv):
            cos = torch.zeros((), device=sigs.device)
            for j, sl in enumerate(perm):
                cos = cos + (1.0 - (sigs[b, sl] * t[j]).sum())
            tgt = torch.zeros(K_SLOTS, device=sigs.device)
            for sl in perm:
                tgt[sl] = 1.0
            bce = F.binary_cross_entropy_with_logits(pres[b], tgt, reduction="sum")
            cost = 2.0 * cos + 0.3 * bce
            if best is None or cost < best[0]:
                best = (cost, cos, perm)
        total = total + best[0]
        here = set(names[b])
        cand = [i for i in nprng.choice(len(train_spk), 14, replace=False)
                if train_spk[i] not in here][:8]
        if cand:
            negt = torch.from_numpy(train_bank_mat[cand]).to(sigs.device)
            rep = torch.zeros((), device=sigs.device)
            for sl in best[2]:
                nc = (sigs[b, sl][None, :] * negt).sum(dim=1).max()
                rep = rep + (nc - 0.35).clamp(min=0)
            total = total + 0.5 * rep
        if nv > 0:
            cos_hits += float(best[1].detach()) / nv
            voiced_n += 1
    return total / B, cos_hits / max(voiced_n, 1)

model, nload = load_from_champion(CHAMPION)
model = model.to(DEV)

from v4_model import V4
v5 = V4()
_zb = np.load(os.path.expanduser("~/Desktop/train_voicefilter/v2t_saved/v3/v3_bases.npz"))
with torch.no_grad():
    for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
        getattr(v5, k).copy_(torch.from_numpy(_zb[k]))
v5.load_state_dict(torch.load(f"{ROOT}/ckpt_v7/v7_step40873.pt",
                              map_location="cpu", weights_only=False)["state_dict"])
v5 = v5.to(DEV).eval()
for p in v5.parameters():
    p.requires_grad_(False)
log("VIPER2R routed diet: frozen v7_step40873 (the crown) — music mixes v7-cleaned + LEAK-AUGMENTED (alpha 0-0.15 partial-squash sim) + normed like the router; loudmusic cell 25% (music -14..-6dB over voices); no-music mixes raw")
cks = sorted(glob.glob(f"{ROOT}/ckpt2r/viper2r_step*.pt"),
             key=lambda p: int(p.split("step")[-1].split(".")[0]))
step0 = 0
if cks:
    sd = torch.load(cks[-1], map_location="cpu", weights_only=False)
    model.load_state_dict(sd["state_dict"])
    step0 = sd["step"]
    log(f"resumed {cks[-1]}")
else:
    _old2 = sorted(glob.glob(f"{ROOT}/ckpt2/viper2_step*.pt"),
                   key=lambda p: int(p.split("step")[-1].split(".")[0]))
    if _old2:
        _sd2 = torch.load(_old2[-1], map_location="cpu", weights_only=False)
        model.load_state_dict(_sd2["state_dict"])
        log(f"warm from trained viper2 {_old2[-1]}")
    else:
        log(f"champion tensors loaded: {nload}")
opt = torch.optim.AdamW([
    {"params": [p for n, p in model.named_parameters()
                if n.startswith(("slot_attn", "pres"))], "lr": 3e-4},
    {"params": [p for n, p in model.named_parameters()
                if not n.startswith(("slot_attn", "pres"))], "lr": 7e-5},
], weight_decay=1e-5)

id_r = random.Random(999)
id_w, id_lab = [], []
for si, s in enumerate(test_spk[:10]):
    for _ in range(4):
        x = rd(id_r.choice(test_dirs[s]))
        if len(x) <= SEG2:
            x = np.pad(x, (0, SEG2 - len(x)))
        else:
            o = id_r.randrange(len(x) - SEG2)
            x = x[o:o + SEG2]
        x = x / (np.sqrt((x ** 2).mean()) + 1e-9) * 0.03
        id_w.append(x.astype(np.float32))
        id_lab.append(si)
id_t = torch.from_numpy(np.stack(id_w))
id_lab = np.array(id_lab)

_r_sv = r
r = random.Random(777)
_emps = [sample(test_spk, test_dirs, "empty") for _ in range(40)]
r = _r_sv
emp_t = torch.from_numpy(np.stack([e[0] for e in _emps]))
emp_m = torch.tensor([e[3] for e in _emps])
with torch.no_grad():
    _e = emp_t.to(DEV)
    _rows = emp_m.to(DEV)
    if _rows.any():
        _e[_rows] = v5_route(_e[_rows])
    emp_t = _e.cpu()
log(f"phantom exam set built: 40 zero-voice windows ({int(emp_m.sum())} crushed-music routed, rest noise)")

_r_sv3 = r
r = random.Random(444)
_res = [sample(test_spk, test_dirs, "empty") for _ in range(40)]
r = _r_sv3
res_t = torch.from_numpy(np.stack([e[0] for e in _res]))
res_m = torch.tensor([e[3] for e in _res])
with torch.no_grad():
    _re = res_t.to(DEV)
    _rerows = res_m.to(DEV)
    if _rerows.any():
        _re[_rerows] = v5_route(_re[_rerows], leak=0.08)
    res_t = _re.cpu()
log(f"residue phantom exam set built: 40 zero-voice windows at leak 0.08 ({int(res_m.sum())} music)")

_r_sv2 = r
r = random.Random(555)
_ons = [sample(test_spk, test_dirs, "onset") for _ in range(40)]
r = _r_sv2
ons_t = torch.from_numpy(np.stack([e[0] for e in _ons]))
ons_m = torch.tensor([e[3] for e in _ons])
with torch.no_grad():
    _o = ons_t.to(DEV)
    _orows = ons_m.to(DEV)
    if _orows.any():
        _o[_orows] = v5_route(_o[_orows])
    ons_t = _o.cpu()
log(f"onset exam set built: 40 fresh-speech-tail windows ({int(ons_m.sum())} with music)")

def evaluate():
    model.eval()
    sv = nprng.get_state()
    global r
    r_old = r
    res = {}
    with torch.no_grad():
        for mode in ("musicv5", "rawquiet"):
            r = random.Random(888)
            nprng.seed(888)
            cs, pa, n = 0.0, 0.0, 0
            for _ in range(3):
                m, ts, ns, mm, _ = make_batch(test_spk, test_dirs, 16, mode)
                if mode == "musicv5":
                    m = v5_route(m.to(DEV)).cpu()
                sigs, pres = model(m.to(DEV))
                for b in range(len(ns)):
                    t = torch.from_numpy(ts[b]).to(DEV)
                    nv = ns[b]
                    best = None
                    for perm in permutations(range(K_SLOTS), nv):
                        cos = sum(float((sigs[b, sl] * t[j]).sum()) for j, sl in enumerate(perm))
                        if best is None or cos > best[0]:
                            best = (cos, perm)
                    cs += best[0] / nv
                    pred_on = set(i for i in range(K_SLOTS) if float(pres[b, i]) > 0)
                    pa += 1.0 if pred_on == set(best[1]) else 0.0
                    n += 1
            res[mode] = (cs / n, pa / n)
        sigs_all, pres_all = model(id_t.to(DEV))
        pick = pres_all.argmax(dim=1)
        S = sigs_all[torch.arange(len(id_lab)), pick].cpu().numpy()
        same, diff = [], []
        for a in range(len(id_lab)):
            for b in range(a + 1, len(id_lab)):
                c = float((S[a] * S[b]).sum())
                (same if id_lab[a] == id_lab[b] else diff).append(c)
        same, diff = np.array(same), np.array(diff)
        best = 1.0
        for t in np.unique(np.concatenate([same, diff])):
            far = float((diff >= t).mean())
            frr = float((same < t).mean())
            best = min(best, max(far, frr))
        res["ideer"] = best
        _, pres_e = model(emp_t.to(DEV))
        res["phantom"] = float((pres_e > 0).any(dim=1).float().mean())
        _, pres_r = model(res_t.to(DEV))
        res["resphantom"] = float((pres_r > 0).any(dim=1).float().mean())
        _, pres_o = model(ons_t.to(DEV))
        res["onset"] = float((pres_o > 0).any(dim=1).float().mean())
    r = r_old
    nprng.set_state(sv)
    model.train()
    return res

run_l, run_c, t0 = 0.0, 0.0, time.time()
for step in range(step0 + 1, step0 + STEPS + 1):
    m, ts, ns, mm, who = make_batch(train_spk, train_dirs, BATCH)
    with torch.no_grad():
        _md = m.to(DEV)
        rows = mm.to(DEV)
        _md = route_rows(_md, rows)
        m = _md.cpu()
    sigs, pres = model(m.to(DEV))
    loss, chit = pit_loss(sigs, pres, ts, ns, who)
    opt.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    opt.step()
    run_l += float(loss.detach())
    run_c += chit
    time.sleep(SLEEP)
    while os.path.exists(PAUSE_FILE):
        time.sleep(5)
    if step % 100 == 0:
        log(f"step {step} loss {run_l/100:.3f} negcos {run_c/100:.3f} ({(time.time()-t0)/100*1000:.0f}ms/step)")
        run_l, run_c, t0 = 0.0, 0.0, time.time()
    if step % 500 == 0:
        res = evaluate()
        torch.save({"state_dict": model.state_dict(), "step": step},
                   f"{ROOT}/ckpt2r/viper2r_step{step}.pt")
        log(f"ckpt step {step} musicV5 COS {res['musicv5'][0]:.3f} pres {res['musicv5'][1]:.2f} | rawQuiet COS {res['rawquiet'][0]:.3f} pres {res['rawquiet'][1]:.2f} | idEER {res['ideer']:.3f} | phantom {res['phantom']:.2f} | resphantom {res['resphantom']:.2f} | onset {res['onset']:.2f}")
log("DONE")
