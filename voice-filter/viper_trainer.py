import glob, math, os, random, sys, time
import numpy as np, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spk_model import MelFront, SEBlock, Res, AAMHead, N_MELS
import torch.nn as nn

SEG = 32000
CKDIR = os.path.expanduser("~/Desktop/train_voicefilter/checkpoints_recovered")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "viper_log.txt")
def log(m):
    with open(LOG, "a") as f: f.write(f"{time.strftime('%H:%M:%S')} {m}\n")
def rd(p):
    from scipy.io import wavfile
    sr, x = wavfile.read(p)
    return x.astype(np.float32)/32768.0

class Viper(nn.Module):
    def __init__(s, ch=320, emb=192, nblocks=4):
        super().__init__()
        s.front = MelFront()
        s.inp = nn.Sequential(nn.Conv1d(N_MELS, ch, 5, padding=2), nn.BatchNorm1d(ch), nn.ReLU())
        s.blocks = nn.ModuleList([Res(ch, d) for d in (1, 2, 3, 4)[:nblocks]])
        s.cat = nn.Sequential(nn.Conv1d(ch*nblocks, ch, 1), nn.ReLU())
        s.attn = nn.Sequential(nn.Conv1d(ch, 96, 1), nn.Tanh(), nn.Conv1d(96, ch, 1))
        s.emb = nn.Linear(ch*2, emb)
        s.ovl = nn.Linear(ch*2, 1)
    def forward(s, wav):
        x = s.inp(s.front(wav))
        outs = []
        for b in s.blocks:
            x = b(x); outs.append(x)
        x = s.cat(torch.cat(outs, dim=1))
        w = torch.softmax(s.attn(x), dim=2)
        mu = (x*w).sum(dim=2)
        sg = torch.sqrt(((x-mu.unsqueeze(2))**2 * w).sum(dim=2).clamp_min(1e-6))
        stats = torch.cat([mu, sg], dim=1)
        return nn.functional.normalize(s.emb(stats), dim=1), s.ovl(stats).squeeze(1)

