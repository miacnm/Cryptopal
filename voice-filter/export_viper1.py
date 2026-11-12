import os, sys, numpy as np, torch
BRAINS = os.path.dirname(os.path.abspath(__file__))
VIPER1_CODE = os.path.expanduser("~/Desktop/train_voicefilter/spk_saved")
VIPER1_CKPT = os.path.expanduser("~/Desktop/train_voicefilter/checkpoints_recovered/viper_step103446.pt")
SEG = 32000

sys.path.insert(0, VIPER1_CODE)
from viper_trainer import Viper

class Viper1Shipped(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net
    def forward(self, wav):
        emb, ovl = self.net(wav)
        return emb, torch.sigmoid(ovl)

base = Viper()
sd = torch.load(VIPER1_CKPT, map_location="cpu", weights_only=False)
base.load_state_dict(sd.get("state_dict", sd))
base.eval()
m = Viper1Shipped(base).eval()
print("viper1 loaded step", sd.get("step"), "params %.2fM" % (sum(p.numel() for p in m.parameters())/1e6))

out = os.path.join(BRAINS, "viper1.onnx")
torch.onnx.export(m, torch.zeros(1, SEG), out,
                  input_names=["audio"], output_names=["embedding", "overlap"],
                  opset_version=17, dynamo=False)

import onnxruntime as ort
s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
rng = np.random.RandomState(11)
worst = 0.0
for trial in range(5):
    x = (rng.randn(1, SEG).astype(np.float32)) * 0.05
    with torch.no_grad():
        te, to = m(torch.from_numpy(x))
    oe, oo = s.run(None, {"audio": x})
    for nm, t, o in (("embedding", te.numpy(), oe), ("overlap", to.numpy(), oo)):
        rel = np.abs(t - o).max() / max(1e-9, np.abs(t).max())
        worst = max(worst, rel)
        print("  trial %d %-9s rel err %.3g" % (trial, nm, rel))
print("worst rel err %.3g" % worst)
print("bytes", os.path.getsize(out))
