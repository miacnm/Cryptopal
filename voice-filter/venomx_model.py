import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

K_SLOTS = 3
SEG = 48000

def safe_ln(x, w, b):
    return F.layer_norm(x / 128.0, (x.shape[-1],), w, b, eps=1e-5 / (128.0 * 128.0))

class Attn(nn.Module):
    def __init__(s, d, heads):
        super().__init__()
        s.h = heads
        s.dh = d // heads
        s.qkv = nn.Linear(d, 3 * d)
        s.proj = nn.Linear(d, d)

    def forward(s, x):
        B, T, D = x.shape
        q, k, v = s.qkv(x).chunk(3, -1)
        q = q.view(B, T, s.h, s.dh).transpose(1, 2) / (s.dh ** 0.5)
        k = k.view(B, T, s.h, s.dh).transpose(1, 2)
        k = k - k.mean(dim=2, keepdim=True)
        v = v.view(B, T, s.h, s.dh).transpose(1, 2)
        a = torch.softmax(q @ k.transpose(-1, -2), dim=-1)
        o = (a @ v).transpose(1, 2).reshape(B, T, D)
        return s.proj(o)

class Block(nn.Module):
    def __init__(s, d, heads, ff):
        super().__init__()
        s.n1w = nn.Parameter(torch.ones(d)); s.n1b = nn.Parameter(torch.zeros(d))
        s.n2w = nn.Parameter(torch.ones(d)); s.n2b = nn.Parameter(torch.zeros(d))
        s.attn = Attn(d, heads)
        s.ff1 = nn.Linear(d, ff)
        s.ff2 = nn.Linear(ff, d)

    def forward(s, x):
        x = x + s.attn(safe_ln(x, s.n1w, s.n1b))
        x = x + s.ff2(F.relu(s.ff1(safe_ln(x, s.n2w, s.n2b))))
        return x

class VenomX(nn.Module):
    def __init__(s, dim=256, heads=4, ff=512, trunk=4, dec=2):
        super().__init__()
        s.register_buffer("stft_cos", torch.zeros(257, 1, 512))
        s.register_buffer("stft_sin", torch.zeros(257, 1, 512))
        s.register_buffer("istft_cos", torch.zeros(257, 1, 512))
        s.register_buffer("istft_sin", torch.zeros(257, 1, 512))
        s.enc1 = nn.Conv2d(2, 32, (5, 3), stride=(2, 1))
        s.enc2 = nn.Conv2d(32, 64, (5, 3), stride=(2, 1))
        s.enc3 = nn.Conv2d(64, 96, (3, 3), stride=(2, 1))
        s.in_proj = nn.Linear(96 * 33, dim)
        s.trunk = nn.ModuleList([Block(dim, heads, ff) for _ in range(trunk)])
        s.film = nn.Linear(192, 2 * dim)
        nn.init.zeros_(s.film.weight)
        nn.init.zeros_(s.film.bias)
        s.dec = nn.ModuleList([Block(dim, heads, ff) for _ in range(dec)])
        s.head = nn.Linear(dim, 514)

    def forward(s, audio, sigs):
        B = audio.shape[0]
        x = audio.unsqueeze(1)
        re = F.conv1d(x, s.stft_cos, stride=128)
        im = F.conv1d(x, s.stft_sin, stride=128)
        e = torch.stack([re, im], dim=1)
        e = F.relu(s.enc1(F.pad(e, (1, 1, 2, 2))))
        e = F.relu(s.enc2(F.pad(e, (1, 1, 2, 2))))
        e = F.relu(s.enc3(F.pad(e, (1, 1, 1, 1))))
        Bq, C, Fq, T = e.shape
        feat = s.in_proj(e.permute(0, 3, 1, 2).reshape(Bq, T, C * Fq))
        for blk in s.trunk:
            feat = blk(feat)
        gb = s.film(sigs)
        g, bta = gb.chunk(2, -1)
        z = feat.unsqueeze(1) * (1.0 + g.unsqueeze(2)) + bta.unsqueeze(2)
        z = z.reshape(B * K_SLOTS, T, -1)
        for blk in s.dec:
            z = blk(z)
        o = s.head(z).transpose(1, 2)
        mr = torch.tanh(o[:, :257]) * 1.2
        mi = torch.tanh(o[:, 257:]) * 1.2
        reK = re.repeat_interleave(K_SLOTS, dim=0)
        imK = im.repeat_interleave(K_SLOTS, dim=0)
        re2 = reK * mr - imK * mi
        im2 = reK * mi + imK * mr
        a = F.conv_transpose1d(re2, s.istft_cos, stride=128)
        b = F.conv_transpose1d(im2, s.istft_sin, stride=128)
        y = (a - b).squeeze(1)
        return y.view(B, K_SLOTS, -1)

def load_fresh(bases, **kw):
    m = VenomX(**kw)
    z = np.load(bases)
    with torch.no_grad():
        for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
            getattr(m, k).copy_(torch.from_numpy(z[k]))
    return m
