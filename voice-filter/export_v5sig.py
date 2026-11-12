import os, sys, numpy as np, torch, torch.nn.functional as F
H = os.path.expanduser
sys.path.insert(0, H("~/Desktop/venomx"))
import venomx_model
def static_safe_ln(x, w, b):
    return F.layer_norm(x / 128.0, (w.shape[-1],), w, b, eps=1e-5 / (128.0 * 128.0))
venomx_model.safe_ln = static_safe_ln
from v4sig_model import V4Sig
CK = H("~/Desktop/venomx/ckpt_vx3c/vx4s_step186009.pt")
OUT = sys.argv[1]
m = V4Sig()
obj = torch.load(CK, map_location="cpu", weights_only=False)
m.load_state_dict(obj["state_dict"])
m.eval()
print("ckpt step", obj.get("step"), "stft_cos abs sum %.3f" % float(m.stft_cos.abs().sum()), "sig_proj abs sum %.3f" % float(m.sig_proj.weight.abs().sum()))
ex = (torch.zeros(1, 23040), torch.zeros(1, 576))
torch.onnx.export(m, ex, OUT, opset_version=17, input_names=["audio", "sig"], output_names=["voices"], dynamo=False)
print("onnx", os.path.getsize(OUT), "bytes")
import onnxruntime as ort
sess = ort.InferenceSession(OUT, providers=["CPUExecutionProvider"])
print("inputs", [(i.name, i.shape) for i in sess.get_inputs()], "outputs", [(o.name, o.shape) for o in sess.get_outputs()])
rng = np.random.RandomState(11)
worst = 0.0
tests = []
for i in range(5):
    a = (rng.randn(1, 23040) * 0.05).astype(np.float32)
    z = np.zeros((1, 576), np.float32)
    with torch.no_grad():
        ref = m(torch.from_numpy(a), torch.from_numpy(z)).numpy()
    got = sess.run(None, {"audio": a, "sig": z})[0]
    rel = float(np.sqrt(((got - ref) ** 2).mean()) / (np.sqrt((ref ** 2).mean()) + 1e-9))
    worst = max(worst, rel)
    tests.append((a, z, got))
print("onnx vs torch worst rel err %.6f" % worst)
import coremltools as ct
ml = ct.models.MLModel(H("~/Desktop/Nayerly/Nayerly/V5Filter.mlpackage"), compute_units=ct.ComputeUnit.CPU_ONLY)
worst_ml = 0.0
for a, z, got in tests:
    out = ml.predict({"audio": a, "sig": z})["voices"].reshape(-1).astype(np.float32)
    g = got.reshape(-1)
    rel = float(np.sqrt(((g - out) ** 2).mean()) / (np.sqrt((out ** 2).mean()) + 1e-9))
    worst_ml = max(worst_ml, rel)
print("onnx vs iOS coreml worst rel err %.6f" % worst_ml)
