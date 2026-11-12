import os, sys, torch, torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.expanduser("~/Desktop/train_voicefilter/spk_saved"))
from spk_model import MelFront, Res, N_MELS

K_SLOTS = 3
SEG2 = 32000

class Viper2(nn.Module):
    def __init__(s, ch=320, emb=192, nblocks=4):
        super().__init__()
        s.front = MelFront()
        s.inp = nn.Sequential(nn.Conv1d(N_MELS, ch, 5, padding=2), nn.BatchNorm1d(ch), nn.ReLU())
        s.blocks = nn.ModuleList([Res(ch, d) for d in (1, 2, 3, 4)[:nblocks]])
        s.cat = nn.Sequential(nn.Conv1d(ch * nblocks, ch, 1), nn.ReLU())
        s.slot_attn = nn.ModuleList([
            nn.Sequential(nn.Conv1d(ch, 96, 1), nn.Tanh(), nn.Conv1d(96, ch, 1))
            for _ in range(K_SLOTS)])
        s.emb = nn.Linear(ch * 2, emb)
        s.pres = nn.Linear(ch * 2, 1)

    def forward(s, wav):
        x = s.inp(s.front(wav))
        outs = []
        for b in s.blocks:
            x = b(x)
            outs.append(x)
        x = s.cat(torch.cat(outs, dim=1))
        sigs, pres = [], []
        for k in range(K_SLOTS):
            w = torch.softmax(s.slot_attn[k](x), dim=2)
            mu = (x * w).sum(dim=2)
            sg = torch.sqrt(((x - mu.unsqueeze(2)) ** 2 * w).sum(dim=2).clamp_min(1e-6))
            stats = torch.cat([mu, sg], dim=1)
            sigs.append(F.normalize(s.emb(stats), dim=1))
            pres.append(s.pres(stats).squeeze(1))
        return torch.stack(sigs, dim=1), torch.stack(pres, dim=1)

def load_from_champion(ck_path):
    m = Viper2()
    sd = torch.load(ck_path, map_location="cpu", weights_only=False)["state_dict"]
    own = m.state_dict()
    loaded = 0
    for k, v in sd.items():
        if k in own and own[k].shape == v.shape:
            own[k] = v
            loaded += 1
    for k in range(K_SLOTS):
        for name, v in sd.items():
            if name.startswith("attn."):
                tgt = f"slot_attn.{k}." + name[len("attn."):]
                if tgt in own and own[tgt].shape == v.shape:
                    own[tgt] = v + torch.randn_like(v) * 0.02
                    loaded += 1
    m.load_state_dict(own)
    return m, loaded
