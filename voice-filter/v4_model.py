import numpy as np, torch, torch.nn as nn
import torch.nn.functional as F
from venomx_model import Block, SEG

class V4(nn.Module):
    def __init__(s, dim=256, heads=4, ff=512, blocks=6):
        super().__init__()
        s.register_buffer("stft_cos", torch.zeros(257, 1, 512))
        s.register_buffer("stft_sin", torch.zeros(257, 1, 512))
        s.register_buffer("istft_cos", torch.zeros(257, 1, 512))
        s.register_buffer("istft_sin", torch.zeros(257, 1, 512))
        s.enc1 = nn.Conv2d(2, 32, (5, 3), stride=(2, 1))
        s.enc2 = nn.Conv2d(32, 64, (5, 3), stride=(2, 1))
        s.enc3 = nn.Conv2d(64, 96, (3, 3), stride=(2, 1))
        s.in_proj = nn.Linear(96 * 33, dim)
        s.trunk = nn.ModuleList([Block(dim, heads, ff) for _ in range(blocks)])
        s.head = nn.Linear(dim, 514)

    def forward(s, audio):
        x = audio.unsqueeze(1)
        re = F.conv1d(x, s.stft_cos, stride=128)
        im = F.conv1d(x, s.stft_sin, stride=128)
        e = torch.stack([re, im], dim=1)
        e = F.relu(s.enc1(F.pad(e, (1, 1, 2, 2))))
        e = F.relu(s.enc2(F.pad(e, (1, 1, 2, 2))))
        e = F.relu(s.enc3(F.pad(e, (1, 1, 1, 1))))
        B, C, Fq, T = e.shape
        feat = s.in_proj(e.permute(0, 3, 1, 2).reshape(B, T, C * Fq))
        for blk in s.trunk:
            feat = blk(feat)
        o = s.head(feat).transpose(1, 2)
        mr = torch.tanh(o[:, :257]) * 1.2
        mi = torch.tanh(o[:, 257:]) * 1.2
        re2 = re * mr - im * mi
        im2 = re * mi + im * mr
        a = F.conv_transpose1d(re2, s.istft_cos, stride=128)
        b = F.conv_transpose1d(im2, s.istft_sin, stride=128)
        return (a - b).squeeze(1)

def init_from_venomx(bases, venomx_ckpt):
    m = V4()
    z = np.load(bases)
    with torch.no_grad():
        for k in ["stft_cos", "stft_sin", "istft_cos", "istft_sin"]:
            getattr(m, k).copy_(torch.from_numpy(z[k]))
    sd = torch.load(venomx_ckpt, map_location="cpu", weights_only=False)["state_dict"]
    own = m.state_dict()
    loaded = 0
    for k, v in sd.items():
        tgt = k
        if k.startswith("dec."):
            idx = int(k.split(".")[1])
            tgt = f"trunk.{idx + 4}." + ".".join(k.split(".")[2:])
        if tgt in own and own[tgt].shape == v.shape:
            own[tgt] = v
            loaded += 1
    m.load_state_dict(own)
    return m, loaded
