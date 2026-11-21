"""แปลงไฟล์โมเดล Real-ESRGAN (realesr-general-x4v3.pth) เป็น ONNX สำหรับใช้ในเบราว์เซอร์

ใช้ครั้งเดียวตอนเตรียมโมเดล ไม่ได้ถูกเรียกตอนใช้งานเว็บแอป
วิธีใช้:  python convert_model.py <input.pth> <output.onnx>
ต้องการ: numpy, onnx  (ไม่ต้องใช้ PyTorch — อ่านไฟล์ .pth เองโดยตรง)

โครงสร้างโมเดล (SRVGGNetCompact): conv 3->64, PReLU, [conv 64->64, PReLU] x32,
conv 64->48, pixel-shuffle x4, แล้วบวกกับภาพต้นฉบับที่ขยายแบบ nearest x4
ที่มาโมเดล: https://github.com/xinntao/Real-ESRGAN (BSD-3-Clause)
"""
import pickle
import sys
import zipfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "LongStorage": np.int64}


class _Storage:
    def __init__(self, name):
        self.name = name


def load_state_dict(path):
    zf = zipfile.ZipFile(path)
    pkl = next(n for n in zf.namelist() if n.endswith("data.pkl"))
    root = pkl[: -len("data.pkl")]

    def rebuild(storage, offset, size, stride, *_):
        n = int(np.prod(size)) if size else 1
        return storage[offset : offset + n].reshape(size).copy()

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if module == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild
            if module == "torch" and name in DTYPES:
                return _Storage(name)
            if module == "collections" and name == "OrderedDict":
                import collections
                return collections.OrderedDict
            raise pickle.UnpicklingError(f"ไม่อนุญาต: {module}.{name}")

        def persistent_load(self, pid):
            _, storage_type, key, _, _ = pid
            raw = zf.read(f"{root}data/{key}")
            return np.frombuffer(raw, dtype=DTYPES[storage_type.name])

    obj = Unpickler(zf.open(pkl)).load()
    for k in ("params_ema", "params"):
        if k in obj:
            return obj[k]
    return obj


def build(sd, scale=4):
    conv_ids = sorted({int(k.split(".")[1]) for k in sd if sd[k].ndim == 4})
    nodes, inits = [], []
    cur = "input"
    for i in conv_ids:
        w, b = sd[f"body.{i}.weight"], sd[f"body.{i}.bias"]
        inits += [numpy_helper.from_array(w, f"w{i}"), numpy_helper.from_array(b, f"b{i}")]
        nodes.append(helper.make_node("Conv", [cur, f"w{i}", f"b{i}"], [f"c{i}"],
                                      kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        cur = f"c{i}"
        key = f"body.{i + 1}.weight"
        if key in sd:  # PReLU ต่อท้าย conv
            inits.append(numpy_helper.from_array(sd[key].reshape(-1, 1, 1), f"a{i}"))
            nodes.append(helper.make_node("PRelu", [cur, f"a{i}"], [f"p{i}"]))
            cur = f"p{i}"
    assert sd[f"body.{conv_ids[-1]}.weight"].shape[0] == 3 * scale * scale
    nodes.append(helper.make_node("DepthToSpace", [cur], ["shuffled"], blocksize=scale, mode="CRD"))
    inits.append(numpy_helper.from_array(np.array([1, 1, scale, scale], np.float32), "scales"))
    nodes.append(helper.make_node("Resize", ["input", "", "scales"], ["base"], mode="nearest",
                                  coordinate_transformation_mode="asymmetric", nearest_mode="floor"))
    nodes.append(helper.make_node("Add", ["shuffled", "base"], ["output"]))
    graph = helper.make_graph(
        nodes, "realesr-general-x4v3",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "h", "w"])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, "H", "W"])],
        inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    sd = load_state_dict(src)
    onnx.save(build(sd), dst)
    print("บันทึกแล้ว:", dst, "| จำนวนชั้น conv:", sum(1 for k in sd if sd[k].ndim == 4))
