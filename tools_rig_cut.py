#!/usr/bin/env python3
"""把 A-pose 足球女孩立绘切成 6 个骨骼部件(全画布对齐),用于 2.5D 纸偶骨骼动画。
各部件保留在原画布坐标系,矩形间留重叠避免接缝;前端叠放并绕关节旋转。"""
import numpy as np
from PIL import Image

SRC = "renderer/models/rig_base.png"
OUT = "renderer/models/rig"

# 部件矩形 (x0, y0, x1, y1),按 1536x1024 画布。相邻留重叠。
PARTS = {
    "leg_l": (510, 580, 762, 1024),
    "leg_r": (758, 580, 1014, 1024),
    "arm_l": (505, 218, 676, 620),
    "arm_r": (854, 218, 1018, 620),
    "torso": (624, 196, 892, 690),
    "head":  (596, 0, 922, 240),
}
# 绘制顺序(后画的在上层):腿→躯干→手臂→头
ORDER = ["leg_l", "leg_r", "torso", "arm_l", "arm_r", "head"]


def soft_rect_mask(shape, box, feather=10):
    h, w = shape
    m = np.zeros((h, w), np.float32)
    x0, y0, x1, y1 = box
    m[y0:y1, x0:x1] = 1.0
    # 简单羽化:对边界做线性过渡
    for f in range(1, feather + 1):
        a = f / (feather + 1)
        if y0 - f >= 0: m[y0 - f, x0:x1] = np.maximum(m[y0 - f, x0:x1], 1 - a)
        if y1 + f <= h: m[min(y1 + f, h - 1), x0:x1] = np.maximum(m[min(y1 + f, h - 1), x0:x1], 1 - a)
        if x0 - f >= 0: m[y0:y1, x0 - f] = np.maximum(m[y0:y1, x0 - f], 1 - a)
        if x1 + f <= w: m[y0:y1, min(x1 + f, w - 1)] = np.maximum(m[y0:y1, min(x1 + f, w - 1)], 1 - a)
    return m


def main():
    im = Image.open(SRC).convert("RGBA")
    arr = np.array(im).astype(np.float32)
    h, w = arr.shape[:2]
    for name, box in PARTS.items():
        m = soft_rect_mask((h, w), box, feather=8)
        out = arr.copy()
        out[:, :, 3] = out[:, :, 3] * m
        Image.fromarray(out.astype(np.uint8), "RGBA").save(f"{OUT}_{name}.png")
        print(f"{OUT}_{name}.png  box={box}")
    print("order:", ORDER)


if __name__ == "__main__":
    main()
