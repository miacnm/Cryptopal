import numpy as np, torch, torch.nn as nn

N_MELS = 64

class MelFront(nn.Module):
    def __init__(s, sr=16000, nfft=512, hop=160):
        super().__init__()
        k = np.arange(nfft//2+1)[:, None]
        t = np.arange(nfft)[None, :]
        win = np.hanning(nfft)
        s.register_buffer("cosk", torch.from_numpy((np.cos(2*np.pi*k*t/nfft)*win).astype(np.float32)).unsqueeze(1))
        s.register_buffer("sink", torch.from_numpy((np.sin(2*np.pi*k*t/nfft)*win).astype(np.float32)).unsqueeze(1))
        def mel(f): return 2595*np.log10(1+f/700)
        def imel(m): return 700*(10**(m/2595)-1)
        edges = imel(np.linspace(mel(50), mel(7600), N_MELS+2))
        freqs = np.fft.rfftfreq(nfft, 1/sr)
        fb = np.zeros((N_MELS, nfft//2+1), np.float32)
        for i in range(N_MELS):
            lo, mid, hi = edges[i], edges[i+1], edges[i+2]
            up = (freqs >= lo) & (freqs <= mid)
            dn = (freqs > mid) & (freqs <= hi)
            if mid > lo: fb[i, up] = (freqs[up]-lo)/(mid-lo)
            if hi > mid: fb[i, dn] = (hi-freqs[dn])/(hi-mid)
        s.register_buffer("fbank", torch.from_numpy(fb))
        s.hop = hop
    def forward(s, x):
        x = x.unsqueeze(1)
        re = nn.functional.conv1d(x, s.cosk, stride=s.hop)
        im = nn.functional.conv1d(x, s.sink, stride=s.hop)
        p = re*re + im*im
        m = torch.matmul(s.fbank, p)
        m = torch.log(m + 1e-6)
        return m - m.mean(dim=2, keepdim=True)

class SEBlock(nn.Module):
    def __init__(s, ch):
        super().__init__()
        s.fc1 = nn.Conv1d(ch, ch//8, 1); s.fc2 = nn.Conv1d(ch//8, ch, 1)
    def forward(s, x):
        w = torch.sigmoid(s.fc2(torch.relu(s.fc1(x.mean(dim=2, keepdim=True)))))
        return x * w

class Res(nn.Module):
    def __init__(s, ch, d):
        super().__init__()
        s.c1 = nn.Conv1d(ch, ch, 3, padding=d, dilation=d)
        s.b1 = nn.BatchNorm1d(ch)
        s.c2 = nn.Conv1d(ch, ch, 1)
        s.b2 = nn.BatchNorm1d(ch)
        s.se = SEBlock(ch)
    def forward(s, x):
        y = torch.relu(s.b1(s.c1(x)))
        y = torch.relu(s.b2(s.c2(y)))
        return x + s.se(y)

class SpkEncoder(nn.Module):
    def __init__(s, ch=192, emb=128):
        super().__init__()
        s.front = MelFront()
        s.inp = nn.Sequential(nn.Conv1d(N_MELS, ch, 5, padding=2), nn.BatchNorm1d(ch), nn.ReLU())
        s.blocks = nn.ModuleList([Res(ch, d) for d in (1, 2, 3)])
        s.cat = nn.Sequential(nn.Conv1d(ch*3, ch, 1), nn.ReLU())
        s.attn = nn.Sequential(nn.Conv1d(ch, 64, 1), nn.Tanh(), nn.Conv1d(64, ch, 1))
        s.emb = nn.Linear(ch*2, emb)
    def forward(s, wav):
        x = s.inp(s.front(wav))
        outs = []
        for b in s.blocks:
            x = b(x); outs.append(x)
        x = s.cat(torch.cat(outs, dim=1))
        w = torch.softmax(s.attn(x), dim=2)
        mu = (x*w).sum(dim=2)
        sg = torch.sqrt(((x-mu.unsqueeze(2))**2 * w).sum(dim=2).clamp_min(1e-6))
        e = s.emb(torch.cat([mu, sg], dim=1))
        return nn.functional.normalize(e, dim=1)

class AAMHead(nn.Module):
    def __init__(s, emb, nspk, m=0.2, scale=30.0):
        super().__init__()
        s.w = nn.Parameter(torch.randn(nspk, emb)*0.02)
        s.m, s.scale = m, scale
    def forward(s, e, labels):
        w = nn.functional.normalize(s.w, dim=1)
        cos = e @ w.t()
        th = torch.acos(cos.clamp(-0.999, 0.999))
        tgt = torch.cos(th + s.m)
        onehot = torch.zeros_like(cos).scatter_(1, labels.unsqueeze(1), 1.0)
        logits = s.scale * (onehot*tgt + (1-onehot)*cos)
        return nn.functional.cross_entropy(logits, labels)