def main():
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    idx = {}
    for d in sorted(glob.glob("cache_spk/*")):
        spk = os.path.basename(d)
        fs = sorted(f for f in glob.glob(d + "/*.wav") if "_v2" not in f)
        if len(fs) >= 6: idx[spk] = fs
    train_spk = sorted(k for k in idx if not k.startswith("test_"))
    test_spk = sorted(k for k in idx if k.startswith("test_"))
    log(f"VIPER START dev={dev} train={len(train_spk)} heldout={len(test_spk)} total_files={sum(len(v) for v in idx.values())}")
    model = Viper().to(dev)
    head = AAMHead(192, len(train_spk), m=0.1).to(dev)
    nparams = sum(p.numel() for p in model.parameters())
    log(f"viper params {nparams/1e6:.2f}M emb 192")
    opt = torch.optim.Adam(list(model.parameters())+list(head.parameters()), lr=1e-3, weight_decay=1e-5)
    loops = sorted(glob.glob("../v2_finetune/cache_16k/music/*.wav"))
    rng = random.Random(29); nprng = np.random.RandomState(29)
    mcache = {}
    def mseg():
        p = loops[rng.randrange(len(loops))]
        if p not in mcache:
            if len(mcache) > 500: mcache.clear()
            mcache[p] = rd(p)
        x = mcache[p]
        if len(x) <= SEG: return np.pad(x, (0, SEG-len(x)))
        o = rng.randrange(0, len(x)-SEG)
        return x[o:o+SEG]
    def seg_of(path):
        x = rd(path)
        if len(x) <= SEG: return np.pad(x, (0, SEG-len(x)))
        o = rng.randrange(0, len(x)-SEG)
        return x[o:o+SEG]
    def reverb(x):
        rir_len = rng.randrange(800, 4000)
        rir = nprng.normal(0, 1, rir_len).astype(np.float32) * np.exp(-np.arange(rir_len)/rng.uniform(300, 1200))
        rir[0] = 1.0
        from scipy.signal import fftconvolve
        y = fftconvolve(x, rir)[:len(x)]
        return y / (np.abs(y).max()+1e-9) * (np.abs(x).max()+1e-9)
    def rr(x): return float(np.sqrt((x**2).mean())+1e-9)
    duet_v2 = sorted(glob.glob("duet_v2/*.wav"))
    def pick_view(spk):
        f = idx[spk][rng.randrange(len(idx[spk]))]
        if rng.random() < 0.6:
            v2f = f.replace(".wav", "_v2.wav")
            if os.path.exists(v2f): return v2f, True
        return f, False
    def batch(B=40):
        xs, ys, ov = [], [], []
        chosen = rng.sample(range(len(train_spk)), B//2)
        pairs = chosen + chosen
        for si in pairs:
            spk = train_spk[si]
            overlapped = rng.random() < 0.30
            if overlapped and duet_v2 and rng.random() < 0.5:
                x = seg_of(duet_v2[rng.randrange(len(duet_v2))])
                x = x / rr(x) * (10**(rng.uniform(-30,-18)/20))
            else:
                f, isv2 = pick_view(spk)
                x = seg_of(f)
                x = x / rr(x) * (10**(rng.uniform(-32,-18)/20))
                if overlapped:
                    sj = rng.randrange(len(train_spk))
                    while sj == si: sj = rng.randrange(len(train_spk))
                    f2, _ = pick_view(train_spk[sj])
                    x2 = seg_of(f2)
                    x2 = x2 / rr(x2) * rr(x) * (10**(rng.uniform(-6, 6)/20))
                    x = x + x2
                if not isv2:
                    r = rng.random()
                    if r < 0.30:
                        m = mseg(); m = m / rr(m) * (10**(rng.uniform(-36,-12)/20)); x = x + m
                    elif r < 0.40:
                        x = x + nprng.normal(0, 10**(rng.uniform(-40,-26)/20), SEG).astype(np.float32)
                    elif r < 0.55:
                        x = reverb(x)
            pk = np.abs(x).max()
            if pk > 0.98: x = x/pk*0.9
            xs.append(x); ys.append(-1 if overlapped else si); ov.append(1.0 if overlapped else 0.0)
        return (torch.from_numpy(np.stack(xs).astype(np.float32)), torch.tensor(ys),
                torch.tensor(ov, dtype=torch.float32))
    def eer(augment=False):
        model.eval()
        embs = {}
        with torch.no_grad():
            for spk in test_spk:
                es = []
                for f in idx[spk][:10]:
                    x = seg_of(f); x = x / rr(x) * 0.05
                    if augment:
                        m = mseg(); x = x + m / rr(m) * 0.05
                        pk = np.abs(x).max()
                        if pk > 0.98: x = x/pk*0.9
                    es.append(model(torch.from_numpy(x[None].astype(np.float32)).to(dev))[0].cpu().numpy()[0])
                embs[spk] = es
        pos, neg = [], []
        ks = list(embs)
        for k in ks:
            es = embs[k]
            for i in range(len(es)):
                for j in range(i+1, len(es)): pos.append(float(np.dot(es[i], es[j])))
            for k2 in ks:
                if k2 <= k: continue
                for a in embs[k][:5]:
                    for b in embs[k2][:5]: neg.append(float(np.dot(a, b)))
        best, e = 1.0, 1.0
        for t in sorted(set(pos+neg))[::max(1,len(set(pos+neg))//200)]:
            fa = sum(1 for n in neg if n >= t)/len(neg)
            fr = sum(1 for p_ in pos if p_ < t)/len(pos)
            if abs(fa-fr) < best: best, e = abs(fa-fr), (fa+fr)/2
        model.train()
        return e
    WARM = 2000; TOTAL = 400000
    step = 0; run = 0.0; last_ck = time.time(); best_eer = 1.0
    while step < TOTAL:
        lr = 1e-3 * min(1.0, (step+1)/WARM) * (0.5*(1+math.cos(math.pi*min(step,TOTAL)/TOTAL)))
        for g in opt.param_groups: g["lr"] = max(lr, 2e-5)
        head.m = 0.1 + 0.2*min(1.0, step/60000)
        x, y, ov = batch()
        x, y, ov = x.to(dev), y.to(dev), ov.to(dev)
        emb, ovlog = model(x)
        pure = y >= 0
        loss = head(emb[pure], y[pure]) + 2.0 * nn.functional.binary_cross_entropy_with_logits(ovlog, ov)
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(list(model.parameters())+list(head.parameters()), 5.0)
        opt.step()
        run += float(loss); step += 1
        if step % 200 == 0:
            log(f"step {step} loss {run/200:.3f} lr {opt.param_groups[0]['lr']:.1e} m {head.m:.2f}")
            run = 0.0
        if time.time()-last_ck > 900:
            model.eval()
            hits = 0; tot = 0
            with torch.no_grad():
                for _ in range(60):
                    two = rng.random() < 0.5
                    sa = test_spk[rng.randrange(len(test_spk))]
                    xa = seg_of(idx[sa][rng.randrange(len(idx[sa]))])
                    xa = xa / rr(xa) * 0.05
                    if two:
                        sb = sa
                        while sb == sa: sb = test_spk[rng.randrange(len(test_spk))]
                        xb = seg_of(idx[sb][rng.randrange(len(idx[sb]))])
                        xa = xa + xb / rr(xb) * 0.05
                    _, ol = model(torch.from_numpy(xa[None].astype(np.float32)).to(dev))
                    said2 = float(ol) > 0
                    hits += int(said2 == two); tot += 1
            model.train()
            ovl_acc = hits / tot
            e_c = eer(False); e_a = eer(True)
            torch.save({"state_dict": model.state_dict(), "step": step, "eer": e_c, "eer_aug": e_a},
                       f"{CKDIR}/viper_step{step}.pt")
            log(f"checkpoint viper_step{step}.pt EER {e_c*100:.1f}% EERaug {e_a*100:.1f}% OVL {ovl_acc*100:.0f}%")
            if e_c < best_eer:
                best_eer = e_c
                torch.save({"state_dict": model.state_dict(), "step": step, "eer": e_c}, f"{CKDIR}/viper_best.pt")
            last_ck = time.time()
if __name__ == "__main__":
    main()
